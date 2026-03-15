export interface Proposal {
  id: string
  title: string
  abstract: string
  innovation: string[] // bullet points of novel contributions
  methodology: string // high-level approach
  feasibility: {
    data_required: string
    compute_estimate: string
    timeline_weeks: number
    score: number // 0-1
  }
  risk: {
    level: 'low' | 'medium' | 'high'
    description: string
  }
  novelty_score: number // 0-1
  impact_score: number // 0-1
  references: string[] // key papers that support this
  created_at: string
}

export interface ProposalGenerationOptions {
  count?: number // default 3
  focus?: string // optional direction constraint
  include_feasibility?: boolean
  include_risk?: boolean
  research_dir?: string // path to .claude-paper-research dir
}
