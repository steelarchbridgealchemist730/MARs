import type { PDFExtractor } from '../pdf-extractor'
import type {
  KnowledgeEntry,
  KnowledgeEntryType,
  PaperSourceConfig,
  DatasetEntry,
  BenchmarkEntry,
} from './types'
import type { EntryStore } from './entry-store'
import { chatCompletion } from '../llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import { estimateTokens } from '../claim-graph/token-utils'
import { repairTruncatedJSON } from '../json-repair'

// ── Types ───────────────────────────────────────────────

export interface PaperParseResult {
  sourceId: string
  entries_created: number
  registry_contributions: {
    datasets: DatasetEntry[]
    benchmarks: BenchmarkEntry[]
  }
  cost_usd: number
  errors: string[]
}

export type PaperParseProgress =
  | { type: 'phase'; message: string }
  | { type: 'done'; entries: number }
  | { type: 'error'; message: string }

// ── Constants ───────────────────────────────────────────

const MAX_PAPER_TOKENS = 15_000
const MAX_PAPER_CHARS = MAX_PAPER_TOKENS * 4

// ── Paper Parser ────────────────────────────────────────

export class PaperParser {
  constructor(
    private entryStore: EntryStore,
    private pdfExtractor: PDFExtractor,
  ) {}

  async parse(
    config: PaperSourceConfig,
    packDir: string,
    onProgress?: (event: PaperParseProgress) => void,
  ): Promise<PaperParseResult> {
    const errors: string[] = []
    let costUsd = 0
    let entriesCreated = 0
    const datasets: DatasetEntry[] = []
    const benchmarks: BenchmarkEntry[] = []

    // Step 1: Get paper text
    if (!config.path) {
      const msg = `Paper ${config.id}: no local path provided, skipping`
      errors.push(msg)
      onProgress?.({ type: 'error', message: msg })
      return {
        sourceId: config.id,
        entries_created: 0,
        registry_contributions: { datasets: [], benchmarks: [] },
        cost_usd: 0,
        errors,
      }
    }

    onProgress?.({
      type: 'phase',
      message: `Extracting text from ${config.id}...`,
    })
    let paperText: string
    try {
      const outputDir = `${packDir}/.tmp-extract-${config.id}`
      const extracted = await this.pdfExtractor.extract(
        config.path,
        config.id,
        outputDir,
      )
      paperText = extracted.text.markdown || extracted.text.full_text || ''
    } catch (err) {
      const msg = `PDF extraction failed for ${config.id}: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      onProgress?.({ type: 'error', message: msg })
      return {
        sourceId: config.id,
        entries_created: 0,
        registry_contributions: { datasets: [], benchmarks: [] },
        cost_usd: 0,
        errors,
      }
    }

    if (paperText.length === 0) {
      errors.push(`Paper ${config.id}: extracted text is empty`)
      return {
        sourceId: config.id,
        entries_created: 0,
        registry_contributions: { datasets: [], benchmarks: [] },
        cost_usd: 0,
        errors,
      }
    }

    // Truncate to fit token budget
    if (paperText.length > MAX_PAPER_CHARS) {
      paperText = paperText.slice(0, MAX_PAPER_CHARS)
    }

    // Step 2: Single LLM call
    onProgress?.({
      type: 'phase',
      message: `Extracting knowledge from ${config.id}...`,
    })
    try {
      const { entries, paperDatasets, paperBenchmarks, cost } =
        await this.callLLM(paperText, config.id)

      // Step 3: Assign IDs and save entries
      for (const rawEntry of entries) {
        const id = this.entryStore.nextId(rawEntry.type)
        const entry: KnowledgeEntry = {
          ...rawEntry,
          id,
          source: {
            id: config.id,
            chapter: rawEntry.source?.chapter || '',
            section: rawEntry.source?.section || '',
            page: rawEntry.source?.page || 0,
          },
        }
        this.entryStore.saveEntry(entry)
        entriesCreated++
      }

      costUsd += cost
      datasets.push(...paperDatasets)
      benchmarks.push(...paperBenchmarks)
    } catch (err) {
      const msg = `LLM extraction failed for ${config.id}: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      onProgress?.({ type: 'error', message: msg })
    }

    onProgress?.({ type: 'done', entries: entriesCreated })
    return {
      sourceId: config.id,
      entries_created: entriesCreated,
      registry_contributions: { datasets, benchmarks },
      cost_usd: costUsd,
      errors,
    }
  }

  // ── LLM Call ──────────────────────────────────────────

