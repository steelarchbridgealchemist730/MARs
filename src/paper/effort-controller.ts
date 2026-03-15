import type { ResearchState, StabilityMetrics } from './research-state'

// ── Types ────────────────────────────────────────────────

export type EffortLevel = 'medium' | 'high'
export type OrchestratorRole = 'builder' | 'skeptic' | 'arbiter' | 'digest'

export interface EffortDecision {
  effort: EffortLevel
  reasons: string[]
}

// ── Effort Controller ────────────────────────────────────

/**
 * Determines reasoning effort level for an orchestrator phase.
 * Pure function — no LLM calls. Defaults to 'medium', escalates to 'high'
 * when the research state indicates a critical moment.
 *
 * Rules checked in order (all matching reasons collected):
 *   0. Budget veto: if remaining/total < 0.15, return medium immediately
 *   1. Convergence regression: previous - current > 0.1
 *   2. High vulnerability: weakest bridge vulnerability > 0.7
 *   3. Stuck: cycle_count > 5 && convergence < 0.2
 *   4. Many contradictions: contradicting evidence > 3
 *   5. Core theorem under review (arbiter only)
 *   6. Formal proof in progress (builder only)
 */
export function determineEffort(
  state: ResearchState,
  role: OrchestratorRole,
  previousStability?: StabilityMetrics | null,
): EffortDecision {
  // Digest phase is always medium — lightweight by design
  if (role === 'digest') {
    return { effort: 'medium', reasons: [] }
  }

  // Rule 0: Budget veto — save cost when budget is nearly exhausted
  const { total_usd, remaining_usd } = state.budget
  if (total_usd > 0 && remaining_usd / total_usd < 0.15) {
    return { effort: 'medium', reasons: [] }
  }

  const reasons: string[] = []

  // Rule 1: Convergence regression
  if (previousStability) {
    const delta =
      previousStability.convergenceScore - state.stability.convergenceScore
    if (delta > 0.1) {
      reasons.push(`Convergence dropped by ${delta.toFixed(2)}`)
    }
  }

  // Rule 2: High vulnerability on weakest bridge
  if (
    (role === 'builder' || role === 'arbiter') &&
    state.stability.weakestBridge
  ) {
    const v = state.stability.weakestBridge.vulnerability
    if (v > 0.7) {
      reasons.push(`Weakest bridge vulnerability ${v.toFixed(2)}`)
    }
  }

  // Rule 3: Stuck — many cycles but low convergence
  if (
    role === 'builder' &&
    state.orchestrator_cycle_count > 5 &&
    state.stability.convergenceScore < 0.2
  ) {
    reasons.push(
      `Low convergence after ${state.orchestrator_cycle_count} cycles`,
    )
  }

  // Rule 4: Many contradictions in evidence pool
  if (role === 'skeptic') {
    const contradictionCount = countContradictions(state)
    if (contradictionCount > 3) {
      reasons.push(`${contradictionCount} contradictions in evidence pool`)
    }
  }

  // Rule 5: Core theorem pending admission
  if (role === 'arbiter') {
    const pendingTheorems = state.claimGraph.claims.filter(
      c =>
        c.type === 'theorem' &&
        c.is_main &&
        (c.phase === 'proposed' || c.phase === 'under_investigation'),
    )
    if (pendingTheorems.length > 0) {
      reasons.push('Core theorem pending admission')
    }
  }

  // Rule 6: Formal proof in progress
  if (role === 'builder') {
    const formalProof = state.theory.proofs.find(
      p =>
        p.rigor_level === 'formal' &&
        p.proof_status !== 'verified' &&
        p.proof_status !== 'not_started',
    )
    if (formalProof) {
      reasons.push(`Formal proof: ${formalProof.theorem_statement}`)
    }
  }

  return {
    effort: reasons.length > 0 ? 'high' : 'medium',
    reasons,
  }
}

// ── Helpers ──────────────────────────────────────────────

function countContradictions(state: ResearchState): number {
  let count = 0
  for (const e of state.evidencePool.grounded) {
    if (e.contradicts_claims.length > 0) count++
  }
  for (const e of state.evidencePool.derived) {
    if (e.contradicts_claims.length > 0) count++
  }
  return count
}
