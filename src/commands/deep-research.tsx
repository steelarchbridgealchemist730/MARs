import React, { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { join } from 'path'
import { existsSync, readFileSync, copyFileSync } from 'fs'
import type { Command } from '@commands'
import { DeepResearchEngine } from '../paper/deep-research/index'
import { getSessionDir } from '../paper/session'
import {
  resetCommandUsage,
  getCommandUsage,
  formatUsage,
} from '../paper/llm-client'
import type { ProgressEvent } from '../paper/deep-research/index'
import type {
  DeepResearchOptions,
  ResearchPlan,
  AcquisitionResult,
} from '../paper/deep-research/types'
import { LiteratureBrowser } from '../ui/components/LiteratureBrowser'
import { FullscreenLayout } from '@components/FullscreenLayout'
import { loadResearchState, saveResearchState } from '../paper/research-state'

function parseArgs(args: string): {
  topic: string
  options: DeepResearchOptions
  continueSession: boolean
  extendSession: boolean
} {
  const continueSession = /--continue(?:\s|$)/.test(args)
  const extendSession = /--extend(?:\s|$)/.test(args)

  // Strip boolean flags before extracting topic
  const stripped = args
    .replace(/--continue(?:\s|$)/g, ' ')
    .replace(/--extend(?:\s|$)/g, ' ')
    .trim()

  const firstFlagIdx = stripped.indexOf(' --')
  const topic =
    firstFlagIdx !== -1
      ? stripped
          .slice(0, firstFlagIdx)
          .trim()
          .replace(/^["']|["']$/g, '')
      : stripped.trim().replace(/^["']|["']$/g, '')

  const options: DeepResearchOptions = {}
  const depthMatch = args.match(/--depth\s+(quick|standard|thorough)/)
  if (depthMatch)
    options.depth = depthMatch[1] as 'quick' | 'standard' | 'thorough'
  const maxPapersMatch = args.match(/--max-papers\s+(\d+)/)
  if (maxPapersMatch) options.max_papers = parseInt(maxPapersMatch[1], 10)
  const sinceMatch = args.match(/--since\s+(\d{4})/)
  if (sinceMatch) options.since_year = parseInt(sinceMatch[1], 10)
  const focusMatch =
    args.match(/--focus\s+"([^"]+)"/) || args.match(/--focus\s+(\S+)/)
  if (focusMatch) options.focus = focusMatch[1]

  return { topic, options, continueSession, extendSession }
}

// ── Bridge deep-research results to ResearchState ─────────

function bridgeDeepResearchToState(projectDir: string): void {
  const state = loadResearchState(projectDir)
  if (!state) return

  const acquiredPath = join(projectDir, 'literature', 'acquired-papers.json')
  if (!existsSync(acquiredPath)) return

  const acquired: AcquisitionResult[] = JSON.parse(
    readFileSync(acquiredPath, 'utf-8'),
  )

  // Papers with downloaded PDFs → deeply_read
  const newDeeplyRead = acquired
    .filter(a => a.status === 'downloaded' || a.status === 'oa_found')
    .map(a => ({
      paper_id:
        a.paper?.arxiv_id ?? a.paper?.doi ?? a.paper?.title?.slice(0, 30) ?? '',
      key_takeaways: [] as string[],
      relevance_to_us: a.paper?.title ?? '',
      useful_techniques: [] as string[],
      potential_conflicts: [] as string[],
    }))

  // Abstract-only papers → aware_but_unread
  const newAware = acquired
    .filter(a => a.status === 'abstract_only')
    .map(a => ({
      paper_id: a.paper?.arxiv_id ?? a.paper?.doi ?? '',
      title: a.paper?.title ?? '',
      why_relevant: 'Discovered during deep research',
    }))

  // Deduplicate against existing entries
  const existingDeep = new Set(
    state.literature_awareness.deeply_read.map(p => p.paper_id),
  )
  const existingAware = new Set(
    state.literature_awareness.aware_but_unread.map(p => p.paper_id),
  )

  const filteredDeep = newDeeplyRead.filter(p => !existingDeep.has(p.paper_id))
  const filteredAware = newAware.filter(p => !existingAware.has(p.paper_id))

  state.literature_awareness = {
    ...state.literature_awareness,
    deeply_read: [...state.literature_awareness.deeply_read, ...filteredDeep],
    aware_but_unread: [
      ...state.literature_awareness.aware_but_unread,
      ...filteredAware,
    ],
    last_comprehensive_search: new Date().toISOString(),
  }

  saveResearchState(projectDir, state)

  // Copy bibliography.bib to project root if it doesn't exist there
  const litBib = join(projectDir, 'literature', 'bibliography.bib')
  const rootBib = join(projectDir, 'bibliography.bib')
  if (existsSync(litBib) && !existsSync(rootBib)) {
    copyFileSync(litBib, rootBib)
  }
}

// ── Progress Bar ──────────────────────────────────────────

function ProgressBar({
  current,
  total,
  width = 30,
}: {
  current: number
  total: number
  width?: number
}): React.ReactNode {
  const pct = total > 0 ? Math.min(current / total, 1) : 0
  const filled = Math.round(pct * width)
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled)
  return (
    <Text>
      {bar} {Math.round(pct * 100)}% ({current}/{total})
    </Text>
  )
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// ── Main Progress UI ──────────────────────────────────────

function ResearchUI({
  topic,
  options,
  researchDir,
  onDone,
}: {
  topic: string
  options: DeepResearchOptions
  researchDir: string
  onDone: (result: string) => void
}): React.ReactNode {
  const [phase, setPhase] = useState(0)
  const [phaseMsg, setPhaseMsg] = useState('Initializing...')
  const [plan, setPlan] = useState<ResearchPlan | null>(null)
  const [discovery, setDiscovery] = useState({
    found: 0,
    target: options.max_papers ?? 100,
    sources: { arxiv: 0, s2: 0, other: 0 },
    latest: null as {
      title: string
      authors: string
      year: number
      citations: number
    } | null,
  })
  const [acquisition, setAcquisition] = useState({
    done: 0,
    total: 0,
    downloaded: 0,
    oa: 0,
    failed: 0,
    current: '',
  })
  const [analysisReport, setAnalysisReport] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [details, setDetails] = useState<string[]>([])
  const [startTime] = useState(Date.now())
  const [elapsed, setElapsed] = useState(0)
  const [frame, setFrame] = useState(0)
  const [completed, setCompleted] = useState(false)
  const [resultText, setResultText] = useState('')

  // Timer + spinner animation
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
      setFrame(f => (f + 1) % SPINNER.length)
    }, 80)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    const progressLines: string[] = []
    resetCommandUsage()

    const engine = new DeepResearchEngine(researchDir, options)
    engine
      .run(
        topic,
        msg => {
          progressLines.push(msg)
        },
        (event: ProgressEvent) => {
          if (cancelled) return
          switch (event.type) {
            case 'phase':
              setPhase(event.phase)
              setPhaseMsg(event.message)
              break
            case 'plan_ready':
              setPlan(event.plan)
              break
            case 'discovery_update':
              setDiscovery({
                found: event.found,
                target: event.target,
                sources: event.sources,
                latest: event.latest ?? null,
              })
              break
            case 'acquisition_update':
              setAcquisition({
                done: event.done,
                total: event.total,
                downloaded: event.downloaded,
                oa: event.oa,
                failed: event.failed,
                current: event.current ?? '',
              })
              break
            case 'analysis_update':
              setAnalysisReport(event.report)
              break
            case 'detail':
              setDetails(prev => [...prev, event.message])
              break
            case 'error':
              setError(event.message)
              break
          }
        },
      )
      .then(result => {
        if (cancelled) return

        // Bridge deep-research results into ResearchState
        try {
          bridgeDeepResearchToState(researchDir)
        } catch {
          // Non-critical — don't fail the UI
        }

        const elapsed = Math.floor((Date.now() - startTime) / 1000)
        const text = [
          `Deep Research Complete: "${topic}" (${elapsed}s)`,
          '',
          ...progressLines,
          '',
          `Results: ${result.papers_found} papers found, ${result.papers_acquired} PDFs acquired`,
          '',
          'Generated reports:',
          `  ${result.survey_path}`,
          `  ${result.gaps_path}`,
          `  ${result.taxonomy_path}`,
          `  ${result.timeline_path}`,
          `  ${result.index_dir}/bibliography.bib`,
          '',
          `Usage: ${formatUsage(getCommandUsage())}`,
          '',
          'Next steps:',
          '  /papers search <query>  Search discovered papers',
          '  /papers ask <question>  Ask questions about the literature',
          '  /propose                Generate research proposals from gaps',
        ].join('\n')
        setResultText(text)
        setCompleted(true)
      })
      .catch(err => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        onDone(
          [`Deep research failed: ${msg}`, '', ...progressLines].join('\n'),
        )
      })

    return () => {
      cancelled = true
    }
  }, [])

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
  const usage = getCommandUsage()
  const tokenStr =
    usage.input_tokens + usage.output_tokens > 0
      ? ` | ${((usage.input_tokens + usage.output_tokens) / 1000).toFixed(1)}k tokens | $${usage.cost_usd.toFixed(4)}`
      : ''

  if (completed) {
    return (
      <FullscreenLayout
        title="Literature Browser"
        borderColor="#06b6d4"
        accentColor="#3b82f6"
        icon="◇"
        footer={
          <Text dimColor>
            {'<- ->'}
            {' switch  /: search  ?: ask  Enter/q: exit'}
          </Text>
        }
      >
        <LiteratureBrowser
          researchDir={researchDir}
          onDone={() => onDone(resultText)}
        />
      </FullscreenLayout>
    )
  }

  const depthLabel = options.depth ?? 'standard'
  const subtitle = `"${topic}" · ${depthLabel} · ${timeStr}${tokenStr}`
  const footerContent = (
    <Text dimColor>
      Phase {phase}/4 | {discovery.found} papers found | Esc: exit
    </Text>
  )

  return (
    <FullscreenLayout
      title="Deep Research"
      subtitle={subtitle}
      borderColor="#06b6d4"
      accentColor="#3b82f6"
      icon="◇"
      footer={footerContent}
    >
      <Box flexDirection="column">
        {/* Error */}
        {error && (
          <Box marginTop={1}>
            <Text color="red" bold>
              Error: {error}
            </Text>
          </Box>
        )}

        {/* Phase 1: Plan */}
        {phase >= 1 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={phase === 1 ? 'yellow' : 'green'}>
              {phase > 1 ? '✓' : SPINNER[frame]} Phase 1: Research Planning
            </Text>
            {plan && (
              <Box flexDirection="column" marginLeft={2}>
                <Text dimColor>
                  {plan.dimensions.length} dimensions |{' '}
                  {plan.key_authors.length} key authors |{' '}
                  {plan.key_venues.length} venues
                </Text>
                {plan.dimensions.slice(0, 3).map((d, i) => (
                  <Box key={i}>
                    <Text dimColor>
                      {' '}
                      {i + 1}. {d.name}
                    </Text>
                  </Box>
                ))}
                {plan.dimensions.length > 3 && (
                  <Text dimColor>
                    {' '}
                    ... and {plan.dimensions.length - 3} more
                  </Text>
                )}
              </Box>
            )}
          </Box>
        )}

        {/* Phase 2: Discovery */}
        {phase >= 2 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={phase === 2 ? 'yellow' : 'green'}>
              {phase > 2 ? '✓' : SPINNER[frame]} Phase 2: Paper Discovery
            </Text>
            <Box marginLeft={2} flexDirection="column">
              <Box>
                <ProgressBar
                  current={discovery.found}
                  total={discovery.target}
                />
              </Box>
              <Text dimColor>
                Sources: arXiv: {discovery.sources.arxiv} | S2:{' '}
                {discovery.sources.s2} | Other: {discovery.sources.other}
              </Text>
              {discovery.latest && (
                <Text dimColor>
                  Latest: &quot;{discovery.latest.title.slice(0, 50)}...&quot; (
                  {discovery.latest.year}, {discovery.latest.citations} cites)
                </Text>
              )}
            </Box>
          </Box>
        )}

        {/* Phase 3: Acquisition */}
        {phase >= 3 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={phase === 3 ? 'yellow' : 'green'}>
              {phase > 3 ? '✓' : SPINNER[frame]} Phase 3: PDF Acquisition
            </Text>
            <Box marginLeft={2} flexDirection="column">
              <Box>
                <ProgressBar
                  current={acquisition.done}
                  total={acquisition.total}
                />
              </Box>
              <Text dimColor>
                Downloaded: {acquisition.downloaded} | OA: {acquisition.oa} |
                Failed: {acquisition.failed}
              </Text>
              {acquisition.current && (
                <Text dimColor>{acquisition.current}</Text>
              )}
            </Box>
          </Box>
        )}

        {/* Phase 4: Analysis */}
        {phase >= 4 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={phase === 4 ? 'yellow' : 'green'}>
              {analysisReport === 'complete' ? '✓' : SPINNER[frame]} Phase 4:
              Literature Analysis
            </Text>
            <Box marginLeft={2}>
              <Text dimColor>
                {analysisReport === 'complete'
                  ? 'Generated: survey, gaps, taxonomy, timeline, bibliography'
                  : `Generating ${analysisReport || 'reports'}...`}
              </Text>
            </Box>
          </Box>
        )}

        {/* Detail log */}
        {details.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            {details.slice(-4).map((d, i) => (
              <Box key={i}>
                <Text dimColor>{d}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </FullscreenLayout>
  )
}

// ── Command ───────────────────────────────────────────────

const deepResearch: Command = {
  type: 'local-jsx',
  name: 'deep-research',
  userFacingName() {
    return 'deep-research'
  },
  description:
    'Deep literature research (4-phase: plan, discover, acquire, analyze)',
  isEnabled: true,
  isHidden: false,
  argumentHint:
    '<topic> [--depth quick|standard|thorough] [--max-papers N] [--since YEAR] [--focus <direction>] [--continue] [--extend]',
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
          'Usage: /deep-research <topic> [options]',
          '',
          'Options:',
          '  --depth quick|standard|thorough   Search depth (default: standard)',
          '  --max-papers N                    Max papers to find (default: 100)',
          '  --since YEAR                      Only papers since year (default: 2019)',
          '  --focus "direction"               Narrow focus within topic',
          '  --continue                        Resume an interrupted session (no topic needed)',
          '  --extend                          Extend existing session with more sources',
          '',
          'Examples:',
          '  /deep-research "rough volatility estimation"',
          '  /deep-research "transformer pruning" --depth thorough --max-papers 200',
          '  /deep-research "diffusion models" --since 2022 --focus "sampling acceleration"',
          '  /deep-research --continue',
          '  /deep-research --extend --max-papers 50',
        ].join('\n'),
      )
      return null
    }

    const { topic, options, continueSession, extendSession } =
      parseArgs(argsStr)

    // --continue or --extend: find existing session, no topic required
    if (continueSession || extendSession) {
      const researchDir = topic ? getSessionDir(topic) : getSessionDir()
      options.continue_from = researchDir
      if (extendSession) {
        options.extend_discovery = true
      }

      // Read topic from previous plan if available
      let displayTopic = topic
      if (!displayTopic) {
        try {
          const planPath = join(researchDir, 'literature', 'research-plan.json')
          if (existsSync(planPath)) {
            const prevPlan = JSON.parse(readFileSync(planPath, 'utf-8'))
            displayTopic = prevPlan.topic || 'resumed session'
          }
        } catch {
          // fall through
        }
        displayTopic = displayTopic || 'resumed session'
      }

      return (
        <ResearchUI
          topic={displayTopic}
          options={options}
          researchDir={researchDir}
          onDone={result => onDone(result)}
        />
      )
    }

    if (!topic) {
      onDone(
        'Error: Could not parse topic. Wrap it in quotes if it contains special characters.',
      )
      return null
    }

    const researchDir = getSessionDir(topic)

    return (
      <ResearchUI
        topic={topic}
        options={options}
        researchDir={researchDir}
        onDone={result => onDone(result)}
      />
    )
  },
}

export default deepResearch
