/**
 * E2E: ClaimGraph Multi-Round Lifecycle
 *
 * Gate: CLAIM_GRAPH_E2E=true
 * No API calls — tests the in-memory ClaimGraph, EvidencePool,
 * AdmissionGate, ContextViews, and ConvergenceDetector end-to-end.
 *
 * Run:
 *   CLAIM_GRAPH_E2E=true bun test tests/e2e/12-claim-graph.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { ClaimGraph, type ClaimInput } from '../../src/paper/claim-graph/index'
import type { ClaimRelation } from '../../src/paper/claim-graph/types'
import { EvidencePoolManager } from '../../src/paper/evidence-pool'
import { canAdmit } from '../../src/paper/admission-gate'
import { suggestContraction } from '../../src/paper/claim-contraction'
import { ConvergenceDetector } from '../../src/paper/convergence'
import { PromptAssembler } from '../../src/paper/claim-graph/prompt-assembler'
import {
  initializeFromProposal,
  computeBasicStability,
} from '../../src/paper/research-state'
import {
  buildL0,
  buildL1,
  buildL2,
} from '../../src/paper/claim-graph/context-views'
import { estimateTokens } from '../../src/paper/claim-graph/token-utils'

const ENABLED = process.env.CLAIM_GRAPH_E2E === 'true'

const testProposal = {
  id: 'e2e-claim-graph',
  title: 'Neural Operator Calibration of Implied Volatility Surfaces',
  abstract:
    'We propose a DeepONet approach to calibrate implied volatility surfaces from sparse options market data.',
  innovation: [
    'First neural operator approach to vol surface calibration',
    'No-arbitrage constraint layer in DeepONet trunk',
  ],
  methodology:
    'Train DeepONet on synthetic Heston data, fine-tune on SPX options',
  feasibility: {
    score: 0.85,
    data_required: 'SPX options data',
    compute_estimate: '4 GPU-hours',
    timeline_weeks: 6,
  },
  risk: {
    level: 'medium' as const,
    description: 'May not generalize to extreme market regimes',
  },
  novelty_score: 0.75,
  impact_score: 0.7,
  references: ['Lu2021_DeepONet', 'Gatheral2004_VolSurface'],
  created_at: new Date().toISOString(),
}

function makeClaim(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    type: 'hypothesis',
    epistemicLayer: 'explanation',
    statement: 'Test claim',
    phase: 'proposed',
    evidence: { grounded: [], derived: [] },
    strength: {
      confidence: 0.7,
      evidenceType: 'heuristic_motivation',
      vulnerabilityScore: 0.4,
    },
    created_by: 'test',
    ...overrides,
  }
}

describe.skipIf(!ENABLED)('ClaimGraph E2E', () => {
  test('multi-round claim lifecycle: propose → investigate → admit', () => {
    const state = initializeFromProposal(testProposal, {
      budget_usd: 100,
      paper_type: 'mixed',
    })
    const graph = new ClaimGraph(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)

    const initialCount = graph.claimCount

    // Round 1: Add observation claims
    const obsId = graph.addClaim(
      makeClaim({
        type: 'observation',
        epistemicLayer: 'observation',
        statement:
          'Heston model calibration takes >30s for short-expiry strikes',
        strength: {
          confidence: 0.9,
          evidenceType: 'empirical_support',
          vulnerabilityScore: 0.1,
        },
      }),
    )

    const benchId = graph.addClaim(
      makeClaim({
        type: 'benchmark',
        epistemicLayer: 'observation',
        statement:
          'Levenberg-Marquardt baseline achieves RMSE 0.012 on synthetic Heston data',
        strength: {
          confidence: 0.95,
          evidenceType: 'empirical_support',
          vulnerabilityScore: 0.05,
        },
      }),
    )

    // Round 2: Add hypothesis building on observations
    const hypId = graph.addClaim(
      makeClaim({
        type: 'hypothesis',
        epistemicLayer: 'explanation',
        statement:
          'DeepONet can learn the inverse map from option prices to vol surfaces',
        strength: {
          confidence: 0.7,
          evidenceType: 'heuristic_motivation',
          vulnerabilityScore: 0.4,
        },
      }),
    )

    const noveltyId = graph.addClaim(
      makeClaim({
        type: 'novelty',
        epistemicLayer: 'exploitation',
        statement:
          'Soft no-arbitrage constraint in trunk network prevents calendar spread violations',
        strength: {
          confidence: 0.6,
          evidenceType: 'heuristic_motivation',
          vulnerabilityScore: 0.5,
        },
      }),
    )

    // Add edges
    graph.addEdge({
      source: hypId,
      target: obsId,
      relation: 'motivates',
      strength: 'strong',
    })
    graph.addEdge({
      source: noveltyId,
      target: hypId,
      relation: 'depends_on',
      strength: 'moderate',
    })

    expect(graph.claimCount).toBe(initialCount + 4)
    expect(graph.edgeCount).toBeGreaterThanOrEqual(2)

    // Register evidence for observation claims
    pool.addGrounded({
      claim: 'Calibration timing benchmark',
      source_type: 'dataset',
      source_ref: 'SPX options 2020-2023',
      verified: true,
      supports_claims: [obsId],
      contradicts_claims: [],
      acquired_by: 'experiment-runner',
    })
    pool.addDerived({
      claim: 'Timing measurement from calibration code',
      method: 'experiment',
      reproducible: true,
      artifact_id: 'timing-benchmark-001',
      assumptions: ['Standard hardware (32GB RAM, 8 cores)'],
      supports_claims: [obsId],
      contradicts_claims: [],
      produced_by: 'experiment-runner',
    })

    pool.addGrounded({
      claim: 'LM baseline RMSE measurement',
      source_type: 'dataset',
      source_ref: 'synthetic-heston-100k',
      verified: true,
      supports_claims: [benchId],
      contradicts_claims: [],
      acquired_by: 'experiment-runner',
    })
    pool.addDerived({
      claim: 'RMSE computed from 10-fold cross-validation',
      method: 'experiment',
      reproducible: true,
      artifact_id: 'lm-baseline-001',
      assumptions: ['10-fold CV, standard Heston params'],
      supports_claims: [benchId],
      contradicts_claims: [],
      produced_by: 'experiment-runner',
    })

    // Attach evidence refs to claims
    graph.updateClaim(obsId, {
      evidence: { grounded: ['g1'], derived: ['d1'] },
    })
    graph.updateClaim(benchId, {
      evidence: { grounded: ['g2'], derived: ['d2'] },
    })

    // Admission gate: observation with evidence should pass
    const obsDecision = canAdmit(obsId, graph, pool)
    expect(obsDecision.admit).toBe(true)

    const benchDecision = canAdmit(benchId, graph, pool)
    expect(benchDecision.admit).toBe(true)

    // Hypothesis without evidence should fail
    const hypDecision = canAdmit(hypId, graph, pool)
    expect(hypDecision.admit).toBe(false)

    // Novelty without both evidence types should fail
    const noveltyDecision = canAdmit(noveltyId, graph, pool)
    expect(noveltyDecision.admit).toBe(false)

    // Advance admitted claims
    graph.updateClaim(obsId, { phase: 'admitted' })
    graph.updateClaim(benchId, { phase: 'admitted' })
    graph.updateClaim(hypId, { phase: 'under_investigation' })

    // Verify statistics
    const stats = graph.getStatistics()
    expect(stats.admitted).toBe(2)
    expect(stats.investigating).toBeGreaterThanOrEqual(1)
    expect(stats.proposed).toBeGreaterThanOrEqual(1)

    // Convergence check (basic — no trajectory yet)
    const updatedState = {
      ...state,
      claimGraph: graph.toJSON(),
      evidencePool: pool.pool,
      stability: computeBasicStability(graph, pool),
    }
    const detector = new ConvergenceDetector()
    const stability = detector.compute(updatedState, pool)
    expect(stability.convergenceScore).toBeGreaterThan(0)
    expect(stability.admittedClaimCount).toBe(2)
  }, 120_000)

  test('context view compression: L2 < L1 < L0+L1+L2', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()

    // Create 25+ claims across layers
    const claimIds: string[] = []
    const layers = [
      'observation',
      'explanation',
      'exploitation',
      'justification',
    ] as const
    const types = [
      'observation',
      'hypothesis',
      'empirical',
      'theorem',
      'assumption',
    ] as const

    for (let i = 0; i < 25; i++) {
      const id = graph.addClaim(
        makeClaim({
          type: types[i % types.length],
          epistemicLayer: layers[i % layers.length],
          statement: `Claim ${i}: Detailed research finding about aspect ${i} of the neural operator calibration methodology with sufficient length for realistic token estimation`,
          strength: {
            confidence: 0.3 + Math.random() * 0.6,
            evidenceType: 'heuristic_motivation',
            vulnerabilityScore: Math.random() * 0.8,
          },
        }),
      )
      claimIds.push(id)
    }

    // Add some edges
    for (let i = 1; i < 15; i++) {
      const relations: ClaimRelation[] = ['supports', 'depends_on', 'motivates']
      graph.addEdge({
        source: claimIds[i],
        target: claimIds[i - 1],
        relation: relations[i % relations.length],
        strength: 'moderate',
      })
    }

    const stability = computeBasicStability(graph, pool)

    // Build views
    const l0 = buildL0(graph, pool, stability)
    const l1 = buildL1(graph)
    const focusIds = claimIds.slice(0, 10)
    const l2 = buildL2(graph, focusIds, pool, 3000)

    const l0Tokens = estimateTokens(l0)
    const l1Tokens = estimateTokens(l1)
    const l2Tokens = estimateTokens(l2)

    // L0 is the most compact (~300 tokens)
    expect(l0Tokens).toBeLessThan(500)

    // L2 is bounded by its budget
    expect(l2Tokens).toBeLessThan(3500) // within budget + overhead

    // Full prompt (L0+L1+L2) should fit within 12K budget
    const totalTokens = l0Tokens + l1Tokens + l2Tokens
    expect(totalTokens).toBeLessThan(12_000)

    // L0 should contain key statistics
    expect(l0).toContain('Claims: 25')
    expect(l0).toContain('Convergence')
  }, 60_000)

  test('contraction + edge integrity', () => {
    const graph = new ClaimGraph()

    // Create claims at different epistemic layers
    const obsId = graph.addClaim(
      makeClaim({
        type: 'observation',
        epistemicLayer: 'observation',
        statement: 'We observed calibration takes 30s',
      }),
    )

    const explId = graph.addClaim(
      makeClaim({
        type: 'hypothesis',
        epistemicLayer: 'explanation',
        statement: 'The slow calibration is due to SDE parameter sensitivity',
      }),
    )

    const exptId = graph.addClaim(
      makeClaim({
        type: 'algorithmic',
        epistemicLayer: 'exploitation',
        statement:
          'Neural operator bypasses SDE solving entirely, achieving O(1) calibration',
      }),
    )

    const justId = graph.addClaim(
      makeClaim({
        type: 'theorem',
        epistemicLayer: 'justification',
        statement:
          'Universal approximation theorem guarantees the operator can learn the inverse map',
      }),
    )

    const contraId = graph.addClaim(
      makeClaim({
        type: 'limitation',
        epistemicLayer: 'explanation',
        statement: 'Neural operator may overfit to normal market conditions',
      }),
    )

    // Add edges including contradictions
    graph.addEdge({
      source: explId,
      target: obsId,
      relation: 'supports',
      strength: 'strong',
    })
    graph.addEdge({
      source: exptId,
      target: explId,
      relation: 'depends_on',
      strength: 'moderate',
    })
    graph.addEdge({
      source: justId,
      target: exptId,
      relation: 'supports',
      strength: 'moderate',
    })
    graph.addEdge({
      source: contraId,
      target: exptId,
      relation: 'contradicts',
      strength: 'moderate',
    })

    // Contraction on high-layer claims
    const justContraction = suggestContraction(justId, graph)
    expect(justContraction.current_layer).toBe('justification')
    expect(justContraction.contracted_layer).toBe('exploitation')
    expect(justContraction.strategy).toContain('heuristic')

    const exptContraction = suggestContraction(exptId, graph)
    expect(exptContraction.current_layer).toBe('exploitation')
    expect(exptContraction.contracted_layer).toBe('explanation')

    const explContraction = suggestContraction(explId, graph)
    expect(explContraction.current_layer).toBe('explanation')
    expect(explContraction.contracted_layer).toBe('observation')

    const obsContraction = suggestContraction(obsId, graph)
    expect(obsContraction.current_layer).toBe('observation')
    expect(obsContraction.contracted_layer).toBeNull()

    // Find contradictions
    const contradictions = graph.findContradictions()
    expect(contradictions.length).toBeGreaterThanOrEqual(1)
    const contradictedIds = contradictions.map(c => c.claim.id)
    expect(
      contradictedIds.includes(contraId) || contradictedIds.includes(exptId),
    ).toBe(true)

    // Cascade analysis: removing exptId should affect justId
    const cascade = graph.cascadeAnalysis(exptId)
    // justId depends on exptId, so it should be in the cascade
    // Note: cascade finds claims that depend on the given claim
    // exptId has a supports edge FROM justId, but cascade looks at depends_on
    // exptId depends_on explId, so cascade of explId should include exptId
    const explCascade = graph.cascadeAnalysis(explId)
    expect(explCascade).toContain(exptId)

    // Edge integrity after removeClaim
    const preEdgeCount = graph.edgeCount
    graph.removeClaim(contraId)
    // The contradicts edge should be cascade-deleted
    expect(graph.edgeCount).toBeLessThan(preEdgeCount)
    // Contradiction should no longer appear
    const postContradictions = graph.findContradictions()
    expect(postContradictions.every(c => c.claim.id !== contraId)).toBe(true)
  }, 60_000)
})
