export interface ResearchPlan {
  topic: string
  dimensions: ResearchDimension[]
  key_authors: string[]
  key_venues: string[] // journals/conferences
  completion_criteria: string
  created_at: string
}

export interface ResearchDimension {
  name: string
  queries: {
    precise: string[] // term-level
    broad: string[] // domain-level
    cross_domain: string[] // interdisciplinary
  }
}

export interface DiscoveredPaper {
  title: string
  authors: string[]
  year: number
  abstract: string
  source: 'arxiv' | 'semantic_scholar' | 'ssrn' | 'other'
  source_id: string // arXiv ID, S2 paper ID, SSRN ID
  arxiv_id?: string
  s2_paper_id?: string
  ssrn_id?: string
  doi?: string
  url?: string
  pdf_url?: string
  citation_count: number
  relevance_score: number // 0-1
}

export interface AcquisitionResult {
  paper: DiscoveredPaper
  status: 'downloaded' | 'oa_found' | 'abstract_only' | 'failed'
  pdf_path?: string
  source_used?: string
}

export interface ResearchIndex {
  project_dir: string
  papers: DiscoveredPaper[]
  acquired: AcquisitionResult[]
  pqa_indexed: boolean
}

export interface DeepResearchOptions {
  depth?: 'quick' | 'standard' | 'thorough'
  max_papers?: number
  since_year?: number
  continue_from?: string // project dir to continue
  extend_discovery?: boolean // re-run discovery phase when continuing
  focus?: string
  // Acquisition config (from onboarding access settings)
  ezproxy_url?: string
  scihub_enabled?: boolean
  scihub_mirrors?: string[]
  unpaywall_email?: string
}

export interface BatchSummary {
  batch_index: number
  paper_count: number
  paper_titles: string[]
  summary: string
}

export interface DeepResearchResult {
  plan: ResearchPlan
  papers_found: number
  papers_acquired: number
  survey_path: string
  gaps_path: string
  taxonomy_path: string
  timeline_path: string
  index_dir: string
}
