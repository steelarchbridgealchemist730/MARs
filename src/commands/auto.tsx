import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
// /auto <topic> [--budget $50] [--depth thorough] [--dry-run]
// Launches the full AutoModeOrchestrator workflow
// --dry-run: show plan without executing

import type { Command } from '@commands'
import { AutoModeOrchestrator } from '../paper/auto-mode'
import { BudgetTracker } from '../paper/budget-tracker'
import { getSessionDir } from '../paper/session'

const STAGES = [
  {
    num: 1,
    name: 'Deep Research',
    desc: 'Search arXiv, Semantic Scholar, SSRN; download PDFs; build knowledge base',
    estimatedCost: '$2–$5',
  },
  {
    num: 2,
    name: 'Proposal Generation',
    desc: 'Generate research proposals based on identified gaps (3 candidates)',
    estimatedCost: '$1–$3',
  },
  {
    num: 3,
    name: 'Experiment Design & Execution',
    desc: 'Generate experiment code and run with resource isolation',
    estimatedCost: '$3–$8',
  },
  {
    num: 4,
    name: 'Paper Writing',
    desc: 'Write LaTeX paper section by section and compile',
    estimatedCost: '$5–$15',
  },
  {
    num: 5,
    name: 'Multi-Model Review',
    desc: '3 parallel reviewers with 7-dimension scoring (up to 3 rounds)',
    estimatedCost: '$3–$10',
  },
  {
    num: 6,
    name: 'Delivery',
    desc: 'Package paper + code for arXiv / camera-ready submission',
    estimatedCost: '$0.10–$0.50',
  },
]

