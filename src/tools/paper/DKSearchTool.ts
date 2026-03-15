import { z } from 'zod'
import type { Tool } from '@tool'
import { getActiveDKPLoader } from '../../paper/agent-dispatch'

const inputSchema = z.strictObject({
  query: z.string().describe('Natural language search query'),
  type: z
    .enum([
      'theorem',
      'proposition',
      'lemma',
      'corollary',
      'definition',
      'algorithm',
      'result',
    ])
    .optional()
    .describe('Filter by entry type'),
  pack: z.string().optional().describe('Knowledge pack ID to search in'),
  max_results: z
    .number()
    .optional()
    .default(5)
    .describe('Maximum number of results (default: 5)'),
})

type Input = z.infer<typeof inputSchema>

interface SearchResult {
  id: string
  type: string
  label: string
  name: string
  source_id: string
  statement_preview: string
  tags: string[]
  pack: string
}

type Output = {
  results: SearchResult[]
  query: string
  total_searched: number
}

const TOOL_NAME = 'DKSearch'

const PROMPT = `Search loaded domain knowledge packs for theorems, definitions, algorithms, and results.

Use this to find:
- Theorems relevant to your current proof task
- Definitions you need to reference
- Algorithms that solve related problems
- Known results from the literature

Returns summary-level results. Use dk_expand to get full details of a specific entry.`

export const DKSearchTool = {
  name: TOOL_NAME,
  async description() {
    return 'Search domain knowledge packs for theorems, definitions, algorithms'
  },
  userFacingName: () => 'DK Search',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async isEnabled() {
    return true
  },
  needsPermissions() {
    return false
  },
  async prompt() {
    return PROMPT
  },

  renderToolUseMessage(input: Input, { verbose }: { verbose: boolean }) {
    if (verbose) {
      const typeFilter = input.type ? ` type=${input.type}` : ''
      return `Searching knowledge packs: "${input.query}"${typeFilter} (max ${input.max_results})`
    }
    return `dk_search: "${input.query}"`
  },

  renderResultForAssistant(output: Output) {
    if (output.results.length === 0) {
      return `No entries found for query: "${output.query}"`
    }

    const lines = [
      `Found ${output.results.length} entries (searched ${output.total_searched} total):\n`,
    ]
    for (const r of output.results) {
      lines.push(`[${r.id}] ${r.label} (${r.source_id})`)
      lines.push(`  Type: ${r.type} | ${r.name}`)
      lines.push(`  ${r.statement_preview}`)
      lines.push(`  Tags: ${r.tags.join(', ')}`)
      lines.push(`  -> dk_expand("${r.id}") for full details\n`)
    }
    return lines.join('\n')
  },

  renderToolResultMessage(output: Output) {
    return `Found ${output.results.length} knowledge entries for "${output.query}"`
  },

  async *call(input: Input) {
    yield {
      type: 'progress' as const,
      content: `Searching knowledge packs for "${input.query}"...`,
    }

    const loader = getActiveDKPLoader()
    if (!loader) {
      yield {
        type: 'result' as const,
        data: { results: [], query: input.query, total_searched: 0 } as Output,
      }
      return
    }

    const packs = loader.getLoadedPacks()
    const keywords = input.query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)

    const scored = new Map<string, { score: number; packId: string }>()

    for (const pack of packs) {
      for (const kw of keywords) {
        const ftIds = pack.indices.fullText[kw]
        if (ftIds) {
          for (const id of ftIds) {
            const existing = scored.get(id)
            if (existing) existing.score++
            else scored.set(id, { score: 1, packId: pack.manifest.id })
          }
        }
        const topicIds = pack.indices.byTopic[kw]
        if (topicIds) {
          for (const id of topicIds) {
            const existing = scored.get(id)
            if (existing) existing.score += 2
            else scored.set(id, { score: 2, packId: pack.manifest.id })
          }
        }
      }
    }

    let candidates = Array.from(scored.entries()).sort(
      (a, b) => b[1].score - a[1].score,
    )

    if (input.type) {
      candidates = candidates.filter(([id, meta]) => {
        if (id.startsWith(input.type!.slice(0, 3) + '-')) return true
        const entry = loader.getEntry(meta.packId, id)
        return entry?.type === input.type
      })
    }

    const totalSearched = packs.reduce(
      (s, p) => s + p.manifest.stats.entries_total,
      0,
    )

    const results: SearchResult[] = []
    for (const [id, meta] of candidates.slice(0, input.max_results)) {
      const entry = loader.getEntry(meta.packId, id)
      if (!entry) continue
      results.push({
        id: entry.id,
        type: entry.type,
        label: entry.label,
        name: entry.name,
        source_id: entry.source.id,
        statement_preview:
          entry.statement.length > 150
            ? entry.statement.slice(0, 147) + '...'
            : entry.statement,
        tags: entry.tags,
        pack: meta.packId,
      })
    }

    yield {
      type: 'result' as const,
      data: {
        results,
        query: input.query,
        total_searched: totalSearched,
      } as Output,
    }
  },
} satisfies Tool<typeof inputSchema, Output>
