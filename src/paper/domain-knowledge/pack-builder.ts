import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import type {
  DKPBuildConfig,
  DKPManifest,
  DKPSourceRef,
  DKPIndices,
  TypeIndex,
  TopicIndex,
  SourceIndex,
  FullTextIndex,
  ConnectionGraph,
  ConnectionEdge,
  DirectionSummary,
  KnowledgeEntry,
  KnowledgeEntryType,
} from './types'
import { DKP_GLOBAL_DIR, DKP_PATHS } from './types'
import { EntryStore } from './entry-store'
import { TextbookParser } from './textbook-parser'
import { PaperParser } from './paper-parser'
import { RegistryBuilder } from './registry-builder'
import type { PDFExtractor } from '../pdf-extractor'
import { PaperAcquisitionChain } from '../acquisition'
import type { PaperMetadata } from '../acquisition'
import { chatCompletion } from '../llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import { estimateTokens } from '../claim-graph/token-utils'
import { repairTruncatedJSON } from '../json-repair'

// ── Types ───────────────────────────────────────────────

export type PackBuildProgress =
  | { type: 'phase'; phase: number; total: number; message: string }
  | { type: 'textbook_done'; id: string; entries: number }
  | { type: 'paper_done'; id: string; entries: number }
  | { type: 'paper_downloaded'; id: string; source: string }
  | { type: 'paper_download_failed'; id: string; reason: string }
  | { type: 'error'; message: string }

export interface PackBuildResult {
  packDir: string
  manifest: DKPManifest
  total_entries: number
  total_cost_usd: number
  errors: string[]
}

// ── Stop words for full-text index ──────────────────────

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'not',
  'no',
  'nor',
  'so',
  'if',
  'then',
  'than',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'we',
  'our',
  'they',
  'their',
  'he',
  'she',
  'his',
  'her',
  'as',
])

// ── Helpers ─────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// ── DKP Builder ─────────────────────────────────────────

export class DKPBuilder {
  constructor(
    private pdfExtractor: PDFExtractor,
    private globalPacksDir?: string,
  ) {}

  protected createTextbookParser(entryStore: EntryStore): TextbookParser {
    return new TextbookParser(entryStore, this.pdfExtractor)
  }

  protected createPaperParser(entryStore: EntryStore): PaperParser {
    return new PaperParser(entryStore, this.pdfExtractor)
  }

  protected createRegistryBuilder(packDir: string): RegistryBuilder {
    return new RegistryBuilder(packDir)
  }