  private async callLLM(
    text: string,
    sourceId: string,
  ): Promise<{
    entries: KnowledgeEntry[]
    paperDatasets: DatasetEntry[]
    paperBenchmarks: BenchmarkEntry[]
    cost: number
  }> {
    const prompt = this.buildPrompt(text, sourceId)

    const result = await chatCompletion({
      modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
      messages: [{ role: 'user', content: prompt }],
      system:
        'You are extracting structured knowledge from a research paper. Output only valid JSON. No markdown fences, no commentary.',
      max_tokens: 16384,
      temperature: 0,
    })

    const parsed = this.parseResponse(result.text)
    return { ...parsed, cost: result.cost_usd }
  }

  private buildPrompt(text: string, sourceId: string): string {
    return `Extract structured knowledge from this research paper.
Paper: ${sourceId}

Text:
${text}

Extract:
1. Key Results: main theorems/claims/findings -> as entries (type "theorem" or "result")
2. Methods: named algorithms or techniques -> as entries (type "algorithm")
3. Definitions: key definitions introduced -> as entries (type "definition")
4. Datasets Used: name, description, access info
5. Benchmarks Used: name, description, standard_metrics, standard_baselines

Output JSON:
{
  "entries": [
    {
      "type": "theorem"|"result"|"algorithm"|"definition",
      "label": "short identifier",
      "name": "formal name",
      "statement": "precise statement (use LaTeX for math)",
      "assumptions": [{"id": "A1", "text": "...", "strength": "standard"|"technical"|"strong"|"necessary_and_sufficient"}],
      "proof_sketch": "brief proof approach (for theorems)",
      "proof_technique": "e.g. induction, construction",
      "proof_difficulty": "elementary"|"moderate"|"advanced"|"deep",
      "pseudocode": "algorithm steps (for algorithms)",
      "complexity": "time/space complexity (for algorithms)",
      "inputs": "input description (for algorithms)",
      "outputs": "output description (for algorithms)",
      "usability": {"citable": true, "cite_as": "Author et al. (Year)", "common_use": "how this is used"},
      "relations": {"depends_on": [], "used_by": [], "generalizes": null, "specialized_by": []},
      "tags": ["topic1", "topic2"],
      "source": {"section": "section title", "page": 0}
    }
  ],
  "datasets": [
    {"name": "...", "description": "...", "access": "URL or instructions", "source_paper": "${sourceId}", "format": "...", "size": "..."}
  ],
  "benchmarks": [
    {"name": "...", "description": "...", "standard_metrics": ["..."], "standard_baselines": ["..."], "source": "${sourceId}"}
  ]
}

Be precise with LaTeX notation. Do not invent content not in the paper.`
  }

  // ── Response Parsing ──────────────────────────────────

  private parseResponse(responseText: string): {
    entries: KnowledgeEntry[]
    paperDatasets: DatasetEntry[]
    paperBenchmarks: BenchmarkEntry[]
  } {
    const parsed = this.extractJSON(responseText)

    if (!parsed || typeof parsed !== 'object') {
      return { entries: [], paperDatasets: [], paperBenchmarks: [] }
    }

    const obj = parsed as Record<string, unknown>
    const entries = Array.isArray(obj.entries)
      ? this.validateEntries(obj.entries)
      : []
    const paperDatasets = Array.isArray(obj.datasets)
      ? this.validateDatasets(obj.datasets)
      : []
    const paperBenchmarks = Array.isArray(obj.benchmarks)
      ? this.validateBenchmarks(obj.benchmarks)
      : []

    return { entries, paperDatasets, paperBenchmarks }
  }

