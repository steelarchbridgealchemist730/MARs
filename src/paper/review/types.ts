export type ReviewScore = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

export interface ReviewDimensions {
  originality: ReviewScore
  significance: ReviewScore
  soundness: ReviewScore
  clarity: ReviewScore
  reproducibility: ReviewScore
  prior_work: ReviewScore
  contribution: ReviewScore
}

export interface DetailedPoint {
  aspect: string
  detail: string
  location?: string // e.g. "Section 3, Equation 2"
}

export interface ReviewReport {
  reviewer_id: string
  model_used: string
  dimensions: ReviewDimensions
  overall_score: number // weighted average
  decision: 'accept' | 'minor_revision' | 'major_revision' | 'reject'
  confidence: 1 | 2 | 3 | 4 | 5
  summary: string
  strengths: DetailedPoint[]
  weaknesses: DetailedPoint[]
  questions: string[]
  missing_references: string[]
  minor_issues: string[]
  actionable_suggestions: string[]
  rubric_result?: RubricReviewResult
}

export interface RubricSummary {
  items: RubricItem[]
  aggregated: Array<{
    rubric_id: string
    statement: string
    verdicts: RubricVerdict[]
    consensus_verdict: RubricVerdict
    assignee: RubricAssignee
    weight: number
  }>
  overall_weighted_pass_rate: number
  failed_items: Array<{
    rubric_id: string
    statement: string
    assignee: RubricAssignee
    action: string
  }>
}

export interface MetaReview {
  average_score: number
  decision: 'accept' | 'minor_revision' | 'major_revision' | 'reject'
  consensus_level: 'high' | 'medium' | 'low'
  key_issues: Array<{
    priority: 'critical' | 'major' | 'minor'
    description: string
    action: string
    assignee: 'math-reasoner' | 'experiment-runner' | 'writer' | 'any'
  }>
  reviews: ReviewReport[]
  rubric_summary?: RubricSummary
}

export interface ReviewConfig {
  num_reviewers?: number // default 3
  max_rounds?: number // default 3
  acceptance_threshold?: number // default 7.0
  strength?: 'light' | 'standard' | 'thorough' | 'brutal'
  models?: string[] // reviewer models, defaults to main model
  grounded?: boolean // search recent literature to ground the review in current state of the art
  rubric?: boolean // default true; set false to skip rubric stage
}

// ── Rubric Types ──────────────────────────────────────

export type RubricVerdict = 'pass' | 'partial' | 'fail'

export type RubricCategory =
  | 'claim_support'
  | 'methodology'
  | 'reproducibility'
  | 'novelty'
  | 'clarity'
  | 'completeness'
  | 'consistency'
  | 'rigor'

export type RubricAssignee =
  | 'math-reasoner'
  | 'experiment-runner'
  | 'writer'
  | 'any'

export interface RubricItem {
  id: string // "R01", "R02", ...
  statement: string // atomic — no 'and'/'both'
  category: RubricCategory
  weight: number // 0-1, all weights sum to 1.0
  claim_id?: string // optional link to ClaimGraph claim
  assignee: RubricAssignee
}

export interface Rubric {
  items: RubricItem[]
  generated_at: string
  paper_type: 'theoretical' | 'empirical' | 'mixed'
  proposal_title: string
}

export interface RubricAssessment {
  rubric_id: string
  verdict: RubricVerdict
  justification: string
  location?: string
}

export interface RubricReviewResult {
  assessments: RubricAssessment[]
  weighted_pass_rate: number // pass=full weight, partial=half, fail=0
  fail_count: number
  partial_count: number
  pass_count: number
}