  async build(
    config: DKPBuildConfig,
    onProgress?: (event: PackBuildProgress) => void,
  ): Promise<PackBuildResult> {
    const errors: string[] = []
    let totalCost = 0
    const TOTAL_PHASES = 8

    // ── Phase 1: Initialize pack directory ──────────────
    const baseDir = this.globalPacksDir || DKP_GLOBAL_DIR
    const packDir = join(baseDir, slugify(config.name))

    onProgress?.({
      type: 'phase',
      phase: 1,
      total: TOTAL_PHASES,
      message: 'Initializing pack directory...',
    })

    mkdirSync(join(packDir, DKP_PATHS.knowledge.entries), { recursive: true })
    mkdirSync(join(packDir, DKP_PATHS.knowledge.directions), {
      recursive: true,
    })
    mkdirSync(join(packDir, 'registries'), { recursive: true })
    mkdirSync(join(packDir, 'index'), { recursive: true })
    mkdirSync(join(packDir, 'sources'), { recursive: true })

    const entryStore = new EntryStore(packDir)
    entryStore.init()

    const textbookParser = this.createTextbookParser(entryStore)
    const paperParser = this.createPaperParser(entryStore)
    const registryBuilder = this.createRegistryBuilder(packDir)

    // ── Phase 2: Download papers without local paths ─────
    onProgress?.({
      type: 'phase',
      phase: 2,
      total: TOTAL_PHASES,
      message: 'Downloading papers...',
    })

    const pdfsDir = join(packDir, 'sources', 'pdfs')
    mkdirSync(pdfsDir, { recursive: true })

    const papersNeedingDownload = (config.papers ?? []).filter(
      p => !p.path && p.source,
    )

    if (papersNeedingDownload.length > 0) {
      const chain = new PaperAcquisitionChain({ output_dir: pdfsDir })

      for (const paper of papersNeedingDownload) {
        try {
          const meta: PaperMetadata = {
            title: paper.id,
            arxiv_id: paper.source === 'arxiv' ? paper.id : undefined,
          }
          const result = await chain.acquire(meta)
          if (result.success && result.pdf_path) {
            paper.path = result.pdf_path
            onProgress?.({
              type: 'paper_downloaded',
              id: paper.id,
              source: result.source_used || 'unknown',
            })
          } else {
            const reason = result.error || 'Could not download'
            errors.push(`Download ${paper.id}: ${reason}`)
            onProgress?.({
              type: 'paper_download_failed',
              id: paper.id,
              reason,
            })
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          errors.push(`Download ${paper.id}: ${reason}`)
          onProgress?.({
            type: 'paper_download_failed',
            id: paper.id,
            reason,
          })
        }
      }
    }

    // ── Phase 3: Parse textbooks ────────────────────────
    onProgress?.({
      type: 'phase',
      phase: 3,
      total: TOTAL_PHASES,
      message: 'Parsing textbooks...',
    })

    for (const textbook of config.textbooks ?? []) {
      try {
        const result = await textbookParser.parse(textbook, packDir)
        totalCost += result.cost_usd
        errors.push(...result.errors)
        onProgress?.({
          type: 'textbook_done',
          id: textbook.id,
          entries: result.entries_created,
        })
      } catch (err) {
        const msg = `Textbook ${textbook.id}: ${err instanceof Error ? err.message : String(err)}`
        errors.push(msg)
        onProgress?.({ type: 'error', message: msg })
      }
    }

    // ── Phase 4: Parse papers ───────────────────────────
    onProgress?.({
      type: 'phase',
      phase: 4,
      total: TOTAL_PHASES,
      message: 'Parsing papers...',
    })

    for (const paper of config.papers ?? []) {
      if (!paper.path) {
        const msg = `Paper ${paper.id}: no local path provided, skipping`
        errors.push(msg)
        onProgress?.({ type: 'error', message: msg })
        continue
      }

      try {
        const result = await paperParser.parse(paper, packDir)
        totalCost += result.cost_usd
        errors.push(...result.errors)
        registryBuilder.addFromPaperParse(result.registry_contributions)
        onProgress?.({
          type: 'paper_done',
          id: paper.id,
          entries: result.entries_created,
        })
      } catch (err) {
        const msg = `Paper ${paper.id}: ${err instanceof Error ? err.message : String(err)}`
        errors.push(msg)
        onProgress?.({ type: 'error', message: msg })
      }
    }

    // ── Phase 5: Build registries ───────────────────────
    onProgress?.({
      type: 'phase',
      phase: 5,
      total: TOTAL_PHASES,
      message: 'Building registries...',
    })

    try {
      const regResult = await registryBuilder.build(
        config.description,
        config.registries,
      )
      totalCost += regResult.cost_usd
    } catch (err) {
      const msg = `Registry build: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      onProgress?.({ type: 'error', message: msg })
    }

    // ── Phase 6: Build connection graph ─────────────────
    onProgress?.({
      type: 'phase',
      phase: 6,
      total: TOTAL_PHASES,
      message: 'Building connection graph...',
    })

    const allEntries = entryStore.loadAllEntries()
    const connectionGraph = buildConnectionGraph(allEntries)
    writeJSON(join(packDir, DKP_PATHS.knowledge.connections), connectionGraph)

    // ── Phase 7: Generate overview + directions ─────────
    onProgress?.({
      type: 'phase',
      phase: 7,
      total: TOTAL_PHASES,
      message: 'Generating overview and directions...',
    })

    let overview = ''
    let directions: DirectionSummary[] = []

    try {
      const overviewResult = await this.generateOverview(
        allEntries,
        config.description,
      )
      overview = overviewResult.text
      totalCost += overviewResult.cost
      writeFileSync(
        join(packDir, DKP_PATHS.knowledge.overview),
        overview,
        'utf-8',
      )
    } catch (err) {
      const msg = `Overview generation: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      onProgress?.({ type: 'error', message: msg })
      // Write empty overview
      mkdirSync(dirname(join(packDir, DKP_PATHS.knowledge.overview)), {
        recursive: true,
      })
      writeFileSync(join(packDir, DKP_PATHS.knowledge.overview), '', 'utf-8')
    }

    try {
      const dirResult = await this.generateDirections(
        allEntries,
        config.description,
      )
      directions = dirResult.directions
      totalCost += dirResult.cost

      for (const dir of directions) {
        writeFileSync(
          join(packDir, DKP_PATHS.knowledge.directions, `${dir.id}.md`),
          `# ${dir.name}\n\n${dir.summary}\n\n## Key Entries\n${dir.key_entries.map(e => `- ${e}`).join('\n')}\n`,
          'utf-8',
        )
      }

      // Write structured directions as JSON for the loader
      writeJSON(
        join(packDir, DKP_PATHS.knowledge.directions, 'directions.json'),
        directions,
      )
    } catch (err) {
      const msg = `Direction generation: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      onProgress?.({ type: 'error', message: msg })
    }

    // ── Phase 8: Build indices + write manifest ─────────
    onProgress?.({
      type: 'phase',
      phase: 8,
      total: TOTAL_PHASES,
      message: 'Building indices and manifest...',
    })

    const indices = buildIndices(allEntries)
    writeJSON(join(packDir, DKP_PATHS.index.byType), indices.byType)
    writeJSON(join(packDir, DKP_PATHS.index.byTopic), indices.byTopic)
    writeJSON(join(packDir, DKP_PATHS.index.bySource), indices.bySource)
    writeJSON(join(packDir, DKP_PATHS.index.fullText), indices.fullText)

    // Load registries for stats
    const datasetsPath = join(packDir, DKP_PATHS.registries.datasets)
    const benchmarksPath = join(packDir, DKP_PATHS.registries.benchmarks)
    const codebasesPath = join(packDir, DKP_PATHS.registries.codebases)

    const datasetsCount = existsSync(datasetsPath)
      ? (JSON.parse(readFileSync(datasetsPath, 'utf-8')) as unknown[]).length
      : 0
    const benchmarksCount = existsSync(benchmarksPath)
      ? (JSON.parse(readFileSync(benchmarksPath, 'utf-8')) as unknown[]).length
      : 0
    const codebasesCount = existsSync(codebasesPath)
      ? (JSON.parse(readFileSync(codebasesPath, 'utf-8')) as unknown[]).length
      : 0

    // Count entries by type
    const typeCounts: Record<string, number> = {}
    for (const entry of allEntries) {
      typeCounts[entry.type] = (typeCounts[entry.type] ?? 0) + 1
    }

    const l1Tokens = directions.reduce(
      (sum, d) => sum + estimateTokens(d.summary),
      0,
    )
    const l2AvgTokens =
      allEntries.length > 0
        ? Math.round(
            allEntries.reduce(
              (sum, e) => sum + estimateTokens(e.statement),
              0,
            ) / allEntries.length,
          )
        : 0

    const manifest: DKPManifest = {
      id: slugify(config.name),
      name: config.name,
      version: '1.0.0',
      description: config.description,
      sources: {
        textbooks: (config.textbooks ?? []).map(t => ({
          id: t.id,
          title: t.id,
          authors: [],
          year: 0,
        })),
        papers: (config.papers ?? []).map(p => ({
          id: p.id,
          title: p.id,
          authors: [],
          year: 0,
        })),
      },
      stats: {
        entries_total: allEntries.length,
        theorems: typeCounts['theorem'] ?? 0,
        definitions: typeCounts['definition'] ?? 0,
        algorithms: typeCounts['algorithm'] ?? 0,
        results: typeCounts['result'] ?? 0,
        datasets: datasetsCount,
        benchmarks: benchmarksCount,
        codebases: codebasesCount,
      },
      context_sizes: {
        l0_overview_tokens: estimateTokens(overview),
        l1_directions_tokens: l1Tokens,
        l2_entry_avg_tokens: l2AvgTokens,
      },
      built_at: new Date().toISOString(),
      built_with: 'claude-paper',
    }

    writeJSON(join(packDir, DKP_PATHS.manifest), manifest)

    return {
      packDir,
      manifest,
      total_entries: allEntries.length,
      total_cost_usd: totalCost,
      errors,
    }
  }

  // ── Overview Generation ───────────────────────────────

  private async generateOverview(
    entries: KnowledgeEntry[],
    domainDescription: string,
  ): Promise<{ text: string; cost: number }> {
    if (entries.length === 0) {
      return {
        text: `# ${domainDescription}\n\nNo entries extracted yet.`,
        cost: 0,
      }
    }

    const entrySummary = entries
      .map(e => `- [${e.type}] ${e.label}: ${e.tags.join(', ')}`)
      .join('\n')

    const prompt = `Synthesize a domain overview from these knowledge entries.

Domain: ${domainDescription}

Entries:
${entrySummary}

Output ~3000 tokens of Markdown covering:
1. What this field is about
2. Key subfields and areas
3. Foundational concepts
4. Open problems and directions

Use section headers (##). Be comprehensive but concise.`

    const result = await chatCompletion({
      modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
      messages: [{ role: 'user', content: prompt }],
      system:
        'You are writing a domain knowledge overview. Output only Markdown.',
      max_tokens: 4096,
      temperature: 0.3,
    })

    return { text: result.text, cost: result.cost_usd }
  }

