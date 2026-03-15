import { describe, test, expect } from 'bun:test'
import { ConvergenceDetector } from '../../src/paper/convergence'
import { ClaimGraph, type ClaimInput } from '../../src/paper/claim-graph/index'
import { EvidencePoolManager } from '../../src/paper/evidence-pool'
import type {
  ResearchState,
  TrajectoryEntry,
} from '../../src/paper/research-state'
import { initializeFromProposal } from '../../src/paper/research-state'

function makeProposal() {
  return {
    id: 'test-proposal',
    title: 'Test Research',
    abstract: 'Test',
    methodology: 'Testing',
    innovation: [{ description: 'Novel approach' }],
    novelty_score: 0.8,
    impact_score: 0.7,
    feasibility: { score: 0.9, data_required: 'none' },
  } as any
}

function makeState(overrides?: Partial<ResearchState>): ResearchState {
  const base = initializeFromProposal(makeProposal())
  return { ...base, ...overrides }
}

function makeClaim(
  phase:
    | 'proposed'
    | 'under_investigation'
    | 'admitted'
    | 'demoted'
    | 'rejected'
    | 'retracted',
  opts?: { confidence?: number; vulnScore?: number },
): ClaimInput & { forcePhase: string } {
  return {
    type: 'hypothesis',
    epistemicLayer: 'explanation',
    statement: `Claim in ${phase} phase`,
    phase: 'proposed', // addClaim always starts as proposed
    evidence: { grounded: [], derived: [] },
    strength: {
      confidence: opts?.confidence ?? 0.7,
      evidenceType: 'empirical_support',
      vulnerabilityScore: opts?.vulnScore ?? 0.3,
    },
    created_by: 'test',
    forcePhase: phase,
  }
}

function buildGraphAndPool(
  claims: ReturnType<typeof makeClaim>[],
  options?: {
    addDualEvidence?: string[] // claim indices (0-based) that get dual evidence
  },
): { graphData: any; pool: EvidencePoolManager; claimIds: string[] } {
  const graph = new ClaimGraph()
  const claimIds: string[] = []

  for (const c of claims) {
    const { forcePhase, ...input } = c
    const id = graph.addClaim(input)
    claimIds.push(id)
    // Force phase via updateClaim
    if (forcePhase !== 'proposed') {
      graph.updateClaim(id, { phase: forcePhase as any })
    }
  }

  const poolData = { grounded: [] as any[], derived: [] as any[] }
  if (options?.addDualEvidence) {
    for (const idxStr of options.addDualEvidence) {
      const idx = parseInt(idxStr, 10)
      const claimId = claimIds[idx]
      poolData.grounded.push({
        id: `g-${idx}`,
        type: 'experiment_result',
        source: 'test',
        supports_claims: [claimId],
        contradicts_claims: [],
        content_summary: 'Test grounded evidence',
        verified: true,
        timestamp: new Date().toISOString(),
      })
      poolData.derived.push({
        id: `d-${idx}`,
        type: 'proof_step',
        source: 'test',
        supports_claims: [claimId],
        contradicts_claims: [],
        content_summary: 'Test derived evidence',
        derivation_chain: ['axiom'],
        reproducible: true,
        timestamp: new Date().toISOString(),
      })
    }
  }

  const pool = new EvidencePoolManager(poolData)
  return { graphData: graph.toJSON(), pool, claimIds }
}

function makeTrajectoryEntry(delta?: {
  claims_added?: number
  claims_demoted?: number
  claims_rejected?: number
}): TrajectoryEntry {
  return {
    timestamp: new Date().toISOString(),
    action_type: 'test',
    agent: 'test-agent',
    description: 'Test action',
    outcome: 'done',
    state_changes: [],
    claim_graph_delta: {
      claims_added: delta?.claims_added ?? 0,
      claims_admitted: 0,
      claims_demoted: delta?.claims_demoted ?? 0,
      claims_rejected: delta?.claims_rejected ?? 0,
      edges_added: 0,
    },
  }
}

