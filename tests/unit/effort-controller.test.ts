import { describe, it, expect } from 'bun:test'
import {
  determineEffort,
  type EffortLevel,
} from '../../src/paper/effort-controller'
import type {
  ResearchState,
  StabilityMetrics,
} from '../../src/paper/research-state'

/**
 * Minimal ResearchState factory for effort controller tests.
 * Only populates fields the controller inspects.
 */
function makeState(
  overrides: Partial<{
    convergenceScore: number
    weakestBridgeVulnerability: number | null
    cycle_count: number
    contradictions: number
    budgetRemaining: number
    budgetTotal: number
    mainTheoremPending: boolean
    formalProofInProgress: boolean
  }>,
): ResearchState {
  const o = {
    convergenceScore: 0.5,
    weakestBridgeVulnerability: null as number | null,
    cycle_count: 1,
    contradictions: 0,
    budgetRemaining: 80,
    budgetTotal: 100,
    mainTheoremPending: false,
    formalProofInProgress: false,
    ...overrides,
  }

  // Build contradicting evidence entries
  const grounded = Array.from({ length: o.contradictions }, (_, i) => ({
    id: `g-${i}`,
    type: 'literature' as const,
    source: `paper-${i}`,
    statement: `Evidence ${i}`,
    verified: true,
    verification_method: undefined,
    supports_claims: [],
    contradicts_claims: [`claim-${i}`],
    acquired_at: new Date().toISOString(),
    acquired_by: 'test',
  }))

  // Build claims for main theorem pending
  const claims: any[] = []
  if (o.mainTheoremPending) {
    claims.push({
      id: 'thm-1',
      type: 'theorem',
      epistemicLayer: 'justification',
      statement: 'Main theorem',
      phase: 'under_investigation',
      is_main: true,
      depth: 0,
      strength: {
        confidence: 0.5,
        evidenceType: 'heuristic_motivation',
        vulnerabilityScore: 0.5,
      },
      evidence: { grounded: [], derived: [] },
      created_by: 'test',
      created_at: new Date().toISOString(),
    })
  }

  // Build proofs for formal proof in progress
  const proofs: any[] = []
  if (o.formalProofInProgress) {
    proofs.push({
      id: 'prf-1',
      theorem_statement: 'Universal approximation bound',
      proof_status: 'draft',
      assumptions: [],
      rigor_level: 'formal',
      fragment_path: null,
      assumption_reality_gaps: [],
    })
  }

  return {
    id: 'test-state',
    proposal: {} as any,
    paper_type: 'mixed',
    claimGraph: { claims, edges: [] },
    evidencePool: { grounded, derived: [] },
    stability: {
      convergenceScore: o.convergenceScore,
      admittedClaimCount: 0,
      proposedClaimCount: 0,
      weakestBridge:
        o.weakestBridgeVulnerability !== null
          ? { claimId: 'weak-1', vulnerability: o.weakestBridgeVulnerability }
          : null,
      paperReadiness: 'not_ready',
      evidenceCoverage: 0,
      lastArbiterAssessment: '',
    },
    literature_awareness: {
      deeply_read: [],
      aware_but_unread: [],
      known_results: [],
      confirmed_gaps: [],
      last_comprehensive_search: null,
    },
    theory: { proofs },
    budget: {
      total_usd: o.budgetTotal,
      spent_usd: o.budgetTotal - o.budgetRemaining,
      remaining_usd: o.budgetRemaining,
      warn_at_percent: 20,
      breakdown: [],
    },
    time: {
      started_at: new Date().toISOString(),
      estimated_completion: null,
      deadline: null,
    },
    compute: null,
    artifacts: {
      entries: [],
      literature_db: null,
      selected_proposal: null,
      paper_tex: null,
      compiled_pdf: null,
    },
    trajectory: [],
    loaded_knowledge_packs: [],
    initialized: true,
    orchestrator_cycle_count: o.cycle_count,
  }
}

function makeStability(convergenceScore: number): StabilityMetrics {
  return {
    convergenceScore,
    admittedClaimCount: 0,
    proposedClaimCount: 0,
    weakestBridge: null,
    paperReadiness: 'not_ready',
    evidenceCoverage: 0,
    lastArbiterAssessment: '',
  }
}