function parseArgs(args: string): {
  topic: string
  budget?: number
  depth?: 'quick' | 'standard' | 'thorough'
  dryRun: boolean
  exploratory: boolean
} {
  // Extract topic: everything before the first --flag
  const firstFlagIdx = args.indexOf(' --')
  const rawTopic =
    firstFlagIdx !== -1 ? args.slice(0, firstFlagIdx).trim() : args.trim()
  const topic = rawTopic.replace(/^["']|["']$/g, '')

  let budget: number | undefined
  const budgetMatch = args.match(/--budget\s+\$?([\d.]+)/)
  if (budgetMatch) {
    budget = parseFloat(budgetMatch[1])
  }

  let depth: 'quick' | 'standard' | 'thorough' | undefined
  const depthMatch = args.match(/--depth\s+(quick|standard|thorough)/)
  if (depthMatch) {
    depth = depthMatch[1] as 'quick' | 'standard' | 'thorough'
  }

  const dryRun = /--dry-run/.test(args)
  const exploratory = /--exploratory/.test(args)

  return { topic, budget, depth, dryRun, exploratory }
}

function formatDryRun(topic: string, budget?: number, depth?: string): string {
  const lines = [
    `Dry Run Plan: "${topic}"`,
    '',
    `Depth:  ${depth ?? 'standard'}`,
    `Budget: ${budget != null ? `$${budget}` : 'no limit'}`,
    '',
    'Workflow phases:',
  ]

  let totalLow = 0
  let totalHigh = 0

  for (const stage of STAGES) {
    const [lo, hi] = stage.estimatedCost
      .replace(/\$/g, '')
      .split('–')
      .map(parseFloat)
    totalLow += lo ?? 0
    totalHigh += hi ?? 0
    lines.push(`  Phase ${stage.num}: ${stage.name}`)
    lines.push(`           ${stage.desc}`)
    lines.push(`           Estimated cost: ${stage.estimatedCost}`)
    lines.push('')
  }

  lines.push(
    `Total estimated cost: $${totalLow.toFixed(2)}–$${totalHigh.toFixed(2)}`,
  )

  if (budget != null && totalHigh > budget) {
    lines.push(
      `Warning: estimated cost may exceed budget of $${budget}. Consider --depth quick.`,
    )
  }

  lines.push('')
  lines.push('Remove --dry-run to execute the workflow.')

  return lines.join('\n')
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function AutoProgressUI({
  topic,
  budget,
  exploratory,
  onDone,
}: {
  topic: string
  budget: number | undefined
  exploratory: boolean
  onDone: (result: string) => void
}): React.ReactNode {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [startTime] = useState(Date.now())
  const [logs, setLogs] = useState<string[]>([])
  const [stage, setStage] = useState('Starting...')

  useEffect(() => {
    const t = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER.length)
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 80)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const projectDir = getSessionDir()
    const budgetTracker = new BudgetTracker({ limitUSD: budget })
    const allLogs: string[] = []

    const orchestrator = new AutoModeOrchestrator(projectDir)

    // Use adaptive (Orchestrator-based) auto mode
    orchestrator
      .runAdaptive(
        topic,
        (msg: string) => {
          allLogs.push(msg)
          setLogs(prev => [...prev, msg])
          if (msg.startsWith('===')) setStage(msg.replace(/=/g, '').trim())
        },
        {
          budget_usd: budget,
          research_stance: exploratory ? 'exploratory' : 'standard',
        },
      )
      .then(result => {
        onDone(formatResult(result, allLogs, budgetTracker))
      })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        onDone(
          [
            `Auto mode failed: ${message}`,
            '',
            ...allLogs.map(l => `  ${l}`),
            budgetTracker.formatSummary(),
          ].join('\n'),
        )
      })
  }, [])

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box>
        <Text color="cyan">{SPINNER[frame]} </Text>
        <Text bold>Auto Mode: </Text>
        <Text>{stage}</Text>
        <Text dimColor> ({timeStr})</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {logs.slice(-6).map((l, i) => (
          <Box key={i}>
            <Text dimColor> {l}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

const auto: Command = {
  type: 'local-jsx',
  name: 'auto',
  userFacingName() {
    return 'auto'
  },
  description:
    'Full autonomous research workflow: research → proposals → experiments → paper → review → delivery',
  isEnabled: true,
  isHidden: false,
  argumentHint:
    '<topic> [--budget $50] [--depth quick|standard|thorough] [--exploratory] [--dry-run]',
  aliases: [],

  async call(
    onDone: (result?: string) => void,
    _context: any,
    args?: string,
  ): Promise<React.ReactNode> {
    const argsStr = args ?? ''
    if (!argsStr.trim()) {
      onDone(
        [
          'Usage: /auto <topic> [--budget $50] [--depth quick|standard|thorough] [--exploratory] [--dry-run]',
          '',
          'Example:',
          '  /auto "rough volatility estimation with high-frequency data"',
          '  /auto "transformer attention" --depth thorough --budget 30',
          '  /auto "neural scaling laws" --exploratory --budget 20',
        ].join('\n'),
      )
      return null
    }

    const { topic, budget, depth, dryRun, exploratory } = parseArgs(argsStr)

    if (!topic) {
      onDone('Error: Could not parse topic.')
      return null
    }

    if (dryRun) {
      onDone(formatDryRun(topic, budget, depth))
      return null
    }

    return (
      <AutoProgressUI
        topic={topic}
        budget={budget}
        exploratory={exploratory}
        onDone={r => onDone(r)}
      />
    )
  },
}

function formatResult(
  result: { status: string; artifacts: string[] },
  logs: string[],
  budgetTracker: BudgetTracker,
): string {
  const lines = [`=== Auto Mode Result ===`, `Status: ${result.status}`, '']

  if (logs.length > 0) {
    lines.push('Log:')
    for (const entry of logs) {
      lines.push(`  ${entry}`)
    }
    lines.push('')
  }

  if (result.artifacts.length > 0) {
    lines.push(`Artifacts (${result.artifacts.length}):`)
    for (const artifact of result.artifacts) {
      lines.push(`  ${artifact}`)
    }
    lines.push('')
  }

  lines.push(budgetTracker.formatSummary())
  lines.push('========================')
  return lines.join('\n')
}

export default auto
