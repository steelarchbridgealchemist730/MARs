/**
 * E2E: Single Builder→Skeptic→Arbiter Cycle
 *
 * Gate: TRIPLE_ROLE_E2E=true
 * Cost: ~$1 (three Anthropic API calls + enrichment)
 *
 * Validates the complete triple-role cycle including prompt assembly,
 * LLM calls, output parsing, admission gate, and claim graph updates.
 *
 * Run:
 *   TRIPLE_ROLE_E2E=true bun test tests/e2e/13-triple-role-cycle.test.ts
 */
import { describe, test, expect, beforeAll } from 'bun:test'
import { chatCompletion } from '../../src/paper/llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../../src/paper/types'
import { ClaimGraph } from '../../src/paper/claim-graph/index'
import { EvidencePoolManager } from '../../src/paper/evidence-pool'
import { PromptAssembler } from '../../src/paper/claim-graph/prompt-assembler'
import { FocusSelector } from '../../src/paper/claim-graph/focus-selector'
import {
  initializeFromProposal,
  enrichStateWithLLM,
  computeBasicStability,
  type ResearchState,
} from '../../src/paper/research-state'
import type {
  BuilderOutput,
  SkepticOutput,
  ArbiterOutput,
} from '../../src/paper/claim-graph/triple-role-types'
import { canAdmit } from '../../src/paper/admission-gate'
import { ConvergenceDetector } from '../../src/paper/convergence'
import { parseTripleRoleOutput } from '../../src/paper/json-repair'

const ENABLED = process.env.TRIPLE_ROLE_E2E === 'true'

const testProposal = {
  id: 'e2e-triple-role',
  title: 'Diffusion-Based Time Series Forecasting with Temporal Attention',
  abstract:
    'We propose a conditional diffusion model for multivariate time series forecasting ' +
    'that leverages temporal cross-attention to capture long-range dependencies. ' +
    'Unlike autoregressive methods, our approach generates the full forecast horizon ' +
    'in a single denoising pass, achieving both speed and accuracy.',
  innovation: [
    'Conditional diffusion model for direct multi-step time series forecasting',
    'Temporal cross-attention mechanism within the denoising U-Net',
    'Calibrated uncertainty quantification via diffusion variance',
  ],
  methodology:
    'Train conditional DDPM on ETTh1/ETTm1 benchmarks with temporal cross-attention, ' +
    'compare against Informer, Autoformer, PatchTST baselines on MSE/MAE.',
  feasibility: {
    score: 0.8,
    data_required: 'ETTh1, ETTm1, Weather, Traffic (public datasets)',
    compute_estimate: '8 GPU-hours on A100',
    timeline_weeks: 8,
  },
  risk: {
    level: 'medium' as const,
    description:
      'Diffusion sampling may be too slow for real-time forecasting applications',
  },
  novelty_score: 0.7,
  impact_score: 0.65,
  references: ['Ho2020_DDPM', 'Zhou2021_Informer', 'Nie2023_PatchTST'],
  created_at: new Date().toISOString(),
}

let state: ResearchState
let graph: ClaimGraph
let pool: EvidencePoolManager
let assembler: PromptAssembler

let builderOutput: BuilderOutput
let skepticOutput: SkepticOutput
let arbiterOutput: ArbiterOutput

