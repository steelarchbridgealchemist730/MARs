import type { ClaimGraph } from './claim-graph/index'
import type { EvidencePoolManager } from './evidence-pool'
import type { ResearchStance } from './types'

export interface AdmissionDecision {
  admit: boolean
  reason?: string
}

/**
 * Hard gate: 6 deterministic rules that a claim must pass
 * before it can be promoted to phase: 'admitted'.
 * Pure function — no LLM calls, no side effects.
 *
 * In exploratory stance, rules R2/R3/R4/R5 are relaxed:
 * - R2: any evidence type sufficient (no dual requirement)
 * - R3: dependencies may be under_investigation (not just admitted)
 * - R4: confidence threshold lowered to 0.4
 * - R5: consistent_with evidence allowed
 */
export function canAdmit(
  claimId: string,
  graph: ClaimGraph,
  pool: EvidencePoolManager,
  stance: ResearchStance = 'standard',
): AdmissionDecision {
  const exploratory = stance === 'exploratory'
  const claim = graph.getClaim(claimId)
  if (!claim) return { admit: false, reason: 'Not found' }

  // R1: Must have at least some evidence (unchanged in both stances)
  if (
    claim.evidence.grounded.length === 0 &&
    claim.evidence.derived.length === 0
  ) {
    return { admit: false, reason: 'No evidence' }
  }

  // R2: theorem and novelty need both grounded AND derived (relaxed in exploratory)
  if (!exploratory && (claim.type === 'theorem' || claim.type === 'novelty')) {
    if (
      claim.evidence.grounded.length === 0 ||
      claim.evidence.derived.length === 0
    ) {
      return {
        admit: false,
        reason: `${claim.type} needs both grounded and derived evidence`,
      }
    }
  }

  // R3: All dependencies must already be admitted (relaxed in exploratory: allow under_investigation)
  const deps = graph.getDependencies(claimId)
  const unadmitted = deps.filter(depId => {
    const dep = graph.getClaim(depId)
    if (!dep) return true
    if (exploratory) {
      return dep.phase !== 'admitted' && dep.phase !== 'under_investigation'
    }
    return dep.phase !== 'admitted'
  })
  if (unadmitted.length > 0) {
    return { admit: false, reason: `Unadmitted deps: ${unadmitted.join(', ')}` }
  }

  // R4: Confidence threshold (0.6 standard, 0.4 exploratory)
  const threshold = exploratory ? 0.4 : 0.6
  if (claim.strength.confidence < threshold) {
    return {
      admit: false,
      reason: `Confidence ${claim.strength.confidence} < ${threshold}`,
    }
  }

  // R5: 'consistent_with' is not strong enough (allowed in exploratory)
  if (!exploratory && claim.strength.evidenceType === 'consistent_with') {
    return {
      admit: false,
      reason: "'Consistent with' ≠ 'supported by'",
    }
  }

  // R6: No epistemic layer skips (unchanged in both stances)
  const skips = graph.detectLayerSkipsFor(claimId)
  if (skips.length > 0) {
    return {
      admit: false,
      reason: `Layer skip: ${skips[0].description}`,
    }
  }

  return { admit: true }
}