  private extractJSON(text: string): unknown {
    // Strip markdown fences
    let cleaned = text
      .replace(/```(?:json)?\s*\n?/g, '')
      .replace(/```\s*$/g, '')
      .trim()

    // Try direct parse
    try {
      return JSON.parse(cleaned)
    } catch {
      // continue
    }

    // Try to find JSON object
    const objMatch = cleaned.match(/\{[\s\S]*\}/)
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0])
      } catch {
        // continue
      }
    }

    // Try repair
    const repaired = repairTruncatedJSON(cleaned)
    if (repaired) return repaired

    // Try to find object start and repair from there
    const objStart = cleaned.indexOf('{')
    if (objStart >= 0) {
      let repairText = cleaned.slice(objStart)

      // Close unterminated strings
      const unescapedQuotes = repairText.match(/(?<!\\)"/g)
      if (unescapedQuotes && unescapedQuotes.length % 2 !== 0) {
        repairText += '"'
      }

      // Count brackets
      let openBraces = 0
      let openBrackets = 0
      let inString = false
      for (let i = 0; i < repairText.length; i++) {
        const ch = repairText[i]
        if (ch === '\\' && inString) {
          i++
          continue
        }
        if (ch === '"') {
          inString = !inString
          continue
        }
        if (inString) continue
        if (ch === '{') openBraces++
        else if (ch === '}') openBraces--
        else if (ch === '[') openBrackets++
        else if (ch === ']') openBrackets--
      }

      repairText = repairText.replace(/,\s*$/, '')
      for (let i = 0; i < openBrackets; i++) repairText += ']'
      for (let i = 0; i < openBraces; i++) repairText += '}'

      try {
        return JSON.parse(repairText)
      } catch {
        // give up
      }
    }

    return null
  }

  private validateEntries(raw: unknown[]): KnowledgeEntry[] {
    const valid: KnowledgeEntry[] = []
    const validTypes: KnowledgeEntryType[] = [
      'theorem',
      'proposition',
      'lemma',
      'corollary',
      'definition',
      'algorithm',
      'result',
    ]

    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>

      if (
        !obj.type ||
        typeof obj.type !== 'string' ||
        !validTypes.includes(obj.type as KnowledgeEntryType)
      )
        continue
      if (!obj.label || typeof obj.label !== 'string') continue
      if (!obj.statement || typeof obj.statement !== 'string') continue

      const entry: KnowledgeEntry = {
        id: '',
        type: obj.type as KnowledgeEntryType,
        source: {
          id: '',
          chapter:
            typeof (obj.source as any)?.chapter === 'string'
              ? (obj.source as any).chapter
              : '',
          section:
            typeof (obj.source as any)?.section === 'string'
              ? (obj.source as any).section
              : '',
          page:
            typeof (obj.source as any)?.page === 'number'
              ? (obj.source as any).page
              : 0,
        },
        label: obj.label as string,
        name: typeof obj.name === 'string' ? obj.name : (obj.label as string),
        statement: obj.statement as string,
        usability: {
          citable:
            typeof (obj.usability as any)?.citable === 'boolean'
              ? (obj.usability as any).citable
              : true,
          cite_as:
            typeof (obj.usability as any)?.cite_as === 'string'
              ? (obj.usability as any).cite_as
              : undefined,
          common_use:
            typeof (obj.usability as any)?.common_use === 'string'
              ? (obj.usability as any).common_use
              : '',
        },
        relations: {
          depends_on: Array.isArray((obj.relations as any)?.depends_on)
            ? (obj.relations as any).depends_on
            : [],
          used_by: Array.isArray((obj.relations as any)?.used_by)
            ? (obj.relations as any).used_by
            : [],
          generalizes:
            typeof (obj.relations as any)?.generalizes === 'string'
              ? (obj.relations as any).generalizes
              : null,
          specialized_by: Array.isArray((obj.relations as any)?.specialized_by)
            ? (obj.relations as any).specialized_by
            : [],
        },
        tags: Array.isArray(obj.tags)
          ? (obj.tags as string[]).filter(t => typeof t === 'string')
          : [],
      }

      // Optional theorem fields
      if (Array.isArray(obj.assumptions))
        entry.assumptions = obj.assumptions as any
      if (typeof obj.proof_sketch === 'string')
        entry.proof_sketch = obj.proof_sketch
      if (typeof obj.proof_technique === 'string')
        entry.proof_technique = obj.proof_technique
      if (typeof obj.proof_difficulty === 'string')
        entry.proof_difficulty = obj.proof_difficulty as any

      // Optional algorithm fields
      if (typeof obj.pseudocode === 'string') entry.pseudocode = obj.pseudocode
      if (typeof obj.complexity === 'string') entry.complexity = obj.complexity
      if (typeof obj.inputs === 'string') entry.inputs = obj.inputs
      if (typeof obj.outputs === 'string') entry.outputs = obj.outputs

      valid.push(entry)
    }

    return valid
  }

  private validateDatasets(raw: unknown[]): DatasetEntry[] {
    const valid: DatasetEntry[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      if (!obj.name || typeof obj.name !== 'string') continue
      valid.push({
        name: obj.name,
        description: typeof obj.description === 'string' ? obj.description : '',
        access: typeof obj.access === 'string' ? obj.access : '',
        source_paper:
          typeof obj.source_paper === 'string' ? obj.source_paper : undefined,
        format: typeof obj.format === 'string' ? obj.format : undefined,
        size: typeof obj.size === 'string' ? obj.size : undefined,
      })
    }
    return valid
  }

  private validateBenchmarks(raw: unknown[]): BenchmarkEntry[] {
    const valid: BenchmarkEntry[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      if (!obj.name || typeof obj.name !== 'string') continue
      valid.push({
        name: obj.name,
        description: typeof obj.description === 'string' ? obj.description : '',
        standard_metrics: Array.isArray(obj.standard_metrics)
          ? (obj.standard_metrics as string[]).filter(
              s => typeof s === 'string',
            )
          : [],
        standard_baselines: Array.isArray(obj.standard_baselines)
          ? (obj.standard_baselines as string[]).filter(
              s => typeof s === 'string',
            )
          : [],
        source: typeof obj.source === 'string' ? obj.source : '',
      })
    }
    return valid
  }
}
