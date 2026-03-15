// ── Entry Types ─────────────────────────────────────

export type KnowledgeEntryType =
  | 'theorem'
  | 'proposition'
  | 'lemma'
  | 'corollary'
  | 'definition'
  | 'algorithm'
  | 'result'

export interface EntrySource {
  id: string
  chapter: string
  section: string
  page: number
}

export interface EntryAssumption {
  id: string
  text: string
  strength: 'standard' | 'technical' | 'strong' | 'necessary_and_sufficient'
}

export interface EntryUsability {
  citable: boolean
  cite_as?: string
  common_use: string
  adaptation_notes?: string
}

export interface EntryRelations {
  depends_on: string[]
  used_by: string[]
  generalizes: string | null
  specialized_by: string[]
}

export type ProofDifficulty = 'elementary' | 'moderate' | 'advanced' | 'deep'

export interface KnowledgeEntry {
  id: string
  type: KnowledgeEntryType
  source: EntrySource
  label: string
  name: string

  statement: string

  // Theorem-specific fields (optional for non-theorem types)
  assumptions?: EntryAssumption[]
  proof_sketch?: string
  proof_technique?: string
  proof_difficulty?: ProofDifficulty
  full_proof_ref?: string
  full_proof_tokens?: number

  // Algorithm-specific fields
  pseudocode?: string
  complexity?: string
  inputs?: string
  outputs?: string

  // Result-specific fields
  experiment_setup?: string
  key_numbers?: string
  why_classic?: string

  usability: EntryUsability
  relations: EntryRelations
  tags: string[]
}

/** Input type for creating entries — auto-fields omitted. */
export type KnowledgeEntryInput = Omit<KnowledgeEntry, 'id'>

// ── Connections ──────────────────────────────────────

export type ConnectionRelation =
  | 'depends_on'
  | 'generalized_by'
  | 'specializes'
  | 'justified_by'
  | 'evaluates'
  | 'related_to'

export interface ConnectionEdge {
  from: string
  to: string
  relation: ConnectionRelation
}

export interface ConnectionGraph {
  edges: ConnectionEdge[]
}

// ── Registries ───────────────────────────────────────

export interface DatasetEntry {
  name: string
  description: string
  access: string
  accessible?: boolean
  source_paper?: string
  format?: string
  size?: string
}

export interface BenchmarkEntry {
  name: string
  description: string
  standard_metrics: string[]
  standard_baselines: string[]
  source: string
}

export interface CodebaseEntry {
  name: string
  repo_url: string
  language: string
  implements: string
  last_updated?: string
  stars?: number
}

export interface DKPRegistries {
  datasets: DatasetEntry[]
  benchmarks: BenchmarkEntry[]
  codebases: CodebaseEntry[]
}

// ── Indices ──────────────────────────────────────────

/** by-type.json: entry IDs grouped by KnowledgeEntryType */
export type TypeIndex = Record<KnowledgeEntryType, string[]>

/** by-topic.json: entry IDs grouped by tag */
export type TopicIndex = Record<string, string[]>

/** by-source.json: entry IDs grouped by source ID */
export type SourceIndex = Record<string, string[]>

/** full-text.json: keyword → entry IDs for search */
export type FullTextIndex = Record<string, string[]>

export interface DKPIndices {
  byType: TypeIndex
  byTopic: TopicIndex
  bySource: SourceIndex
  fullText: FullTextIndex
}

// ── Directions ───────────────────────────────────────

export interface DirectionSummary {
  id: string
  name: string
  summary: string
  entry_count: number
  key_entries: string[]
}

// ── Manifest ─────────────────────────────────────────

export interface DKPSourceRef {
  id: string
  title: string
  authors: string[]
  year: number
}

export interface DKPManifest {
  id: string
  name: string
  version: string
  description: string

  sources: {
    textbooks: DKPSourceRef[]
    papers: DKPSourceRef[]
  }

  stats: {
    entries_total: number
    theorems: number
    definitions: number
    algorithms: number
    results: number
    datasets: number
    benchmarks: number
    codebases: number
  }

  context_sizes: {
    l0_overview_tokens: number
    l1_directions_tokens: number
    l2_entry_avg_tokens: number
  }

  built_at: string
  built_with: string
}

// ── Build Config ─────────────────────────────────────

export interface TextbookConfig {
  path: string
  id: string
  focus_chapters?: number[]
}

export interface PaperSourceConfig {
  id: string
  path?: string
  source?: 'semantic_scholar' | 'arxiv'
}

export interface ExtraSearchConfig {
  query: string
  max_results: number
  year_from?: number
}

export interface DKPBuildConfig {
  name: string
  description: string
  textbooks?: TextbookConfig[]
  papers?: PaperSourceConfig[]
  extra_searches?: ExtraSearchConfig[]
  registries?: {
    search_datasets?: boolean
    search_benchmarks?: boolean
    search_codebases?: boolean
  }
}

// ── Loaded State ─────────────────────────────────────

export interface LoadedDKP {
  manifest: DKPManifest
  packDir: string
  overview: string
  directions: DirectionSummary[]
  indices: DKPIndices
  registries: DKPRegistries
}

// ── Constants ────────────────────────────────────────

/** Global knowledge packs storage directory */
export const DKP_GLOBAL_DIR = '.claude-paper/knowledge-packs'

/** Sub-paths within a knowledge pack directory */
export const DKP_PATHS = {
  manifest: 'manifest.json',
  sources: {
    textbooks: 'sources/textbooks.json',
    papers: 'sources/papers.json',
  },
  knowledge: {
    overview: 'knowledge/overview.md',
    directions: 'knowledge/directions',
    entries: 'knowledge/entries',
    connections: 'knowledge/connections.json',
  },
  registries: {
    datasets: 'registries/datasets.json',
    benchmarks: 'registries/benchmarks.json',
    codebases: 'registries/codebases.json',
  },
  index: {
    byType: 'index/by-type.json',
    byTopic: 'index/by-topic.json',
    bySource: 'index/by-source.json',
    fullText: 'index/full-text.json',
  },
} as const
