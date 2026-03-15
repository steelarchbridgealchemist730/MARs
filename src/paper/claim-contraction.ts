import type { ClaimGraph } from './claim-graph/index'
import type { EpistemicLayer } from './claim-graph/types'

export interface ContractionSuggestion {
  current_claim: string
  current_layer: EpistemicLayer
  contracted_layer: EpistemicLayer | null
  strategy: string
  destination: 'main_text' | 'discussion_or_limitation'
  contracted_claim: null
}

const LAYER_DOWN: Record<EpistemicLayer, EpistemicLayer | null> = {
  justification: 'exploitation',
  exploitation: 'explanation',
  explanation: 'observation',
  observation: null,
}

const CONTRACTION_STRATEGY: Record<EpistemicLayer, string> = {
  justification: 'Remove theoretical backing, keep as heuristic method',
  exploitation: 'Remove method claim, report as observed relationship',
  explanation: 'Remove causal mechanism, report as correlation',
  observation: 'Already minimal — cannot contract further',
}

/**
 * Suggest how to contract (downgrade) a claim to a weaker epistemic layer
 * when evidence is insufficient for admission.
 * Pure function — the actual rewriting is done by an LLM later.
 */
export function suggestContraction(
  claimId: string,
  graph: ClaimGraph,
): ContractionSuggestion {
  const claim = graph.getClaim(claimId)
  if (!claim) throw new Error(`Claim not found: ${claimId}`)

  const contracted_layer = LAYER_DOWN[claim.epistemicLayer]
  const destination =
    contracted_layer === 'observation' || contracted_layer === null
      ? 'main_text'
      : 'discussion_or_limitation'

  return {
    current_claim: claim.statement,
    current_layer: claim.epistemicLayer,
    contracted_layer,
    strategy: CONTRACTION_STRATEGY[claim.epistemicLayer],
    destination,
    contracted_claim: null,
  }
}