  // ── Direction Generation ──────────────────────────────

  private async generateDirections(
    entries: KnowledgeEntry[],
    domainDescription: string,
  ): Promise<{ directions: DirectionSummary[]; cost: number }> {
    if (entries.length === 0) {
      return { directions: [], cost: 0 }
    }

    const entrySummary = entries
      .map(e => `${e.id}: [${e.type}] ${e.label} (tags: ${e.tags.join(', ')})`)
      .join('\n')

    const prompt = `Identify 3-7 research sub-directions from these knowledge entries.

Domain: ${domainDescription}

Entries:
${entrySummary}

For each direction, output JSON:
[
  {
    "id": "direction-slug",
    "name": "Direction Name",
    "summary": "2-3 paragraph summary of this sub-direction",
    "key_entries": ["entry-id-1", "entry-id-2"]
  }
]

Output only a JSON array.`

    const result = await chatCompletion({
      modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
      messages: [{ role: 'user', content: prompt }],
      system: 'Output only a valid JSON array. No markdown fences.',
      max_tokens: 4096,
      temperature: 0.3,
    })

    const parsed = parseJSONArray(result.text)
    const directions: DirectionSummary[] = []

    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      if (!obj.id || typeof obj.id !== 'string') continue
      if (!obj.name || typeof obj.name !== 'string') continue

      directions.push({
        id: obj.id,
        name: obj.name,
        summary: typeof obj.summary === 'string' ? obj.summary : '',
        entry_count: Array.isArray(obj.key_entries)
          ? obj.key_entries.length
          : 0,
        key_entries: Array.isArray(obj.key_entries)
          ? (obj.key_entries as string[]).filter(s => typeof s === 'string')
          : [],
      })
    }