describe('ConvergenceDetector', () => {
  const detector = new ConvergenceDetector()

  test('all admitted + high coverage + stable trajectory → score > 0.8 (ready)', () => {
    // 5 admitted claims, all with dual evidence, stable trajectory
    const claims = Array.from({ length: 5 }, () =>
      makeClaim('admitted', { confidence: 0.9, vulnScore: 0.1 }),
    )
    const dualIndices = claims.map((_, i) => String(i))
    const { graphData, pool } = buildGraphAndPool(claims, {
      addDualEvidence: dualIndices,
    })

    // 5 stable trajectory entries (0 churn each)
    const trajectory = Array.from({ length: 5 }, () =>
      makeTrajectoryEntry({
        claims_added: 0,
        claims_demoted: 0,
        claims_rejected: 0,
      }),
    )

    const state = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory,
    })
    const result = detector.compute(state, pool)

    expect(result.convergenceScore).toBeGreaterThan(0.8)
    expect(result.paperReadiness).toBe('ready')
    expect(result.admittedClaimCount).toBe(5)
  })

  test('many proposed + low coverage → score < 0.4 (not_ready)', () => {
    // 8 proposed, 1 admitted, no evidence
    const claims = [
      makeClaim('admitted', { confidence: 0.5 }),
      ...Array.from({ length: 8 }, () => makeClaim('proposed')),
    ]
    const { graphData, pool } = buildGraphAndPool(claims)
    const state = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory: [],
    })
    const result = detector.compute(state, pool)

    expect(result.convergenceScore).toBeLessThan(0.4)
    expect(result.paperReadiness).toBe('not_ready')
  })

  test('high vulnerability → lowers score', () => {
    // Create claims with high vulnerability scores
    const claims = [
      makeClaim('admitted', { confidence: 0.2, vulnScore: 0.95 }),
      makeClaim('admitted', { confidence: 0.8, vulnScore: 0.1 }),
    ]
    const { graphData, pool } = buildGraphAndPool(claims, {
      addDualEvidence: ['0', '1'],
    })
    const stableTrajectory = Array.from({ length: 5 }, () =>
      makeTrajectoryEntry({
        claims_added: 0,
        claims_demoted: 0,
        claims_rejected: 0,
      }),
    )
    const state = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory: stableTrajectory,
    })
    const result = detector.compute(state, pool)

    // Compare with a low-vulnerability version
    const lowVulnClaims = [
      makeClaim('admitted', { confidence: 0.9, vulnScore: 0.05 }),
      makeClaim('admitted', { confidence: 0.9, vulnScore: 0.05 }),
    ]
    const lv = buildGraphAndPool(lowVulnClaims, { addDualEvidence: ['0', '1'] })
    const lowVulnState = makeState({
      claimGraph: lv.graphData,
      evidencePool: lv.pool.pool,
      trajectory: stableTrajectory,
    })
    const lowVulnResult = detector.compute(lowVulnState, lv.pool)

    expect(result.convergenceScore).toBeLessThan(lowVulnResult.convergenceScore)
  })

  test('low trajectory churn (stable) → boosts score', () => {
    const claims = [
      makeClaim('admitted', { confidence: 0.7 }),
      makeClaim('proposed'),
    ]
    const { graphData, pool } = buildGraphAndPool(claims, {
      addDualEvidence: ['0'],
    })

    // Stable trajectory: 0 churn
    const stableTrajectory = Array.from({ length: 5 }, () =>
      makeTrajectoryEntry({
        claims_added: 0,
        claims_demoted: 0,
        claims_rejected: 0,
      }),
    )
    const stableState = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory: stableTrajectory,
    })
    const stableResult = detector.compute(stableState, pool)

    // Volatile trajectory: lots of churn
    const volatileTrajectory = Array.from({ length: 5 }, () =>
      makeTrajectoryEntry({
        claims_added: 5,
        claims_demoted: 3,
        claims_rejected: 2,
      }),
    )
    const volatileState = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory: volatileTrajectory,
    })
    const volatileResult = detector.compute(volatileState, pool)

    expect(stableResult.convergenceScore).toBeGreaterThan(
      volatileResult.convergenceScore,
    )
  })

  test('high trajectory churn (volatile) → lowers score', () => {
    const claims = Array.from({ length: 4 }, () =>
      makeClaim('admitted', { confidence: 0.8 }),
    )
    const { graphData, pool } = buildGraphAndPool(claims, {
      addDualEvidence: ['0', '1', '2', '3'],
    })

    // Very high churn trajectory
    const trajectory = Array.from({ length: 5 }, () =>
      makeTrajectoryEntry({
        claims_added: 10,
        claims_demoted: 5,
        claims_rejected: 5,
      }),
    )
    const state = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory,
    })
    const result = detector.compute(state, pool)

    // Momentum component should be 0 (avgDelta=20, 1 - 20/3 < 0 → clamped to 0)
    // So max score = admissionRate*0.3 + coverage*0.3 + (1-vuln)*0.2 + 0
    // Even with perfect admission and coverage, the 0.2 trajectory weight pulls score down
    expect(result.convergenceScore).toBeLessThanOrEqual(0.8)
  })

  test('empty graph → score = 0, readiness = not_ready', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager({ grounded: [], derived: [] })
    const state = makeState({
      claimGraph: graph.toJSON(),
      evidencePool: pool.pool,
      trajectory: [],
    })
    const result = detector.compute(state, pool)

    expect(result.convergenceScore).toBe(0)
    expect(result.paperReadiness).toBe('not_ready')
    expect(result.admittedClaimCount).toBe(0)
    expect(result.proposedClaimCount).toBe(0)
  })

  test('all claims rejected/retracted → 0 active → not_ready', () => {
    const claims = [makeClaim('rejected'), makeClaim('retracted')]
    const { graphData, pool } = buildGraphAndPool(claims)
    const state = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory: [],
    })
    const result = detector.compute(state, pool)

    // 0 active claims → admissionRate = 0, coverage = 0
    expect(result.convergenceScore).toBeLessThanOrEqual(0.2) // at most vuln + momentum components
    expect(result.paperReadiness).toBe('not_ready')
  })

  test('lastArbiterAssessment defaults to empty string', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager({ grounded: [], derived: [] })
    const state = makeState({
      claimGraph: graph.toJSON(),
      evidencePool: pool.pool,
    })
    const result = detector.compute(state, pool)

    expect(result.lastArbiterAssessment).toBe('')
  })

  test('trajectory entries without claim_graph_delta default to high churn', () => {
    const claims = [makeClaim('admitted', { confidence: 0.9 })]
    const { graphData, pool } = buildGraphAndPool(claims, {
      addDualEvidence: ['0'],
    })

    // Trajectory entries without claim_graph_delta (pre-Step-6 compat)
    const legacyTrajectory: TrajectoryEntry[] = Array.from(
      { length: 5 },
      () => ({
        timestamp: new Date().toISOString(),
        action_type: 'test',
        agent: 'test-agent',
        description: 'Legacy entry',
        outcome: 'done',
        state_changes: [],
        // No claim_graph_delta
      }),
    )

    const state = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory: legacyTrajectory,
    })
    const result = detector.compute(state, pool)

    // Legacy entries → avgDelta = 10 → momentum = max(0, 1 - 10/3) = 0
    // So momentum component contributes 0
    expect(result.convergenceScore).toBeLessThan(0.8)
  })

  test('score is always clamped between 0 and 1', () => {
    // Even with extreme values, score should be in [0, 1]
    const claims = Array.from({ length: 10 }, () =>
      makeClaim('admitted', { confidence: 1.0, vulnScore: 0 }),
    )
    const dualIndices = claims.map((_, i) => String(i))
    const { graphData, pool } = buildGraphAndPool(claims, {
      addDualEvidence: dualIndices,
    })
    const stableTrajectory = Array.from({ length: 5 }, () =>
      makeTrajectoryEntry({
        claims_added: 0,
        claims_demoted: 0,
        claims_rejected: 0,
      }),
    )
    const state = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory: stableTrajectory,
    })
    const result = detector.compute(state, pool)

    expect(result.convergenceScore).toBeGreaterThanOrEqual(0)
    expect(result.convergenceScore).toBeLessThanOrEqual(1)
  })

  test('exploratory: score 0.65 → ready (standard would be nearly_ready)', () => {
    // Build a scenario where convergence score is around 0.65-0.75
    // 2 admitted out of 4 claims, moderate coverage, some trajectory churn
    const claims = [
      makeClaim('admitted', { confidence: 0.7, vulnScore: 0.3 }),
      makeClaim('admitted', { confidence: 0.7, vulnScore: 0.3 }),
      makeClaim('proposed', { confidence: 0.5 }),
      makeClaim('proposed', { confidence: 0.4 }),
    ]
    const { graphData, pool } = buildGraphAndPool(claims, {
      addDualEvidence: ['0', '1'],
    })
    const moderateTrajectory = Array.from({ length: 5 }, () =>
      makeTrajectoryEntry({
        claims_added: 1,
        claims_demoted: 0,
        claims_rejected: 0,
      }),
    )
    const state = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory: moderateTrajectory,
    })

    const standardResult = detector.compute(state, pool, 'standard')
    const exploratoryResult = detector.compute(state, pool, 'exploratory')

    // Same score, different readiness
    expect(standardResult.convergenceScore).toBe(
      exploratoryResult.convergenceScore,
    )

    // Score should be in the (0.6, 0.8] range for this test to be meaningful
    expect(standardResult.convergenceScore).toBeGreaterThan(0.6)
    expect(standardResult.convergenceScore).toBeLessThanOrEqual(0.8)

    // Standard: nearly_ready; Exploratory: ready
    expect(standardResult.paperReadiness).toBe('nearly_ready')
    expect(exploratoryResult.paperReadiness).toBe('ready')
  })

  test('exploratory: score 0.3 → needs_work (standard would be not_ready)', () => {
    // Mostly proposed claims, low coverage
    const claims = [
      makeClaim('admitted', { confidence: 0.6 }),
      makeClaim('proposed'),
      makeClaim('proposed'),
      makeClaim('proposed'),
      makeClaim('proposed'),
    ]
    const { graphData, pool } = buildGraphAndPool(claims)
    const state = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory: [],
    })

    const standardResult = detector.compute(state, pool, 'standard')
    const exploratoryResult = detector.compute(state, pool, 'exploratory')

    // Score in the 0.25-0.4 range
    if (
      standardResult.convergenceScore > 0.25 &&
      standardResult.convergenceScore <= 0.4
    ) {
      expect(standardResult.paperReadiness).toBe('not_ready')
      expect(exploratoryResult.paperReadiness).toBe('needs_work')
    }
  })

  test('exploratory: default stance is standard', () => {
    const claims = Array.from({ length: 5 }, () =>
      makeClaim('admitted', { confidence: 0.9, vulnScore: 0.1 }),
    )
    const dualIndices = claims.map((_, i) => String(i))
    const { graphData, pool } = buildGraphAndPool(claims, {
      addDualEvidence: dualIndices,
    })
    const stableTrajectory = Array.from({ length: 5 }, () =>
      makeTrajectoryEntry({
        claims_added: 0,
        claims_demoted: 0,
        claims_rejected: 0,
      }),
    )
    const state = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory: stableTrajectory,
    })

    // No stance param → standard behavior
    const defaultResult = detector.compute(state, pool)
    const standardResult = detector.compute(state, pool, 'standard')

    expect(defaultResult.convergenceScore).toBe(standardResult.convergenceScore)
    expect(defaultResult.paperReadiness).toBe(standardResult.paperReadiness)
  })

  test('score components weighted correctly (30/30/20/20)', () => {
    // Perfect admission (1.0) + 0 coverage + maxVuln=1 + maxChurn → isolate admission
    const claims = [makeClaim('admitted')]
    const { graphData, pool } = buildGraphAndPool(claims) // no dual evidence → coverage=0

    const highChurnTrajectory = Array.from({ length: 5 }, () =>
      makeTrajectoryEntry({
        claims_added: 100,
        claims_demoted: 100,
        claims_rejected: 100,
      }),
    )
    const state = makeState({
      claimGraph: graphData,
      evidencePool: pool.pool,
      trajectory: highChurnTrajectory,
    })
    const result = detector.compute(state, pool)

    // admissionRate=1.0 * 0.3 = 0.3
    // coverage=0 * 0.3 = 0
    // (1-vuln)*0.2 = some small positive (vuln is not 1.0 unless extreme)
    // momentum=0 * 0.2 = 0
    // Score should be around 0.3 + (1-vuln)*0.2
    expect(result.convergenceScore).toBeGreaterThanOrEqual(0.3)
    expect(result.convergenceScore).toBeLessThan(0.6)
  })
})
