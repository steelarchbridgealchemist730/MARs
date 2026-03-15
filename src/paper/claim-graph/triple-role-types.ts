/** Builder LLM structured output. */
export interface BuilderOutput {
  narrative: string
  new_claims_proposed: Array<{
    id?: string
    type: string
    epistemicLayer: string
    statement: string
    confidence?: number
    evidence_direction?: string
  }>
  new_edges_proposed: Array<{
    source_id: string
    target_id: string
    relation: string
    strength: string
  }>
  recommended_next_actions: Array<{
    action: string
    delegate_to: string
    priority: string
  }>
  reformulation_suggestions?: Array<{
    claim_id: string
    reason: string
    suggested_statement: string
    suggested_type?: string
    suggested_layer?: string
    evidence_basis: string
  }>
}

/** Skeptic LLM structured output. */
export interface SkepticOutput {
  internal_inconsistencies: Array<{
    description: string
    claim_ids: string[]
  }>
  bridge_gaps: Array<{
    from_claim: string
    to_claim: string
    severity: string
    description: string
  }>
  evidence_inflation: Array<{
    claim_id: string
    claimed_strength: string
    actual_strength: string
    reason: string
  }>
  theorem_overreach: Array<{
    claim_id: string
    issue: string
  }>
  top3_collapse_points: Array<{
    claim_id: string
    vulnerability: number
    cascade_size: number
    falsification_experiment: string
  }>
  admission_denials: Array<{
    claim_id: string
    reason: string
    suggested_destination: string
  }>
  reformulation_opportunities?: Array<{
    claim_id: string
    current_statement: string
    evidence_suggests: string
    suggested_direction: string
    confidence_in_alternative: number
  }>
}

/** Arbiter LLM structured output. */
export interface ArbiterOutput {
  claim_updates: Array<{
    claim_id: string
    action: 'admit' | 'demote' | 'reject' | 'contract' | 'keep' | 'reformulate'
    new_confidence?: number
    reason: string
  }>
  contracted_claims: Array<{
    claim_id: string
    new_layer: string
    contracted_statement: string
  }>
  next_action: {
    action: string
    delegate_to: string
    context: string
    priority: string
    estimated_cost_usd: number
    if_this_fails: string
    targets_claim?: string
    related_claims?: string[]
    experiment_tier?: 1 | 2
  }
  reformulated_claims?: Array<{
    claim_id: string
    new_statement: string
    new_type?: string
    new_layer?: string
    evidence_basis: string
    rationale: string
  }>
  overall_assessment: string
}
