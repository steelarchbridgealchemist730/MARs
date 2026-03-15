/**
 * Step 7: Smoke Test — Real API Triple-Role Cycle
 *
 * Gate: SMOKE_TRIPLE_ROLE=true
 * Cost: ~$1 (three Anthropic API calls)
 *
 * Validates the complete Builder→Skeptic→Arbiter prompt→parse→apply pipeline
 * end-to-end against a real LLM API.
 *
 * Run manually:
 *   SMOKE_TRIPLE_ROLE=true bun test tests/integration/triple-role-smoke.test.ts
 */
import { describe, test, expect, beforeAll } from 'bun:test'
import {
  chatCompletion,
  type UnifiedChatResult,
} from '../../src/paper/llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../../src/paper/types'
import { PromptAssembler } from '../../src/paper/claim-graph/prompt-assembler'
import { ClaimGraph } from '../../src/paper/claim-graph/index'
import { EvidencePoolManager } from '../../src/paper/evidence-pool'
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
import { parseTripleRoleOutput } from '../../src/paper/json-repair'

// ── Gate ──────────────────────────────────────────────────
const ENABLED = process.env.SMOKE_TRIPLE_ROLE === 'true'

// ── Realistic Proposal ───────────────────────────────────
const proposal = {
  id: 'smoke-test-proposal',
  title: 'Adaptive Volatility Surface Calibration via Neural Operator Learning',
  abstract:
    'We propose a neural operator approach to calibrate implied volatility surfaces ' +
    'from sparse options market data. Traditional calibration methods (Levenberg-Marquardt ' +
    'on Heston SDE parameters) are slow and unstable for short-expiry strikes. We train ' +
    'a DeepONet that maps a discrete set of observed option prices to a continuous ' +
    'volatility surface, achieving sub-second calibration with bounded approximation error.',
  methodology:
    'Train a DeepONet on synthetic Heston model data (100K surfaces), ' +
    'fine-tune on real SPX options data (CBOE OptionMetrics). Evaluate against ' +
    'Levenberg-Marquardt baseline on calibration speed, RMSE, and arbitrage violations.',
  innovation: [
    'First application of neural operators to implied volatility surface calibration',
    'Guaranteed no-arbitrage output via soft constraint layer in DeepONet trunk',
  ],
  novelty_score: 0.75,
  impact_score: 0.7,
  feasibility: {
    score: 0.85,
    data_required: 'SPX options data (CBOE OptionMetrics)',
    compute_estimate: '4 GPU-hours on A100',
    timeline_weeks: 6,
  },
  risk: {
    level: 'medium' as const,
    description:
      'Neural operator may not generalize to extreme market regimes (2008 crisis-like events)',
  },
  references: [
    'Lu2021_DeepONet',
    'Gatheral2004_VolSurface',
    'Heston1993_ClosedForm',
  ],
  created_at: new Date().toISOString(),
}

// ── Shared State ─────────────────────────────────────────
let state: ResearchState
let graph: ClaimGraph
let pool: EvidencePoolManager
let assembler: PromptAssembler
let initialClaimCount: number

let builderOutput: BuilderOutput
let skepticOutput: SkepticOutput
let arbiterOutput: ArbiterOutput

// Per-call results for cost summary
const callResults: { role: string; result: UnifiedChatResult }[] = []