    return { directions, cost: result.cost_usd }
  }
}

// ── Pure Functions (exported for testing) ────────────────

export function buildConnectionGraph(
  entries: KnowledgeEntry[],
): ConnectionGraph {
  const entryIds = new Set(entries.map(e => e.id))
  const edges: ConnectionEdge[] = []

  for (const entry of entries) {
    // depends_on -> depends_on edges
    for (const depId of entry.relations.depends_on) {
      if (entryIds.has(depId)) {
        edges.push({ from: entry.id, to: depId, relation: 'depends_on' })
      }
    }

    // used_by -> reverse depends_on (target depends on this entry)
    for (const usedById of entry.relations.used_by) {
      if (entryIds.has(usedById)) {
        edges.push({
          from: usedById,
          to: entry.id,
          relation: 'depends_on',
        })
      }
    }

    // generalizes -> generalized_by edge
    if (
      entry.relations.generalizes &&
      entryIds.has(entry.relations.generalizes)
    ) {
      edges.push({
        from: entry.id,
        to: entry.relations.generalizes,
        relation: 'generalized_by',
      })
    }

    // specialized_by -> specializes edges
    for (const specId of entry.relations.specialized_by) {
      if (entryIds.has(specId)) {
        edges.push({ from: specId, to: entry.id, relation: 'specializes' })
      }
    }
  }

  return { edges }
}

export function buildIndices(entries: KnowledgeEntry[]): DKPIndices {
  const byType: TypeIndex = {
    theorem: [],
    proposition: [],
    lemma: [],
    corollary: [],
    definition: [],
    algorithm: [],
    result: [],
  }

  const byTopic: TopicIndex = {}
  const bySource: SourceIndex = {}
  const invertedIndex: Map<string, Set<string>> = new Map()

  for (const entry of entries) {
    // by-type
    byType[entry.type].push(entry.id)

    // by-topic
    for (const tag of entry.tags) {
      const normalizedTag = tag.toLowerCase().trim()
      if (!normalizedTag) continue
      if (!byTopic[normalizedTag]) byTopic[normalizedTag] = []
      byTopic[normalizedTag].push(entry.id)
    }

    // by-source
    const sourceId = entry.source.id
    if (sourceId) {
      if (!bySource[sourceId]) bySource[sourceId] = []
      bySource[sourceId].push(entry.id)
    }

    // full-text index
    const text = [
      entry.statement,
      entry.label,
      entry.name,
      entry.tags.join(' '),
    ].join(' ')

    const words = tokenize(text)
    for (const word of words) {
      if (STOP_WORDS.has(word)) continue
      if (word.length < 2) continue
      if (!invertedIndex.has(word)) invertedIndex.set(word, new Set())
      invertedIndex.get(word)!.add(entry.id)
    }
  }

  // Cap full-text index at 1000 most frequent terms
  const sortedTerms = Array.from(invertedIndex.entries())
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 1000)

  const fullText: FullTextIndex = {}
  for (const [word, ids] of sortedTerms) {
    fullText[word] = Array.from(ids)
  }

  return { byType, byTopic, bySource, fullText }
}

// ── Internal Helpers ────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0)
}

function parseJSONArray(text: string): unknown[] {
  let cleaned = text
    .replace(/```(?:json)?\s*\n?/g, '')
    .replace(/```\s*$/g, '')
    .trim()

  try {
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) return parsed
  } catch {
    // continue
  }

  const arrayMatch = cleaned.match(/\[[\s\S]*\]/)
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0])
      if (Array.isArray(parsed)) return parsed
    } catch {
      // continue
    }
  }

  const repaired = repairTruncatedJSON(cleaned)
  if (Array.isArray(repaired)) return repaired

  return []
}

function writeJSON(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}
