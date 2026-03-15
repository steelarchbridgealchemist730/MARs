import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Command } from '@commands'
import { getSessionDir } from '../paper/session'
import { ProposalGenerator } from '../paper/proposal/index'
import {
  resetCommandUsage,
  getCommandUsage,
  formatUsage,
} from '../paper/llm-client'
import type { Proposal } from '../paper/proposal/types'
import {
  initializeFromProposal,
  saveResearchState,
} from '../paper/research-state'
import {
  ProposalBrowser,
  type BrowsableProposal,
} from '@components/ProposalBrowser'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../paper/types'
import { extractModelId } from '../paper/agent-dispatch'
import { FullscreenLayout } from '@components/FullscreenLayout'

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const VERBS = [
  'Ideating',
  'Envisioning',
  'Crafting',
  'Architecting',
  'Devising',
  'Formulating',
  'Conjuring',
  'Synthesizing',
  'Brainstorming',
  'Inventing',
]
const DEFAULT_MODEL = extractModelId(DEFAULT_MODEL_ASSIGNMENTS.research)

function parseArgs(args: string): {
  count: number
  focus: string | undefined
  more: boolean
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let count = 3
  let focus: string | undefined
  let more = false

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '--count' && i + 1 < tokens.length) {
      const n = parseInt(tokens[i + 1]!, 10)
      if (!isNaN(n) && n > 0) count = n
      i++
    } else if (token === '--focus' && i + 1 < tokens.length) {
      const parts: string[] = []
      i++
      while (i < tokens.length && !tokens[i]!.startsWith('--')) {
        parts.push(tokens[i]!)
        i++
      }
      i--
      focus = parts.join(' ').replace(/^["']|["']$/g, '')
    } else if (token === '--more') {
      more = true
    }
  }

  return { count, focus, more }
}

function formatScore(score: number): string {
  return (score * 10).toFixed(1)
}

function formatProposal(proposal: Proposal, index: number): string {
  const separator = '\u2500'.repeat(50)
  const header = `\u2500\u2500 Proposal ${index + 1}: ${proposal.title} \u2500\u2500`
  const abstractSnippet =
    proposal.abstract.length > 200
      ? proposal.abstract.slice(0, 200) + '...'
      : proposal.abstract

  return [
    header,
    `Abstract: ${abstractSnippet}`,
    `Innovation:`,
    ...proposal.innovation.map(item => `  \u2022 ${item}`),
    `Feasibility: ${proposal.feasibility.compute_estimate}, ${proposal.feasibility.timeline_weeks} weeks [score: ${formatScore(proposal.feasibility.score)}/10]`,
    `Risk: ${proposal.risk.level} \u2014 ${proposal.risk.description}`,
    `Novelty: ${formatScore(proposal.novelty_score)}/10 | Impact: ${formatScore(proposal.impact_score)}/10`,
    separator,
  ].join('\n')
}

// ── Propose UI: spinner -> browser ───────────────────────