describe('determineEffort', () => {
  it('returns medium for digest role regardless of state', () => {
    const state = makeState({ convergenceScore: 0, cycle_count: 100 })
    const result = determineEffort(state, 'digest')
    expect(result.effort).toBe('medium')
    expect(result.reasons).toHaveLength(0)
  })

  it('returns medium for a calm state', () => {
    const state = makeState({})
    const result = determineEffort(state, 'builder')
    expect(result.effort).toBe('medium')
    expect(result.reasons).toHaveLength(0)
  })

  it('rule 0: budget veto returns medium even if other escalations apply', () => {
    const state = makeState({
      budgetRemaining: 10,
      budgetTotal: 100,
      convergenceScore: 0.1,
      cycle_count: 10,
    })
    const prevStability = makeStability(0.9) // huge regression
    const result = determineEffort(state, 'builder', prevStability)
    expect(result.effort).toBe('medium')
    expect(result.reasons).toHaveLength(0)
  })

  it('rule 1: escalates on convergence regression', () => {
    const state = makeState({ convergenceScore: 0.3 })
    const prevStability = makeStability(0.6) // dropped by 0.3
    const result = determineEffort(state, 'builder', prevStability)
    expect(result.effort).toBe('high')
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('Convergence dropped')]),
    )
  })

  it('rule 1: does not escalate for small convergence dip', () => {
    const state = makeState({ convergenceScore: 0.45 })
    const prevStability = makeStability(0.5) // dropped by 0.05
    const result = determineEffort(state, 'builder', prevStability)
    expect(result.effort).toBe('medium')
  })

  it('rule 2: escalates builder on high vulnerability bridge', () => {
    const state = makeState({ weakestBridgeVulnerability: 0.85 })
    const result = determineEffort(state, 'builder')
    expect(result.effort).toBe('high')
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Weakest bridge vulnerability'),
      ]),
    )
  })

  it('rule 2: does not escalate skeptic on high vulnerability', () => {
    const state = makeState({ weakestBridgeVulnerability: 0.85 })
    const result = determineEffort(state, 'skeptic')
    expect(result.effort).toBe('medium')
  })

  it('rule 3: escalates builder when stuck', () => {
    const state = makeState({
      convergenceScore: 0.1,
      cycle_count: 8,
    })
    const result = determineEffort(state, 'builder')
    expect(result.effort).toBe('high')
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Low convergence after 8 cycles'),
      ]),
    )
  })

  it('rule 3: does not apply to arbiter', () => {
    const state = makeState({
      convergenceScore: 0.1,
      cycle_count: 8,
    })
    const result = determineEffort(state, 'arbiter')
    expect(result.effort).toBe('medium')
  })

  it('rule 4: escalates skeptic on many contradictions', () => {
    const state = makeState({ contradictions: 5 })
    const result = determineEffort(state, 'skeptic')
    expect(result.effort).toBe('high')
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('5 contradictions')]),
    )
  })

  it('rule 4: does not escalate builder on contradictions', () => {
    const state = makeState({ contradictions: 5 })
    const result = determineEffort(state, 'builder')
    expect(result.effort).toBe('medium')
  })

  it('rule 5: escalates arbiter when core theorem is pending', () => {
    const state = makeState({ mainTheoremPending: true })
    const result = determineEffort(state, 'arbiter')
    expect(result.effort).toBe('high')
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Core theorem pending admission'),
      ]),
    )
  })

  it('rule 6: escalates builder when formal proof in progress', () => {
    const state = makeState({ formalProofInProgress: true })
    const result = determineEffort(state, 'builder')
    expect(result.effort).toBe('high')
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('Formal proof')]),
    )
  })

  it('collects multiple reasons when multiple rules fire', () => {
    const state = makeState({
      convergenceScore: 0.1,
      cycle_count: 10,
      weakestBridgeVulnerability: 0.9,
      formalProofInProgress: true,
    })
    const prevStability = makeStability(0.5) // regression
    const result = determineEffort(state, 'builder', prevStability)
    expect(result.effort).toBe('high')
    // Should have: convergence regression + high vulnerability + stuck + formal proof
    expect(result.reasons.length).toBeGreaterThanOrEqual(3)
  })

  it('handles null previousStability gracefully', () => {
    const state = makeState({})
    const result = determineEffort(state, 'builder', null)
    expect(result.effort).toBe('medium')
  })

  it('handles zero budget total without division by zero', () => {
    const state = makeState({ budgetTotal: 0, budgetRemaining: 0 })
    // total_usd = 0 → budget veto condition (remaining/total) is guarded
    const result = determineEffort(state, 'builder')
    // With total=0, the budget veto guard (total_usd > 0) is false, so no veto
    expect(result).toBeDefined()
  })
})
