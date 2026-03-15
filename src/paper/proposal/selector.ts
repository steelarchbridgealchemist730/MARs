import type { Proposal } from './types'

// Selects the best proposal automatically (for /auto mode)
export function selectBestProposal(proposals: Proposal[]): Proposal {
  return proposals.sort(
    (a, b) =>
      b.novelty_score * 0.3 +
      b.feasibility.score * 0.5 +
      b.impact_score * 0.2 -
      (a.novelty_score * 0.3 +
        a.feasibility.score * 0.5 +
        a.impact_score * 0.2),
  )[0]!
}
