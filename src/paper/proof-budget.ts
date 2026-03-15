import type { ResearchState } from './research-state'

// ── Types ────────────────────────────────────────────────

export type TheoremImportance = 'core' | 'supporting' | 'auxiliary'

export type VenueRigor = 'high' | 'medium' | 'low'

export interface TheoremSpec {
  id: string
  statement: string
  importance: TheoremImportance
  dependencies: string[] // other theorem/lemma ids
}

export interface ProofBudgetDecision {
  target_rigor: 'sketch' | 'semi_formal' | 'formal' | 'appendix_level'
  max_depth_rounds: number
  assumption_tolerance: 'strict' | 'reasonable' | 'pragmatic'
  estimated_cost_usd: number
  reasoning: string
}

// ── Venue Rigor Mapping ──────────────────────────────────

const VENUE_RIGOR: Record<string, VenueRigor> = {
  ICML: 'high',
  NeurIPS: 'medium',
  ICLR: 'medium',
  AAAI: 'medium',
  ACL: 'medium',
  EMNLP: 'medium',
  CVPR: 'medium',
  JMLR: 'high',
  'Annals of Statistics': 'high',
  workshop: 'low',
}

function getVenueRigor(venue: string): VenueRigor {
  // Check exact match first
  if (venue in VENUE_RIGOR) return VENUE_RIGOR[venue]

  // Check partial match
  const lower = venue.toLowerCase()
  for (const [key, rigor] of Object.entries(VENUE_RIGOR)) {
    if (lower.includes(key.toLowerCase())) return rigor
  }

  return 'medium' // default
}

// ── ProofBudgetController ────────────────────────────────

/**
 * Decides how rigorously each proof should be pursued,
 * based on theorem importance, venue requirements, and remaining budget.
 *
 * Decision matrix (from spec Section 9):
 *
 * | Importance | Venue Rigor | Budget OK | → rigor       | rounds | tolerance  |
 * |------------|-------------|-----------|---------------|--------|------------|
 * | core       | high        | yes       | formal        | 5      | reasonable |
 * | core       | high        | no        | semi_formal   | 3      | pragmatic  |
 * | core       | medium      | yes       | semi_formal   | 4      | reasonable |
 * | core       | medium      | no        | semi_formal   | 3      | pragmatic  |
 * | core       | low         | any       | semi_formal   | 2      | pragmatic  |
 * | supporting | any         | yes       | semi_formal   | 2      | pragmatic  |
 * | supporting | any         | no        | sketch        | 1      | pragmatic  |
 * | auxiliary  | any         | any       | sketch        | 1      | pragmatic  |
 */
export class ProofBudgetController {
  decideRigor(theorem: TheoremSpec, state: ResearchState): ProofBudgetDecision {
    const venue = this.extractVenue(state)
    const venueRigor = getVenueRigor(venue)
    const budgetOk = this.isBudgetSufficient(state)
    const paperType = state.paper_type

    // Theoretical papers need more rigor
    const theoryBoost = paperType === 'theoretical' ? 1 : 0

    let target_rigor: ProofBudgetDecision['target_rigor']
    let max_depth_rounds: number
    let assumption_tolerance: ProofBudgetDecision['assumption_tolerance']

    if (theorem.importance === 'auxiliary') {
      // Auxiliary: always sketch
      target_rigor = 'sketch'
      max_depth_rounds = 1
      assumption_tolerance = 'pragmatic'
    } else if (theorem.importance === 'supporting') {
      // Supporting: semi_formal if budget allows, else sketch
      if (budgetOk) {
        target_rigor = 'semi_formal'
        max_depth_rounds = 2 + theoryBoost
        assumption_tolerance = 'pragmatic'
      } else {
        target_rigor = 'sketch'
        max_depth_rounds = 1
        assumption_tolerance = 'pragmatic'
      }
    } else {
      // Core theorem
      if (venueRigor === 'high' && budgetOk) {
        target_rigor = 'formal'
        max_depth_rounds = 5 + theoryBoost
        assumption_tolerance = 'reasonable'
      } else if (venueRigor === 'high' && !budgetOk) {
        target_rigor = 'semi_formal'
        max_depth_rounds = 3
        assumption_tolerance = 'pragmatic'
      } else if (venueRigor === 'medium' && budgetOk) {
        target_rigor = 'semi_formal'
        max_depth_rounds = 4 + theoryBoost
        assumption_tolerance = 'reasonable'
      } else if (venueRigor === 'medium' && !budgetOk) {
        target_rigor = 'semi_formal'
        max_depth_rounds = 3
        assumption_tolerance = 'pragmatic'
      } else {
        // low venue rigor
        target_rigor = 'semi_formal'
        max_depth_rounds = 2
        assumption_tolerance = 'pragmatic'
      }
    }

    // Check assumption-reality gaps from existing proofs (spec §9.1)
    let gapNote = ''
    for (const proof of state.theory.proofs) {
      const significantGaps = proof.assumption_reality_gaps.filter(
        g => g.gap_severity === 'significant' || g.gap_severity === 'critical',
      )
      if (significantGaps.length > 0) {
        const hasCritical = significantGaps.some(
          g => g.gap_severity === 'critical',
        )

        // For core theorems with significant gaps: enforce strict tolerance
        if (theorem.importance === 'core' && !hasCritical) {
          assumption_tolerance = 'strict'
          gapNote = ` Significant assumption-reality gaps detected in prior proofs; enforcing strict tolerance.`
        }

        // For critical gaps: reduce investment (max_depth_rounds - 1)
        if (hasCritical) {
          max_depth_rounds = Math.max(1, max_depth_rounds - 1)
          gapNote = ` Critical assumption-reality gap detected; reducing proof depth investment.`
        }

        // Only need to process the first proof with significant gaps
        break
      }
    }

    // Estimate cost based on rounds × model cost
    const cost_per_round = 2.0 // ~$2 per round with reasoning model
    const estimated_cost_usd = max_depth_rounds * cost_per_round

    return {
      target_rigor,
      max_depth_rounds,
      assumption_tolerance,
      estimated_cost_usd,
      reasoning:
        this.buildReasoning(
          theorem,
          venue,
          venueRigor,
          budgetOk,
          target_rigor,
        ) + gapNote,
    }
  }

  private extractVenue(state: ResearchState): string {
    // Check proposal title and methodology for known venue names
    const searchText = `${state.proposal.title} ${state.proposal.methodology}`
    const knownVenues = [
      'ICML',
      'NeurIPS',
      'ICLR',
      'AAAI',
      'ACL',
      'EMNLP',
      'CVPR',
      'JMLR',
      'Annals of Statistics',
      'workshop',
    ]
    for (const venue of knownVenues) {
      if (searchText.toLowerCase().includes(venue.toLowerCase())) {
        return venue
      }
    }
    // Default to NeurIPS as a reasonable default for ML papers
    return 'NeurIPS'
  }

  private isBudgetSufficient(state: ResearchState): boolean {
    // Budget is sufficient if we have >30% remaining
    const pctRemaining =
      (state.budget.remaining_usd / state.budget.total_usd) * 100
    return pctRemaining > 30
  }

  private buildReasoning(
    theorem: TheoremSpec,
    venue: string,
    venueRigor: VenueRigor,
    budgetOk: boolean,
    targetRigor: string,
  ): string {
    return (
      `Theorem "${theorem.statement.slice(0, 50)}..." is ${theorem.importance} ` +
      `for ${venue} (${venueRigor} rigor). ` +
      `Budget ${budgetOk ? 'sufficient' : 'tight'}. ` +
      `Target: ${targetRigor}.`
    )
  }
}