describe.skipIf(!ENABLED)('Triple-Role Cycle E2E (real API)', () => {
  beforeAll(async () => {
    state = initializeFromProposal(testProposal, {
      budget_usd: 100,
      paper_type: 'empirical',
    })

    const enriched = await enrichStateWithLLM(state)
    if (enriched.error) {
      console.warn(`[e2e] enrichStateWithLLM warning: ${enriched.error}`)
    }
    state = enriched.state

    graph = new ClaimGraph(state.claimGraph)
    pool = new EvidencePoolManager(state.evidencePool)
    assembler = new PromptAssembler(graph, pool, state)

    console.log(
      `[e2e] Init: ${graph.claimCount} claims, ${graph.edgeCount} edges`,
    )
  }, 60_000)

  test('Builder→Skeptic→Arbiter produces valid outputs', async () => {
    // ── Builder ──────────────────────────────────
    const builderPrompt = assembler.assembleBuilder()
    const builderResult = await chatCompletion({
      modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
      messages: [{ role: 'user', content: builderPrompt }],
      max_tokens: 8192,
      temperature: 0.4,
    })

    console.log(
      `[e2e] Builder: ${builderResult.input_tokens} in, ${builderResult.output_tokens} out, $${builderResult.cost_usd.toFixed(4)}`,
    )
    expect(builderResult.input_tokens).toBeLessThan(12_000)

    builderOutput = parseTripleRoleOutput<BuilderOutput>(
      builderResult.text,
      'builder',
    )
    expect(builderOutput.narrative).toBeTruthy()
    expect(builderOutput.new_claims_proposed.length).toBeGreaterThanOrEqual(1)

    // Add builder claims to graph for Skeptic
    for (const c of builderOutput.new_claims_proposed) {
      const id = graph.addClaim({
        type: (c.type as any) ?? 'hypothesis',
        epistemicLayer: (c.epistemicLayer as any) ?? 'explanation',
        statement: c.statement,
        phase: 'proposed',
        evidence: { grounded: [], derived: [] },
        strength: {
          confidence: c.confidence ?? 0.5,
          evidenceType: 'heuristic_motivation',
          vulnerabilityScore: 0.5,
        },
        created_by: 'builder',
      })
      c.id = id
    }

    state = {
      ...state,
      claimGraph: graph.toJSON(),
      stability: computeBasicStability(graph, pool),
    }
    assembler.update(graph, pool, state)

    // ── Skeptic ──────────────────────────────────
    const skepticPrompt = assembler.assembleSkeptic(builderOutput)
    const skepticResult = await chatCompletion({
      modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
      messages: [{ role: 'user', content: skepticPrompt }],
      max_tokens: 8192,
      temperature: 0.4,
    })

    console.log(
      `[e2e] Skeptic: ${skepticResult.input_tokens} in, ${skepticResult.output_tokens} out, $${skepticResult.cost_usd.toFixed(4)}`,
    )
    expect(skepticResult.input_tokens).toBeLessThan(12_000)

    skepticOutput = parseTripleRoleOutput<SkepticOutput>(
      skepticResult.text,
      'skeptic',
    )

    const hasSkepticContent =
      (skepticOutput.bridge_gaps?.length ?? 0) > 0 ||
      (skepticOutput.evidence_inflation?.length ?? 0) > 0 ||
      (skepticOutput.top3_collapse_points?.length ?? 0) > 0 ||
      (skepticOutput.admission_denials?.length ?? 0) > 0 ||
      (skepticOutput.internal_inconsistencies?.length ?? 0) > 0 ||
      (skepticOutput.theorem_overreach?.length ?? 0) > 0
    expect(hasSkepticContent).toBe(true)

    // ── Arbiter ──────────────────────────────────
    const arbiterPrompt = assembler.assembleArbiter(
      builderOutput,
      skepticOutput,
    )
    const arbiterResult = await chatCompletion({
      modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
      messages: [{ role: 'user', content: arbiterPrompt }],
      max_tokens: 8192,
      temperature: 0.3,
    })

    console.log(
      `[e2e] Arbiter: ${arbiterResult.input_tokens} in, ${arbiterResult.output_tokens} out, $${arbiterResult.cost_usd.toFixed(4)}`,
    )
    expect(arbiterResult.input_tokens).toBeLessThan(12_000)

    arbiterOutput = parseTripleRoleOutput<ArbiterOutput>(
      arbiterResult.text,
      'arbiter',
    )

    expect(Array.isArray(arbiterOutput.claim_updates)).toBe(true)
    expect(arbiterOutput.next_action).toBeDefined()
    expect(arbiterOutput.next_action.action).toBeTruthy()
    expect(arbiterOutput.next_action.delegate_to).toBeTruthy()
    expect(arbiterOutput.overall_assessment).toBeTruthy()

    // Total cost under $2
    const totalCost =
      builderResult.cost_usd + skepticResult.cost_usd + arbiterResult.cost_usd
    console.log(`[e2e] Total cycle cost: $${totalCost.toFixed(4)}`)
    expect(totalCost).toBeLessThan(2.0)
  }, 180_000)

  test('FocusSelector picks weakest claims', () => {
    // Create a graph with mixed confidence claims
    const testGraph = new ClaimGraph()
    const ids: string[] = []

    // High-confidence claims
    for (let i = 0; i < 5; i++) {
      ids.push(
        testGraph.addClaim({
          type: 'observation',
          epistemicLayer: 'observation',
          statement: `Strong claim ${i}`,
          phase: 'admitted',
          evidence: { grounded: ['g'], derived: ['d'] },
          strength: {
            confidence: 0.9,
            evidenceType: 'empirical_support',
            vulnerabilityScore: 0.1,
          },
          created_by: 'test',
        }),
      )
    }

    // Low-confidence, high-vulnerability claims
    const weakIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = testGraph.addClaim({
        type: 'hypothesis',
        epistemicLayer: 'explanation',
        statement: `Weak claim ${i}`,
        phase: 'proposed',
        evidence: { grounded: [], derived: [] },
        strength: {
          confidence: 0.2 + i * 0.05,
          evidenceType: 'heuristic_motivation',
          vulnerabilityScore: 0.8 - i * 0.05,
        },
        created_by: 'test',
      })
      ids.push(id)
      weakIds.push(id)
    }

    const selector = new FocusSelector()
    const builderFocus = selector.selectForBuilder(testGraph)

    // Builder should focus on proposed/under_investigation (the weak claims)
    // All weak claims are proposed, so they should be selected
    for (const weakId of weakIds) {
      expect(builderFocus).toContain(weakId)
    }

    // Strong claims are admitted, not in frontier
    // (unless they're neighbors of frontier claims via edges)
  }, 60_000)
})
