import type { Command } from '@commands'
import { loadResearchState, buildStateContext } from '../paper/research-state'
import { chatCompletion } from '../paper/llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../paper/types'
import { join } from 'path'

async function getNextSuggestion(projectDir: string): Promise<string> {
  const state = loadResearchState(projectDir)
  if (!state) {
    return 'No research state found. Run /propose first, then /run.'
  }

  const stateContext = buildStateContext(state)

  const response = await chatCompletion({
    modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
    max_tokens: 1000,
    system:
      'You are a research advisor. Given the current state of this research project, suggest the single most valuable next action.',
    messages: [
      {
        role: 'user',
        content: `${stateContext}

Be specific and actionable. Format:

**Recommended Action**: [what to do]
**Agent**: [which agent should handle it]
**Reasoning**: [why this is the best next step, 2-3 sentences]
**Risk if skipped**: [what happens if we don't do this]

Keep it concise.`,
      },
    ],
  })

  return response.text || 'Unable to generate suggestion.'
}

const next: Command = {
  type: 'local',
  name: 'next',
  userFacingName() {
    return 'next'
  },
  description: 'Show the suggested next research action',
  isEnabled: true,
  isHidden: false,
  argumentHint: undefined,
  aliases: [],

  async call(_args: string): Promise<string> {
    const projectDir = join(process.cwd(), '.claude-paper-research')
    return getNextSuggestion(projectDir)
  },
}

export default next
