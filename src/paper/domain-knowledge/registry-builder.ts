import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import type {
  DatasetEntry,
  BenchmarkEntry,
  CodebaseEntry,
  DKPRegistries,
} from './types'
import { DKP_PATHS } from './types'
import { chatCompletion } from '../llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import { repairTruncatedJSON } from '../json-repair'

// ── Types ───────────────────────────────────────────────

export interface RegistryBuildResult {
  datasets: number
  benchmarks: number
  codebases: number
  cost_usd: number
}

// ── Registry Builder ────────────────────────────────────

export class RegistryBuilder {
  private collectedDatasets: DatasetEntry[] = []
  private collectedBenchmarks: BenchmarkEntry[] = []

  constructor(private packDir: string) {}

  /** Merge contributions from a paper parse. */
  addFromPaperParse(contributions: {
    datasets: DatasetEntry[]
    benchmarks: BenchmarkEntry[]
  }): void {
    this.collectedDatasets.push(...contributions.datasets)
    this.collectedBenchmarks.push(...contributions.benchmarks)
  }

  /** Build datasets registry: merge paper contributions + optional LLM enrichment. */
  async buildDatasets(domainDescription: string): Promise<DatasetEntry[]> {
    let datasets = [...this.collectedDatasets]

    // LLM enrichment
    const llmDatasets = await this.callLLMForDatasets(domainDescription)
    datasets.push(...llmDatasets.items)

    // Deduplicate by name (case-insensitive)
    datasets = this.deduplicateDatasets(datasets)
    return datasets
  }

  /** Build benchmarks registry: merge paper contributions + LLM. */
  async buildBenchmarks(domainDescription: string): Promise<BenchmarkEntry[]> {
    let benchmarks = [...this.collectedBenchmarks]

    const llmBenchmarks = await this.callLLMForBenchmarks(domainDescription)
    benchmarks.push(...llmBenchmarks.items)

    benchmarks = this.deduplicateBenchmarks(benchmarks)
    return benchmarks
  }

  /** Build codebases registry via LLM. */
  async buildCodebases(domainDescription: string): Promise<CodebaseEntry[]> {
    const result = await this.callLLMForCodebases(domainDescription)
    return result.items
  }

  /** Save all registries to disk. */
  saveAll(registries: DKPRegistries): void {
    this.writeJSON(
      join(this.packDir, DKP_PATHS.registries.datasets),
      registries.datasets,
    )
    this.writeJSON(
      join(this.packDir, DKP_PATHS.registries.benchmarks),
      registries.benchmarks,
    )
    this.writeJSON(
      join(this.packDir, DKP_PATHS.registries.codebases),
      registries.codebases,
    )
  }

  /** Full build: merge contributions + LLM enrich + save. */
  async build(
    domainDescription: string,
    options?: {
      search_datasets?: boolean
      search_benchmarks?: boolean
      search_codebases?: boolean
    },
  ): Promise<RegistryBuildResult> {
    let totalCost = 0

    let datasets: DatasetEntry[]
    if (options?.search_datasets !== false) {
      const llmResult = await this.callLLMForDatasets(domainDescription)
      totalCost += llmResult.cost
      datasets = this.deduplicateDatasets([
        ...this.collectedDatasets,
        ...llmResult.items,
      ])
    } else {
      datasets = this.deduplicateDatasets(this.collectedDatasets)
    }

    let benchmarks: BenchmarkEntry[]
    if (options?.search_benchmarks !== false) {
      const llmResult = await this.callLLMForBenchmarks(domainDescription)
      totalCost += llmResult.cost
      benchmarks = this.deduplicateBenchmarks([
        ...this.collectedBenchmarks,
        ...llmResult.items,
      ])
    } else {
      benchmarks = this.deduplicateBenchmarks(this.collectedBenchmarks)
    }

    let codebases: CodebaseEntry[]
    if (options?.search_codebases !== false) {
      const llmResult = await this.callLLMForCodebases(domainDescription)
      totalCost += llmResult.cost
      codebases = llmResult.items
    } else {
      codebases = []
    }

    const registries: DKPRegistries = { datasets, benchmarks, codebases }
    this.saveAll(registries)

    return {
      datasets: datasets.length,
      benchmarks: benchmarks.length,
      codebases: codebases.length,
      cost_usd: totalCost,
    }
  }

  // ── LLM Calls ─────────────────────────────────────────

