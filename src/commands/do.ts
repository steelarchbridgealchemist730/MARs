import type { Command } from '@commands'
import {
  loadResearchState,
  saveResearchState,
  addTrajectoryEntry,
} from '../paper/research-state'
import { getAnthropicClient } from '../paper/llm-client'
import { join } from 'path'

const doCommand: Command = {
  type: 'prompt',
  name: 'do',
  progressMessage: 'Executing custom research action...',
  userFacingName() {
    return 'do'
  },
  description:
    'Force the Orchestrator to execute a specific action (free-form)',
  isEnabled: true,
  isHidden: false,
  argumentHint: '<description of what to do>',
  aliases: [],

  async getPromptForCommand(args: string) {
    if (!args.trim()) {
      return [
        {
          role: 'user' as const,
          content:
            'Usage: /do <description>\n\nExample:\n  /do search for papers on jump-diffusion models\n  /do run the baseline experiment with reduced batch size\n  /do write the related work section focusing on rough volatility',
        },
      ]
    }

    const projectDir = join(process.cwd(), '.claude-paper-research')
    const state = loadResearchState(projectDir)

    // Record the manual action in trajectory
    if (state) {
      const updated = addTrajectoryEntry(state, {
        action_type: 'manual_override',
        agent: 'user',
        description: args,
        outcome: 'pending',
        state_changes: [],
      })
      saveResearchState(projectDir, updated)
    }

    const stateContext = state
      ? [
          '\n## Current Research State',
          `Research: ${state.proposal.title}`,
          `Type: ${state.paper_type}`,
          `Budget: $${state.budget.spent_usd.toFixed(2)} / $${state.budget.total_usd}`,
          `Claims: ${state.claimGraph.claims.length} (${state.claimGraph.claims.filter(c => c.phase === 'admitted').length} admitted)`,
          `Artifacts: ${state.artifacts.entries.length}`,
        ].join('\n')
      : ''

    return [
      {
        role: 'user' as const,
        content: `The user wants to manually execute a research action. Do exactly what they ask.

## User Request
${args}
${stateContext}

## Instructions
- Execute the requested action using the available tools
- Be thorough but focused on exactly what was asked
- Report what you did and any findings
- If you produced any files, list them`,
      },
    ]
  },
}

export default doCommand
