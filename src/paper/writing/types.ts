export interface FigurePlan {
  id: string // e.g. "fig1"
  caption: string
  type: 'matplotlib' | 'tikz' | 'pgfplots' | 'imported'
  source_file?: string // path to PNG/PDF if imported
  description: string
}

export interface TablePlan {
  id: string // e.g. "tab1"
  caption: string
  source_csv?: string // path to CSV file
  description: string
}

export interface PaperOutline {
  title: string
  authors: string[]
  venue: string // e.g. "NeurIPS 2026"
  template: string // e.g. "neurips"
  sections: Array<{
    name: string
    title: string
    word_budget: number
  }>
  figures: FigurePlan[]
  tables: TablePlan[]
  estimated_pages: number
}

export interface WritingState {
  outline: PaperOutline
  completed_sections: string[]
  tex_path: string
  pdf_path?: string
  last_compile_success: boolean
  last_error?: string
}

// ── Narrative Planner Types ─────────────────────────────

export interface NarrativeArc {
  hook: string
  gap: string
  insight: string
  method_summary: string
  evidence_summary: string
  nuance: string
}

export interface HeroFigurePlan {
  description: string
  components: string[]
  placement: string
  estimated_height: string
}

export interface MainTablePlan {
  content: string
  experiments_used: string[]
  placement: string
  caption_draft: string
}

export interface NarrativeSectionPlan {
  name: string
  title: string
  page_budget: number
  claims_covered: string[]
  key_points: string[]
  tone: string
  ends_with?: string
  experiments_used?: string[]
  contains_hero_figure?: boolean
  contains_main_table?: boolean
  must_cite?: string[]
  demoted_claims_here?: string[]
}

export interface AppendixSectionPlan {
  name: string
  source_fragment?: string
  source_experiments?: string[]
}

export interface NarrativePlan {
  narrative_arc: NarrativeArc
  hero_figure: HeroFigurePlan | null
  main_table: MainTablePlan | null
  sections: NarrativeSectionPlan[]
  appendix_sections: AppendixSectionPlan[]
}

// ── Section Writer Types (W4) ───────────────────────────

export interface ClaimMaterial {
  id: string
  statement: string
  epistemicLayer: string
  type: string
  confidence: number
  evidenceType: string
}

export interface EvidenceMaterial {
  claim_id: string
  type: 'grounded' | 'derived'
  description: string
}

export interface SectionMaterials {
  claims: ClaimMaterial[]
  demotedClaims: ClaimMaterial[]
  evidence: EvidenceMaterial[]
  experimentResults: string | null
  fragments: Array<{ id: string; title: string; preview: string }>
  mustCite: string[]
  relatedWork?: string
}

export interface PostProcessResult {
  latex: string
  warnings: string[]
}

// ── LaTeX Engine Types (W5) ──────────────────────────────

export type DiagnosisSeverity = 'error' | 'warning'

export type DiagnosisIssueType =
  | 'undefined_citation'
  | 'undefined_reference'
  | 'undefined_command'
  | 'overfull_hbox'
  | 'overfull_vbox'
  | 'syntax_error'
  | 'missing_file'
  | 'package_error'
  | 'missing_package'
  | 'math_error'

export interface DiagnosisIssue {
  type: DiagnosisIssueType
  severity: DiagnosisSeverity
  message: string
  file?: string
  line?: number
  context?: string
  autoFixable: boolean
  // Type-specific optional fields
  citeKey?: string // undefined_citation
  refLabel?: string // undefined_reference
  command?: string // undefined_command
  missingFile?: string // missing_file
  packageName?: string // missing_package / package_error
  overflow_pt?: number // overfull_hbox / overfull_vbox
}

export interface CompilationAttempt {
  success: boolean
  issues: DiagnosisIssue[]
  warnings: string[]
  pdfPath: string | null
  logExcerpt?: string
}

export interface CompilationResult {
  success: boolean
  attempts: number
  history: CompilationAttempt[]
  pdfPath?: string
  warnings: string[]
  unresolvedIssues: DiagnosisIssue[]
}

export interface Diagnosis {
  issues: DiagnosisIssue[]
  errorCount: number
  warningCount: number
}

export interface PageCheckResult {
  passed: boolean
  totalPages: number
  mainBodyPages: number
  limit: number | 'unlimited'
  overBy: number
  suggestion?: string
}

export interface CutSuggestion {
  section: string
  action: string
  estimated_savings_words: number
  risk_level: 'low' | 'medium' | 'high'
}

// ── Writing Pipeline Types (W7) ─────────────────────────

export type WritingPipelinePhase =
  | 'plan'
  | 'bibliography'
  | 'write_sections'
  | 'figures'
  | 'assemble'
  | 'compile'
  | 'page_check'
  | 'final_sync'

export interface WritingPipelineResult {
  success: boolean
  pdfPath?: string
  plan?: NarrativePlan
  pageCheck?: PageCheckResult
  cutSuggestions?: CutSuggestion[]
  warnings: string[]
  compilationResult?: CompilationResult
  phases_completed: WritingPipelinePhase[]
}

// ── Figure Designer Types (W6) ──────────────────────────

export type FigureApproach = 'tikz' | 'matplotlib' | 'combined'

export interface FigureOutput {
  approach: FigureApproach
  code: string // TikZ code or matplotlib script
  caption: string
  label: string // "fig:overview"
  dependencies: string[] // ["tikz", "pgfplots"]
  filePath?: string // generated .tex or .png
  fragmentId?: string
}

export interface TableOutput {
  code: string // LaTeX tabular environment
  caption: string
  label: string // "tab:main-results"
  dependencies: string[] // ["booktabs"]
  filePath?: string
  fragmentId?: string
}

export interface FigureMaterials {
  claimDescriptions: string[]
  experimentData: string | null // raw CSV/JSON from artifacts
  experimentSummaries: string[]
  existingFigures: string[]
  narrativeArc: { hook: string; insight: string; method_summary: string }
}

export interface FigureDesignDecision {
  approach: FigureApproach
  reasoning: string
  layout: 'single_column' | 'double_column'
  subfigures: number
  colorScheme: string
}
