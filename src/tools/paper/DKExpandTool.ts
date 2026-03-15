import { z } from 'zod'
import type { Tool } from '@tool'
import { getActiveDKPLoader } from '../../paper/agent-dispatch'

const inputSchema = z.strictObject({
  entry_id: z
    .string()
    .describe('Knowledge entry ID (e.g. "thm-001", "def-003", "alg-012")'),
  include_proof: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include proof sketch (for theorems)'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  entry_id: string
  content: string
  found: boolean
}

const TOOL_NAME = 'DKExpand'

const PROMPT = `Expand a domain knowledge entry to see its full details.

Given an entry ID (from dk_search results), returns:
- Full mathematical statement
- Assumptions and conditions
- Proof sketch and technique (for theorems)
- Usability notes and citation info
- Related entries (dependencies, used_by)

Only available in SubAgent context. Use dk_search for summaries in the main orchestrator loop.`

export const DKExpandTool = {
  name: TOOL_NAME,
  async description() {
    return 'Expand a domain knowledge entry to see full details'
  },
  userFacingName: () => 'DK Expand',
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
      return `Expanding knowledge entry: ${input.entry_id} (proof: ${input.include_proof})`
    }
    return `dk_expand: ${input.entry_id}`
  },

  renderResultForAssistant(output: Output) {
    if (!output.found) {
      return `Entry "${output.entry_id}" not found in any loaded knowledge pack.`
    }
    return output.content
  },

  renderToolResultMessage(output: Output) {
    if (!output.found) return `Entry ${output.entry_id} not found`
    return `Expanded entry ${output.entry_id}`
  },

  async *call(input: Input) {
    yield {
      type: 'progress' as const,
      content: `Expanding entry ${input.entry_id}...`,
    }

    const loader = getActiveDKPLoader()
    if (!loader) {
      yield {
        type: 'result' as const,
        data: {
          entry_id: input.entry_id,
          content: 'No knowledge packs loaded.',
          found: false,
        } as Output,
      }
      return
    }

    let entry = null
    for (const pack of loader.getLoadedPacks()) {
      entry = loader.getEntry(pack.manifest.id, input.entry_id)
      if (entry) break
    }

    if (!entry) {
      yield {
        type: 'result' as const,
        data: {
          entry_id: input.entry_id,
          content: `Entry "${input.entry_id}" not found in any loaded knowledge pack.`,
          found: false,
        } as Output,
      }
      return
    }

    let content = `## ${entry.label}: ${entry.name}\n`
    content += `Source: ${entry.source.id}, Ch.${entry.source.chapter}, p.${entry.source.page}\n`
    content += `Type: ${entry.type} | Difficulty: ${entry.proof_difficulty ?? 'n/a'}\n\n`
    content += `### Statement\n${entry.statement}\n\n`

    if (entry.assumptions && entry.assumptions.length > 0) {
      content += `### Assumptions\n`
      for (const a of entry.assumptions) {
        content += `- (${a.id}) ${a.text} [${a.strength}]\n`
      }
      content += '\n'
    }

    if (input.include_proof && entry.proof_sketch) {
      content += `### Proof Sketch\n${entry.proof_sketch}\n`
      content += `Technique: ${entry.proof_technique ?? 'unspecified'}\n\n`
    }

    if (entry.pseudocode) {
      content += `### Algorithm\n${entry.pseudocode}\n`
      if (entry.complexity) content += `Complexity: ${entry.complexity}\n`
      if (entry.inputs) content += `Inputs: ${entry.inputs}\n`
      if (entry.outputs) content += `Outputs: ${entry.outputs}\n`
      content += '\n'
    }

    if (entry.usability) {
      content += `### Usability\n`
      content += `Citable: ${entry.usability.citable ? 'Yes' : 'No'}`
      if (entry.usability.cite_as) content += ` (${entry.usability.cite_as})`
      content += '\n'
      content += `Common use: ${entry.usability.common_use}\n`
      if (entry.usability.adaptation_notes) {
        content += `Adaptation: ${entry.usability.adaptation_notes}\n`
      }
    }

    if (entry.relations) {
      content += `\n### Relations\n`
      if (entry.relations.depends_on.length > 0)
        content += `Depends on: ${entry.relations.depends_on.join(', ')}\n`
      if (entry.relations.used_by.length > 0)
        content += `Used by: ${entry.relations.used_by.join(', ')}\n`
      if (entry.relations.generalizes)
        content += `Generalizes: ${entry.relations.generalizes}\n`
      if (entry.relations.specialized_by.length > 0)
        content += `Specialized by: ${entry.relations.specialized_by.join(', ')}\n`
    }

    yield {
      type: 'result' as const,
      data: { entry_id: input.entry_id, content, found: true } as Output,
    }
  },
} satisfies Tool<typeof inputSchema, Output>
