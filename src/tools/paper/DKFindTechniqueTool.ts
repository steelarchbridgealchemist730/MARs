import { z } from 'zod'
import type { Tool } from '@tool'
import { getActiveDKPLoader } from '../../paper/agent-dispatch'

const inputSchema = z.strictObject({
  technique: z
    .string()
    .describe(
      'Proof technique to search for (e.g. "contraction mapping", "induction", "Lyapunov")',
    ),
  applicable_to: z
    .string()
    .optional()
    .describe(
      'Optional: describe what you want to prove, to help rank relevance',
    ),
})

type Input = z.infer<typeof inputSchema>

interface TechniqueResult {
  id: string
  label: string
  name: string
  proof_technique: string
  proof_sketch: string
  statement_preview: string
  source_id: string
}

type Output = {
  technique: string
  results: TechniqueResult[]
}

const TOOL_NAME = 'DKFindTechnique'

const PROMPT = `Search domain knowledge for theorems that use a specific proof technique.

Particularly useful when:
- You're stuck on a proof and want to see how similar theorems were proved
- You want to find the right technique for a new theorem
- You need a reference for a proof approach

Returns theorems with their proof sketches and techniques.
Use dk_expand to see the full proof details.`

export const DKFindTechniqueTool = {
  name: TOOL_NAME,
  async description() {
    return 'Find theorems by proof technique in domain knowledge'
  },
  userFacingName: () => 'DK Find Technique',
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
      const applicable = input.applicable_to
        ? ` (for: ${input.applicable_to.slice(0, 40)})`
        : ''
      return `Searching for technique: "${input.technique}"${applicable}`
    }
    return `dk_find_technique: "${input.technique}"`
  },

  renderResultForAssistant(output: Output) {
    if (output.results.length === 0) {
      return `No theorems found using technique: "${output.technique}"`
    }

    const lines = [
      `Found ${output.results.length} theorems using "${output.technique}":\n`,
    ]
    for (const r of output.results) {
      lines.push(`[${r.id}] ${r.label}: ${r.name}`)
      lines.push(`  Technique: ${r.proof_technique}`)
      lines.push(`  Sketch: ${r.proof_sketch}`)
      lines.push(`  -> dk_expand("${r.id}") for full details\n`)
    }
    return lines.join('\n')
  },

  renderToolResultMessage(output: Output) {
    return `Found ${output.results.length} theorems using "${output.technique}"`
  },

  async *call(input: Input) {
    yield {
      type: 'progress' as const,
      content: `Searching for proof technique: "${input.technique}"...`,
    }

    const loader = getActiveDKPLoader()
    if (!loader) {
      yield {
        type: 'result' as const,
        data: { technique: input.technique, results: [] } as Output,
      }
      return
    }

    const technique = input.technique.toLowerCase()
    const results: TechniqueResult[] = []

    for (const pack of loader.getLoadedPacks()) {
      const theoremIds = [
        ...(pack.indices.byType.theorem ?? []),
        ...(pack.indices.byType.proposition ?? []),
        ...(pack.indices.byType.lemma ?? []),
      ]
      const entries = loader.getEntries(pack.manifest.id, theoremIds)
      for (const entry of entries) {
        if (
          entry.proof_technique &&
          entry.proof_technique.toLowerCase().includes(technique)
        ) {
          results.push({
            id: entry.id,
            label: entry.label,
            name: entry.name,
            proof_technique: entry.proof_technique,
            proof_sketch: entry.proof_sketch ?? '',
            statement_preview:
              entry.statement.length > 150
                ? entry.statement.slice(0, 147) + '...'
                : entry.statement,
            source_id: entry.source.id,
          })
        }
      }
    }

    yield {
      type: 'result' as const,
      data: { technique: input.technique, results } as Output,
    }
  },
} satisfies Tool<typeof inputSchema, Output>