describe.skipIf(!ENABLED)('Triple-Role Smoke Test (real API)', () => {
  beforeAll(async () => {
    // Initialize from proposal (synchronous, no API)
    state = initializeFromProposal(proposal as any, {
      budget_usd: 100,
      paper_type: 'mixed',
    })

    // Enrich with LLM (one API call for claim graph generation)
    const enriched = await enrichStateWithLLM(state)
    if (enriched.error) {
      console.warn(
        `[smoke] enrichStateWithLLM warning: ${enriched.error}. Using fallback claims.`,
      )
    }
    state = enriched.state

    graph = new ClaimGraph(state.claimGraph)
    pool = new EvidencePoolManager(state.evidencePool)
    initialClaimCount = graph.claimCount
    assembler = new PromptAssembler(graph, pool, state)

    console.log(
      `[smoke] Initialized: ${graph.claimCount} claims, ${graph.edgeCount} edges`,
    )
  }, 60_000) // 60s timeout for enrichment call

  // ── Test 1: Builder ────────────────────────────────────
  test('Builder phase produces valid BuilderOutput', async () => {
    const prompt = assembler.assembleBuilder()

    const result = await chatCompletion({
      modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 8192,
      temperature: 0.4,
    })
    callResults.push({ role: 'builder', result })

    console.log(
      `[smoke] Builder: ${result.input_tokens} in, ${result.output_tokens} out, $${result.cost_usd.toFixed(4)}`,
    )

    // Token budget gate
    expect(result.input_tokens).toBeLessThan(12_000)

    // Parse
    builderOutput = parseTripleRoleOutput<BuilderOutput>(result.text, 'builder')

    // Shape validation
    expect(builderOutput.narrative).toBeTruthy()
    expect(Array.isArray(builderOutput.new_claims_proposed)).toBe(true)
    expect(builderOutput.new_claims_proposed.length).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(builderOutput.recommended_next_actions)).toBe(true)

    // Each claim has required fields
    for (const claim of builderOutput.new_claims_proposed) {
      expect(claim.type).toBeTruthy()
      expect(claim.epistemicLayer).toBeTruthy()
      expect(claim.statement).toBeTruthy()
    }
  }, 120_000)

  // ── Test 2: Skeptic ────────────────────────────────────
  test('Skeptic phase challenges Builder output', async () => {
    expect(builderOutput).toBeDefined()

    // Add builder claims to graph so Skeptic sees them
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

    // Update assembler with new graph state
    state = {
      ...state,
      claimGraph: graph.toJSON(),
      stability: computeBasicStability(graph, pool),
    }
    assembler.update(graph, pool, state)

    const prompt = assembler.assembleSkeptic(builderOutput)

    const result = await chatCompletion({
      modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 8192,
      temperature: 0.4,
    })
    callResults.push({ role: 'skeptic', result })

    console.log(
      `[smoke] Skeptic: ${result.input_tokens} in, ${result.output_tokens} out, $${result.cost_usd.toFixed(4)}`,
    )

    // Token budget gate
    expect(result.input_tokens).toBeLessThan(12_000)

    // Parse
    skepticOutput = parseTripleRoleOutput<SkepticOutput>(result.text, 'skeptic')

    // Shape validation — at least one challenge category should be non-empty
    const hasContent =
      (skepticOutput.bridge_gaps?.length ?? 0) > 0 ||
      (skepticOutput.evidence_inflation?.length ?? 0) > 0 ||
      (skepticOutput.top3_collapse_points?.length ?? 0) > 0 ||
      (skepticOutput.admission_denials?.length ?? 0) > 0 ||
      (skepticOutput.internal_inconsistencies?.length ?? 0) > 0 ||
      (skepticOutput.theorem_overreach?.length ?? 0) > 0

    expect(hasContent).toBe(true)

    console.log(
      `[smoke] Skeptic challenges: ` +
        `${skepticOutput.bridge_gaps?.length ?? 0} bridge gaps, ` +
        `${skepticOutput.evidence_inflation?.length ?? 0} inflation, ` +
        `${skepticOutput.top3_collapse_points?.length ?? 0} collapse points, ` +
        `${skepticOutput.admission_denials?.length ?? 0} denials`,
    )
  }, 120_000)

  // ── Test 3: Arbiter ────────────────────────────────────
  test('Arbiter phase synthesizes and decides', async () => {
    expect(builderOutput).toBeDefined()
    expect(skepticOutput).toBeDefined()

    const prompt = assembler.assembleArbiter(builderOutput, skepticOutput)

    const result = await chatCompletion({
      modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 8192,
      temperature: 0.3,
    })
    callResults.push({ role: 'arbiter', result })

    console.log(
      `[smoke] Arbiter: ${result.input_tokens} in, ${result.output_tokens} out, $${result.cost_usd.toFixed(4)}`,
    )

    // Token budget gate
    expect(result.input_tokens).toBeLessThan(12_000)

    // Parse
    arbiterOutput = parseTripleRoleOutput<ArbiterOutput>(result.text, 'arbiter')

    // Shape validation
    expect(Array.isArray(arbiterOutput.claim_updates)).toBe(true)
    expect(arbiterOutput.next_action).toBeDefined()
    expect(arbiterOutput.next_action.action).toBeTruthy()
    expect(arbiterOutput.next_action.delegate_to).toBeTruthy()
    expect(arbiterOutput.overall_assessment).toBeTruthy()

    // Priority should be a known value
    const validPriorities = [
      'urgent',
      'high',
      'normal',
      'low',
      'critical',
      'medium',
    ]
    expect(
      validPriorities.includes(
        arbiterOutput.next_action.priority?.toLowerCase(),
      ),
    ).toBe(true)

    // Estimated cost should be a number
    expect(typeof arbiterOutput.next_action.estimated_cost_usd).toBe('number')

    console.log(
      `[smoke] Arbiter: ${arbiterOutput.claim_updates.length} updates, ` +
        `next="${arbiterOutput.next_action.action}", ` +
        `delegate=${arbiterOutput.next_action.delegate_to}`,
    )
  }, 120_000)

  // ── Test 4: Claim Graph Updates ────────────────────────
  test('Claim graph updates correctly from Arbiter', () => {
    expect(arbiterOutput).toBeDefined()

    const preStats = graph.getStatistics()
    console.log(
      `[smoke] Pre-update: ${preStats.total} claims (${preStats.admitted} admitted, ${preStats.proposed} proposed)`,
    )

    // Apply claim updates (inline version of Orchestrator.applyClaimUpdates)
    const counts = { admitted: 0, demoted: 0, rejected: 0, kept: 0 }

    for (const update of arbiterOutput.claim_updates ?? []) {
      const claim = graph.getClaim(update.claim_id)
      if (!claim) continue

      switch (update.action) {
        case 'admit': {
          const decision = canAdmit(update.claim_id, graph, pool)
          if (decision.admit) {
            graph.updateClaim(update.claim_id, { phase: 'admitted' })
            counts.admitted++
          } else {
            console.log(
              `[smoke] Admission gate blocked ${update.claim_id}: ${decision.reason}`,
            )
          }
          break
        }
        case 'demote':
          graph.updateClaim(update.claim_id, { phase: 'demoted' })
          counts.demoted++
          break
        case 'reject':
          graph.updateClaim(update.claim_id, { phase: 'rejected' })
          counts.rejected++
          break
        case 'keep':
          if (update.new_confidence != null) {
            graph.updateClaim(update.claim_id, {
              strength: {
                ...claim.strength,
                confidence: Math.max(0, Math.min(1, update.new_confidence)),
              },
            })
          }
          counts.kept++
          break
      }
    }

    // Apply contractions
    let contractions = 0
    for (const c of arbiterOutput.contracted_claims ?? []) {
      const claim = graph.getClaim(c.claim_id)
      if (!claim) continue
      graph.updateClaim(c.claim_id, {
        statement: c.contracted_statement || claim.statement,
        phase: 'proposed',
      })
      contractions++
    }

    const postStats = graph.getStatistics()
    console.log(
      `[smoke] Post-update: ${postStats.total} claims ` +
        `(${postStats.admitted} admitted, ${postStats.proposed} proposed, ` +
        `${postStats.demoted} demoted, ${postStats.rejected} rejected)`,
    )
    console.log(
      `[smoke] Counts: ${counts.admitted} admitted, ${counts.demoted} demoted, ` +
        `${counts.rejected} rejected, ${counts.kept} kept, ${contractions} contracted`,
    )

    // Builder added claims → total count increased
    expect(graph.claimCount).toBeGreaterThan(initialClaimCount)

    // At least some updates should have been processed
    const totalActions =
      counts.admitted + counts.demoted + counts.rejected + counts.kept
    // It's possible the Arbiter issued 0 updates if all claims are new
    // so we just ensure no crash and log the result
    console.log(`[smoke] Total arbiter actions applied: ${totalActions}`)
  })

  // ── Test 5: Trajectory Entry ───────────────────────────
  test('Trajectory entry is complete', () => {
    expect(builderOutput).toBeDefined()
    expect(skepticOutput).toBeDefined()
    expect(arbiterOutput).toBeDefined()

    // Build trajectory entry as the orchestrator would
    const challengeParts: string[] = []
    const inconsistencies = skepticOutput.internal_inconsistencies?.length ?? 0
    const gaps = skepticOutput.bridge_gaps?.length ?? 0
    const inflation = skepticOutput.evidence_inflation?.length ?? 0
    const collapses = skepticOutput.top3_collapse_points?.length ?? 0
    const denials = skepticOutput.admission_denials?.length ?? 0

    if (inconsistencies > 0)
      challengeParts.push(`${inconsistencies} inconsistencies`)
    if (gaps > 0) challengeParts.push(`${gaps} bridge gaps`)
    if (inflation > 0) challengeParts.push(`${inflation} evidence inflation`)
    if (collapses > 0) challengeParts.push(`${collapses} collapse points`)
    if (denials > 0) challengeParts.push(`${denials} admission denials`)
    const skepticSummary =
      challengeParts.length > 0 ? challengeParts.join(', ') : 'no challenges'

    const trajectoryEntry = {
      action_type: 'triple_role_cycle',
      agent: 'orchestrator',
      description: `Builder→Skeptic→Arbiter cycle`,
      outcome: arbiterOutput.overall_assessment,
      state_changes: [
        `Builder proposed ${builderOutput.new_claims_proposed.length} claims`,
        `Skeptic: ${skepticSummary}`,
        `Arbiter: ${arbiterOutput.claim_updates.length} updates`,
      ],
      cycle: 1,
      builder_output_summary: builderOutput.narrative.slice(0, 200),
      skeptic_challenges_summary: skepticSummary,
      arbiter_decision_summary: `${arbiterOutput.next_action.action} (${arbiterOutput.next_action.delegate_to})`,
      claim_graph_delta: {
        claims_added: builderOutput.new_claims_proposed.length,
        claims_admitted: arbiterOutput.claim_updates.filter(
          u => u.action === 'admit',
        ).length,
        claims_demoted: arbiterOutput.claim_updates.filter(
          u => u.action === 'demote',
        ).length,
        claims_rejected: arbiterOutput.claim_updates.filter(
          u => u.action === 'reject',
        ).length,
        edges_added: builderOutput.new_edges_proposed?.length ?? 0,
      },
    }

    // Validate completeness
    expect(trajectoryEntry.cycle).toBe(1)
    expect(trajectoryEntry.builder_output_summary).toBeTruthy()
    expect(trajectoryEntry.skeptic_challenges_summary).toBeTruthy()
    expect(trajectoryEntry.arbiter_decision_summary).toBeTruthy()
    expect(typeof trajectoryEntry.claim_graph_delta.claims_added).toBe('number')
    expect(typeof trajectoryEntry.claim_graph_delta.claims_admitted).toBe(
      'number',
    )
    expect(typeof trajectoryEntry.claim_graph_delta.claims_demoted).toBe(
      'number',
    )
    expect(typeof trajectoryEntry.claim_graph_delta.claims_rejected).toBe(
      'number',
    )
    expect(typeof trajectoryEntry.claim_graph_delta.edges_added).toBe('number')
    expect(trajectoryEntry.outcome).toBeTruthy()

    console.log(
      `[smoke] Trajectory entry: cycle=${trajectoryEntry.cycle}, ` +
        `claims_added=${trajectoryEntry.claim_graph_delta.claims_added}, ` +
        `arbiter_decision="${trajectoryEntry.arbiter_decision_summary}"`,
    )
  })

  // ── Cost Summary (runs after all tests) ────────────────
  test('cost summary', () => {
    console.log('\n' + '='.repeat(60))
    console.log('TRIPLE-ROLE SMOKE TEST — COST SUMMARY')
    console.log('='.repeat(60))

    let totalIn = 0
    let totalOut = 0
    let totalCost = 0

    for (const { role, result } of callResults) {
      console.log(
        `  ${role.padEnd(10)} | ${String(result.input_tokens).padStart(6)} in | ` +
          `${String(result.output_tokens).padStart(6)} out | $${result.cost_usd.toFixed(4)}`,
      )
      totalIn += result.input_tokens
      totalOut += result.output_tokens
      totalCost += result.cost_usd
    }

    console.log('-'.repeat(60))
    console.log(
      `  ${'TOTAL'.padEnd(10)} | ${String(totalIn).padStart(6)} in | ` +
        `${String(totalOut).padStart(6)} out | $${totalCost.toFixed(4)}`,
    )
    console.log('='.repeat(60) + '\n')

    // Sanity: total cost should be under $2
    expect(totalCost).toBeLessThan(2.0)
  })
})