function ProposeUI({
  count,
  focus,
  more,
  researchDir,
  onDone,
}: {
  count: number
  focus: string | undefined
  more: boolean
  researchDir: string
  onDone: (result: string) => void
}): React.ReactNode {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [startTime] = useState(Date.now())
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [verb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)])

  // Spinner animation
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER.length)
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 80)
    return () => clearInterval(timer)
  }, [])

  // Generate proposals
  useEffect(() => {
    resetCommandUsage()

    // Load existing proposals when --more is set
    let existingProposals: Proposal[] = []
    if (more) {
      const proposalsPath = join(researchDir, 'proposals.json')
      if (existsSync(proposalsPath)) {
        try {
          existingProposals = JSON.parse(
            readFileSync(proposalsPath, 'utf-8'),
          ) as Proposal[]
        } catch {
          // ignore parse errors, generate fresh
        }
      }
    }

    const generator = new ProposalGenerator(DEFAULT_MODEL)
    generator
      .generate({
        count,
        focus,
        include_feasibility: true,
        include_risk: true,
        research_dir: researchDir,
      })
      .then(results => {
        // Merge with existing proposals when --more is set
        const combined =
          more && existingProposals.length > 0
            ? [...existingProposals, ...results]
            : results

        // Save proposals
        try {
          mkdirSync(researchDir, { recursive: true })
          writeFileSync(
            join(researchDir, 'proposals.json'),
            JSON.stringify(combined, null, 2),
            'utf-8',
          )
        } catch {
          // best effort
        }
        setProposals(combined)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  // Error state
  if (error) {
    onDone(`Error generating proposals: ${error}`)
    return null
  }

  // Loading state — animated spinner
  if (!proposals) {
    const mins = Math.floor(elapsed / 60)
    const secs = elapsed % 60
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

    return (
      <FullscreenLayout
        title="Proposals"
        subtitle={`${SPINNER[frame]} ${verb}... ${count} proposal${count !== 1 ? 's' : ''} (${timeStr})`}
        borderColor="#f59e0b"
        accentColor="#fbbf24"
        icon="✦"
      >
        <Box marginTop={2} marginLeft={1}>
          <Text>
            Generating {count} research proposal{count !== 1 ? 's' : ''}
            {focus ? ` (focus: "${focus}")` : ''}...
          </Text>
        </Box>
      </FullscreenLayout>
    )
  }

  // No proposals generated
  if (proposals.length === 0) {
    onDone('No proposals generated. Ensure /deep-research has been run first.')
    return null
  }

  // Proposals ready — show interactive browser
  const browsable: BrowsableProposal[] = proposals.map(p => ({
    id: p.id,
    title: p.title,
    abstract: p.abstract,
    innovation: p.innovation,
    methodology: p.methodology ?? '',
    feasibility: p.feasibility,
    risk: p.risk,
    novelty_score: p.novelty_score,
    impact_score: p.impact_score,
    references: p.references,
  }))

  return (
    <FullscreenLayout
      title="Proposals"
      subtitle={`${proposals.length} proposals`}
      borderColor="#f59e0b"
      accentColor="#fbbf24"
      icon="✦"
      footer={
        <Text dimColor>
          {'<- ->'}
          {' switch  '}Tab: details{'  '}e: edit{'  '}r: regen{'  '}m: more
          {'  '}
          d: diff{'  '}Enter: select{'  '}Esc: exit
        </Text>
      }
    >
      <ProposalBrowser
        proposals={browsable}
        onSelect={selected => {
          const fullProposal = proposals.find(p => p.id === selected.id)
          if (fullProposal) {
            const state = initializeFromProposal(fullProposal, {
              budget_usd: 100,
            })
            saveResearchState(researchDir, state)
          }
          onDone(
            `Selected proposal: "${selected.title}"\nProposals saved to ${join(researchDir, 'proposals.json')}\n${formatUsage(getCommandUsage())}\nRun /run to start the orchestrator.`,
          )
        }}
        onCancel={() => {
          const lines = [
            `Generated ${proposals.length} proposal${proposals.length !== 1 ? 's' : ''}:`,
            '',
            ...proposals.map((p, i) => formatProposal(p, i)),
            `\nProposals saved to ${join(researchDir, 'proposals.json')}`,
            `Run /experiment to begin implementing the top proposal.`,
          ]
          onDone(lines.join('\n'))
        }}
      />
    </FullscreenLayout>
  )
}

// ── Command ──────────────────────────────────────────────

const propose: Command = {
  type: 'local-jsx',
  name: 'propose',
  userFacingName() {
    return 'propose'
  },
  description: 'Generate research proposals based on literature review',
  isEnabled: true,
  isHidden: false,
  argumentHint: '[--count N] [--focus <direction>] [--more]',
  aliases: [],

  async call(
    onDone: (result?: string) => void,
    _context: any,
    args?: string,
  ): Promise<React.ReactNode> {
    const { count, focus, more } = parseArgs(args ?? '')
    const researchDir = getSessionDir()

    return (
      <ProposeUI
        count={count}
        focus={focus}
        more={more}
        researchDir={researchDir}
        onDone={result => onDone(result)}
      />
    )
  },
}

export default propose
