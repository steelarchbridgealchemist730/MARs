import { ClaimGraph } from './claim-graph/index'
import { EvidencePoolManager } from './evidence-pool'
import type { ResearchState, StabilityMetrics } from './research-state'
import type { ResearchStance } from './types'

/**
 * Full convergence detector implementing the 4-component weighted formula
 * from spec Part 7 (lines 945-982).
 *
 * Components:
 *   1. Admission rate    (30%) — admitted / active claims
 *   2. Evidence coverage  (30%) — dual-evidence coverage of admitted claims
 *   3. Structural vuln    (20%) — inverse of max vulnerability from weakest bridges
 *   4. Trajectory momentum(20%) — claim graph stabilization (less churn = more converged)
 *
 * In exploratory stance, readiness thresholds are lowered:
 *   ready: > 0.6 (standard: > 0.8)
 *   nearly_ready: > 0.4 (standard: > 0.6)
 *   needs_work: > 0.25 (standard: > 0.4)
 */
export class ConvergenceDetector {
  compute(
    state: ResearchState,
    pool: EvidencePoolManager,
    stance: ResearchStance = 'standard',
  ): StabilityMetrics {
    const graph = ClaimGraph.fromJSON(state.claimGraph)

    // Active = claims NOT in [rejected, retracted, reformulated]
    const allClaims = [
      ...graph.getClaimsByPhase('proposed'),
      ...graph.getClaimsByPhase('under_investigation'),
      ...graph.getClaimsByPhase('admitted'),
      ...graph.getClaimsByPhase('demoted'),
    ]
    const admitted = graph.getClaimsByPhase('admitted')

    // 1. Admission rate (30%) — dual-track: main claims weighted 70%
    const mainClaims = graph
      .getMainClaims()
      .filter(
        c =>
          c.phase !== 'rejected' &&
          c.phase !== 'retracted' &&
          c.phase !== 'reformulated',
      )
    const mainAdmitted = mainClaims.filter(c => c.phase === 'admitted')
    const mainRate =
      mainClaims.length > 0 ? mainAdmitted.length / mainClaims.length : 0

    const nonMain = allClaims.filter(c => !c.is_main)
    const nonMainAdmitted = nonMain.filter(c => c.phase === 'admitted')
    const supportRate =
      nonMain.length > 0 ? nonMainAdmitted.length / nonMain.length : 0

    const admissionRate =
      mainClaims.length > 0
        ? mainRate * 0.7 + supportRate * 0.3
        : allClaims.length > 0
          ? admitted.length / allClaims.length
          : 0

    // 2. Evidence coverage (30%) — dual-track with main claim priority
    const admittedIds = admitted.map(c => c.id)
    const claimTypes = new Map(admitted.map(c => [c.id, c.type]))
    const overallCoverage = pool.coverageRate(admittedIds, claimTypes)

    const mainAdmittedIds = mainAdmitted.map(c => c.id)
    const mainClaimTypes = new Map(mainAdmitted.map(c => [c.id, c.type]))
    const mainCoverage =
      mainAdmittedIds.length > 0
        ? pool.coverageRate(mainAdmittedIds, mainClaimTypes)
        : 0

    const nonMainAdmittedIds = nonMainAdmitted.map(c => c.id)
    const nonMainClaimTypes = new Map(nonMainAdmitted.map(c => [c.id, c.type]))
    const nonMainCoverage =
      nonMainAdmittedIds.length > 0
        ? pool.coverageRate(nonMainAdmittedIds, nonMainClaimTypes)
        : 0

    const coverage =
      mainClaims.length > 0
        ? mainCoverage * 0.7 + nonMainCoverage * 0.3
        : overallCoverage

    // 3. Structural vulnerability (20%) — inverse of max vulnerability
    //    If no active claims exist, vulnerability is vacuously 1 (worst) to avoid
    //    inflating the score on an empty graph.
    const bridges = graph.findWeakestBridges()
    const maxVuln =
      allClaims.length === 0
        ? 1
        : bridges.length > 0
          ? bridges[0].vulnerability
          : 0

    // 4. Trajectory momentum (20%) — less churn = more converged
    const recentEntries = state.trajectory.slice(-5)
    const recentDeltas = recentEntries.map(entry => {
      const delta = entry.claim_graph_delta
      if (!delta) return 10 // default high churn for entries without delta
      return (
        (delta.claims_added ?? 0) +
        (delta.claims_demoted ?? 0) +
        (delta.claims_rejected ?? 0)
      )
    })
    const avgDelta =
      recentDeltas.length > 0
        ? recentDeltas.reduce((sum, d) => sum + d, 0) / recentDeltas.length
        : 10

    // Weighted score
    const score =
      admissionRate * 0.3 +
      coverage * 0.3 +
      (1 - Math.min(1, maxVuln)) * 0.2 +
      Math.max(0, 1 - avgDelta / 3) * 0.2

    // Paper readiness from score thresholds (lowered in exploratory stance)
    const exploratory = stance === 'exploratory'
    const readyThreshold = exploratory ? 0.6 : 0.8
    const nearlyReadyThreshold = exploratory ? 0.4 : 0.6
    const needsWorkThreshold = exploratory ? 0.25 : 0.4

    let paperReadiness: StabilityMetrics['paperReadiness'] = 'not_ready'
    if (score > readyThreshold) {
      paperReadiness = 'ready'
    } else if (score > nearlyReadyThreshold) {
      paperReadiness = 'nearly_ready'
    } else if (score > needsWorkThreshold) {
      paperReadiness = 'needs_work'
    }

    // Weakest bridge for reporting
    const weakestBridge =
      bridges.length > 0
        ? {
            claimId: bridges[0].claim.id,
            vulnerability: bridges[0].vulnerability,
          }
        : null

    const stats = graph.getStatistics()

    return {
      convergenceScore: Math.max(0, Math.min(1, score)),
      admittedClaimCount: stats.admitted,
      proposedClaimCount: stats.proposed,
      weakestBridge,
      paperReadiness,
      evidenceCoverage: coverage,
      lastArbiterAssessment: '',
    }
  }
}