  private async callLLMForDatasets(
    domainDescription: string,
  ): Promise<{ items: DatasetEntry[]; cost: number }> {
    const prompt = `For the following research domain, list well-known datasets commonly used for evaluation or training.

Domain: ${domainDescription}

Output a JSON array of datasets:
[
  {
    "name": "dataset name",
    "description": "brief description",
    "access": "URL or access instructions",
    "format": "data format (e.g. CSV, images, text)",
    "size": "approximate size"
  }
]

Only include datasets that are real and well-established. Output only JSON.`

    try {
      const result = await chatCompletion({
        modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
        messages: [{ role: 'user', content: prompt }],
        system:
          'Output only a valid JSON array. No markdown fences, no commentary.',
        max_tokens: 4096,
        temperature: 0,
      })

      const parsed = this.parseJSONArray(result.text)
      const items: DatasetEntry[] = []
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const obj = item as Record<string, unknown>
        if (!obj.name || typeof obj.name !== 'string') continue
        items.push({
          name: obj.name,
          description:
            typeof obj.description === 'string' ? obj.description : '',
          access: typeof obj.access === 'string' ? obj.access : '',
          format: typeof obj.format === 'string' ? obj.format : undefined,
          size: typeof obj.size === 'string' ? obj.size : undefined,
        })
      }
      return { items, cost: result.cost_usd }
    } catch {
      return { items: [], cost: 0 }
    }
  }

  private async callLLMForBenchmarks(
    domainDescription: string,
  ): Promise<{ items: BenchmarkEntry[]; cost: number }> {
    const prompt = `For the following research domain, list standard benchmarks with their metrics and common baselines.

Domain: ${domainDescription}

Output a JSON array:
[
  {
    "name": "benchmark name",
    "description": "brief description",
    "standard_metrics": ["metric1", "metric2"],
    "standard_baselines": ["baseline1", "baseline2"],
    "source": "original paper or URL"
  }
]

Only include real, well-established benchmarks. Output only JSON.`

    try {
      const result = await chatCompletion({
        modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
        messages: [{ role: 'user', content: prompt }],
        system:
          'Output only a valid JSON array. No markdown fences, no commentary.',
        max_tokens: 4096,
        temperature: 0,
      })

      const parsed = this.parseJSONArray(result.text)
      const items: BenchmarkEntry[] = []
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const obj = item as Record<string, unknown>
        if (!obj.name || typeof obj.name !== 'string') continue
        items.push({
          name: obj.name,
          description:
            typeof obj.description === 'string' ? obj.description : '',
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
      return { items, cost: result.cost_usd }
    } catch {
      return { items: [], cost: 0 }
    }
  }

  private async callLLMForCodebases(
    domainDescription: string,
  ): Promise<{ items: CodebaseEntry[]; cost: number }> {
    const prompt = `For the following research domain, list well-known open-source implementations and codebases.

Domain: ${domainDescription}

Output a JSON array:
[
  {
    "name": "project name",
    "repo_url": "GitHub/GitLab URL",
    "language": "primary language",
    "implements": "what algorithm/method it implements"
  }
]

Only include real, active repositories. Output only JSON.`

    try {
      const result = await chatCompletion({
        modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
        messages: [{ role: 'user', content: prompt }],
        system:
          'Output only a valid JSON array. No markdown fences, no commentary.',
        max_tokens: 4096,
        temperature: 0,
      })

      const parsed = this.parseJSONArray(result.text)
      const items: CodebaseEntry[] = []
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const obj = item as Record<string, unknown>
        if (!obj.name || typeof obj.name !== 'string') continue
        items.push({
          name: obj.name,
          repo_url: typeof obj.repo_url === 'string' ? obj.repo_url : '',
          language: typeof obj.language === 'string' ? obj.language : '',
          implements: typeof obj.implements === 'string' ? obj.implements : '',
          last_updated:
            typeof obj.last_updated === 'string' ? obj.last_updated : undefined,
          stars: typeof obj.stars === 'number' ? obj.stars : undefined,
        })
      }
      return { items, cost: result.cost_usd }
    } catch {
      return { items: [], cost: 0 }
    }
  }

  // ── Helpers ────────────────────────────────────────────

  private parseJSONArray(text: string): unknown[] {
    let cleaned = text
      .replace(/```(?:json)?\s*\n?/g, '')
      .replace(/```\s*$/g, '')
      .trim()

    // Direct parse
    try {
      const parsed = JSON.parse(cleaned)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // continue
    }

    // Find array
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/)
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0])
        if (Array.isArray(parsed)) return parsed
      } catch {
        // continue
      }
    }

    // Repair
    const repaired = repairTruncatedJSON(cleaned)
    if (Array.isArray(repaired)) return repaired

    return []
  }

  private deduplicateDatasets(datasets: DatasetEntry[]): DatasetEntry[] {
    const seen = new Map<string, DatasetEntry>()
    for (const ds of datasets) {
      const key = ds.name.toLowerCase().trim()
      if (!seen.has(key)) {
        seen.set(key, ds)
      }
    }
    return Array.from(seen.values())
  }

  private deduplicateBenchmarks(
    benchmarks: BenchmarkEntry[],
  ): BenchmarkEntry[] {
    const seen = new Map<string, BenchmarkEntry>()
    for (const bm of benchmarks) {
      const key = bm.name.toLowerCase().trim()
      if (!seen.has(key)) {
        seen.set(key, bm)
      }
    }
    return Array.from(seen.values())
  }

  private writeJSON(filePath: string, data: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  }
}
