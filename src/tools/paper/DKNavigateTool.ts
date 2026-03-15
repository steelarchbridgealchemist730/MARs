import { z } from 'zod'
import type { Tool } from '@tool'
import { getActiveDKPLoader } from '../../paper/agent-dispatch'

const inputSchema = z.strictObject({
  entry_id: z
    .string()
    .describe('Knowledge entry ID to navigate from (e.g. "thm-001")'),
  direction: z
    .enum(['prerequisites', 'dependents', 'related', 'siblings'])
    .describe(
      'Navigation direction: prerequisites (depends_on), dependents (used_by), related (any connection), siblings (same chapter)',
    ),
})

type Input = z.infer<typeof inputSchema>

interface NavResult {
  id: string
  type: string
  label: string
  statement_preview: string
  relation: string
}

type Output = {
  entry_id: string
  direction: string
  results: NavResult[]
}

const TOOL_NAME = 'DKNavigate'

const PROMPT = `Navigate the knowledge graph from a given entry.

Directions:
- prerequisites: entries this one depends on
- dependents: entries that use this one
- related: all connected entries (any relation type)
- siblings: other entries from the same chapter/section

Use this to trace proof dependencies, find related theorems, or explore the knowledge structure.`

export const DKNavigateTool = {
  name: TOOL_NAME,
  async description() {
    return 'Navigate the knowledge graph from a given entry'
  },
  userFacingName: () => 'DK Navigate',
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
      return `Navigating from ${input.entry_id} → ${input.direction}`
    }
    return `dk_navigate: ${input.entry_id} (${input.direction})`
  },

  renderResultForAssistant(output: Output) {
    if (output.results.length === 0) {
      return `No ${output.direction} found for entry "${output.entry_id}".`
    }

    const lines = [
      `${output.direction} of [${output.entry_id}] (${output.results.length} entries):\n`,
    ]
    for (const r of output.results) {
      lines.push(`[${r.id}] ${r.label} (${r.relation}): ${r.statement_preview}`)
    }
    return lines.join('\n')
  },

  renderToolResultMessage(output: Output) {
    return `Found ${output.results.length} ${output.direction} for ${output.entry_id}`
  },

  async *call(input: Input) {
    yield {
      type: 'progress' as const,
      content: `Navigating ${input.direction} from ${input.entry_id}...`,
    }

    const loader = getActiveDKPLoader()
    if (!loader) {
      yield {
        type: 'result' as const,
        data: {
          entry_id: input.entry_id,
          direction: input.direction,
          results: [],
        } as Output,
      }
      return
    }

    let entry = null
    let packId = ''
    for (const pack of loader.getLoadedPacks()) {
      entry = loader.getEntry(pack.manifest.id, input.entry_id)
      if (entry) {
        packId = pack.manifest.id
        break
      }
    }

    if (!entry) {
      yield {
        type: 'result' as const,
        data: {
          entry_id: input.entry_id,
          direction: input.direction,
          results: [],
        } as Output,
      }
      return
    }

    let targetIds: string[] = []

    switch (input.direction) {
      case 'prerequisites':
        targetIds = entry.relations.depends_on
        break
      case 'dependents':
        targetIds = entry.relations.used_by
        break
      case 'related': {
        const connections = loader.getConnections(packId)
        targetIds = connections.edges
          .filter(e => e.from === input.entry_id || e.to === input.entry_id)
          .map(e => (e.from === input.entry_id ? e.to : e.from))
        break
      }
      case 'siblings': {
        const pack = loader.getLoadedPack(packId)
        if (pack) {
          const sourceEntryIds = pack.indices.bySource[entry.source.id] ?? []
          targetIds = sourceEntryIds.filter(id => {
            if (id === input.entry_id) return false
            const other = loader.getEntry(packId, id)
            return other && other.source.chapter === entry!.source.chapter
          })
        }
        break
      }
    }

    const results: NavResult[] = []
    for (const id of targetIds) {
      const target = loader.getEntry(packId, id)
      if (!target) continue
      results.push({
        id: target.id,
        type: target.type,
        label: target.label,
        statement_preview:
          target.statement.length > 100
            ? target.statement.slice(0, 97) + '...'
            : target.statement,
        relation: input.direction,
      })
    }

    yield {
      type: 'result' as const,
      data: {
        entry_id: input.entry_id,
        direction: input.direction,
        results,
      } as Output,
    }
  },
} satisfies Tool<typeof inputSchema, Output>
