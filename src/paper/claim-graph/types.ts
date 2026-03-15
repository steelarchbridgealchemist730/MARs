// ── Claim Types ─────────────────────────────────────────

export type ClaimType =
  | 'observation'
  | 'assumption'
  | 'hypothesis'
  | 'theorem'
  | 'algorithmic'
  | 'empirical'
  | 'novelty'
  | 'benchmark'
  | 'limitation'

export type EpistemicLayer =
  | 'observation'
  | 'explanation'
  | 'exploitation'
  | 'justification'

export type ClaimPhase =
  | 'proposed'
  | 'under_investigation'
  | 'admitted'
  | 'demoted'
  | 'rejected'
  | 'retracted'
  | 'reformulated'

export type EvidenceStrengthType =
  | 'theorem_support'
  | 'empirical_support'
  | 'heuristic_motivation'
  | 'ablation_support'
  | 'consistent_with'
  | 'no_support'

export interface ClaimStrength {
  confidence: number // 0-1
  evidenceType: EvidenceStrengthType
  vulnerabilityScore: number // 0-1, higher = more vulnerable
}

export interface AssessmentEntry {
  timestamp: string
  assessor: 'builder' | 'skeptic' | 'arbiter'
  previous_strength: ClaimStrength
  new_strength: ClaimStrength
  reason: string
}

export interface Claim {
  id: string
  type: ClaimType
  epistemicLayer: EpistemicLayer
  statement: string
  phase: ClaimPhase
  evidence: { grounded: string[]; derived: string[] }
  strength: ClaimStrength
  created_at: string
  created_by: string
  last_assessed_at: string
  assessment_history: AssessmentEntry[]
  /** True for claims derived from proposal innovations. */
  is_main?: boolean
  /** Depth in the claim tree. Main claims = 0, their sub-claims = 1, etc. */
  depth?: number
  /** ID of the root main claim this sub-claim supports. */
  root_main_id?: string
  /** ID of the successor claim this was reformulated into. */
  reformulated_into?: string
  /** ID of the predecessor claim this was reformulated from. */
  reformulated_from?: string
  /** Number of times this claim lineage has been reformulated (0 = original). */
  reformulation_count?: number
}

// ── Edge Types ──────────────────────────────────────────

export type ClaimRelation =
  | 'supports'
  | 'depends_on'
  | 'contradicts'
  | 'motivates'
  | 'refines'
  | 'generalizes'
  | 'bridges'
  | 'supersedes'

export interface ClaimEdge {
  id: string
  source: string // claim ID
  target: string // claim ID
  relation: ClaimRelation
  strength: 'strong' | 'moderate' | 'weak' | 'conjectured'
  note?: string
}

// ── Serializable Data ───────────────────────────────────

export interface ClaimGraphData {
  claims: Claim[]
  edges: ClaimEdge[]
}

// ── Analysis Result Types ───────────────────────────────

export interface WeakestBridgeResult {
  claim: Claim
  vulnerability: number
  cascadeSize: number
}

export interface LayerSkipResult {
  edge: ClaimEdge
  description: string
}

export interface ContradictionResult {
  claim: Claim
  contradicting_edges: ClaimEdge[]
  conflicting_evidence: boolean
}

export interface RecentChangeResult {
  claim: Claim
  change: string
}

export interface ClaimGraphStatistics {
  total: number
  admitted: number
  proposed: number
  investigating: number
  demoted: number
  rejected: number
  retracted: number
  reformulated: number
  // by layer
  observations: number
  explanations: number
  exploitations: number
  justifications: number
  // edges
  totalEdges: number
  dependsOn: number
  supports: number
  contradicts: number
  motivates: number
  refines: number
  generalizes: number
  bridges: number
  supersedes: number
}

// ── Constants ───────────────────────────────────────────

export const EPISTEMIC_LAYER_ORDER: Record<EpistemicLayer, number> = {
  observation: 0,
  explanation: 1,
  exploitation: 2,
  justification: 3,
}
