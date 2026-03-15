import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Command } from '@commands'
import { getCwd } from '@utils/state'
import { getSessionDir } from '../paper/session'
import { LaTeXEngine } from '../paper/writing/latex-engine'
import { PaperWriter } from '../paper/writing/writer'
import { WritingPipeline } from '../paper/writing/pipeline'
import { NarrativePlanner } from '../paper/writing/narrative-planner'
import { TemplateResolver } from '../paper/writing/template-resolver'
import { loadResearchState } from '../paper/research-state'
import {
  resetCommandUsage,
  getCommandUsage,
  formatUsage,
} from '../paper/llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../paper/types'
import { extractModelId } from '../paper/agent-dispatch'
import {
  FigurePlanBrowser,
  type FigurePlanData,
} from '@components/FigurePlanBrowser'
import type { WritingPipelinePhase } from '../paper/writing/types'

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const VERBS = [
  'Composing',
  'Drafting',
  'Authoring',
  'Typesetting',
  'Inscribing',
  'Penning',
  'Articulating',
  'Formulating',
  'Rendering',
  'Constructing',
]
const DEFAULT_MODEL = extractModelId(DEFAULT_MODEL_ASSIGNMENTS.writing)

const PHASE_LABELS: Record<WritingPipelinePhase, string> = {
  plan: '[1/8] Planning narrative structure',
  bibliography: '[2/8] Syncing bibliography',
  write_sections: '[3/8] Writing sections',
  figures: '[4/8] Generating figures and tables',
  assemble: '[5/8] Assembling paper',
  compile: '[6/8] Compiling LaTeX',
  page_check: '[7/8] Checking page count',
  final_sync: '[8/8] Final compilation',
}

function buildFigurePlan(proposal: any): FigurePlanData {
  return {
    title: proposal.title ?? 'Untitled',
    venue: 'NeurIPS 2026',
    figures: [
      {
        id: 'fig1',
        caption: 'Architecture / system overview',
        type: 'tikz' as const,
        description:
          'High-level architecture diagram showing the main components and data flow.',
      },
      {
        id: 'fig2',
        caption: 'Main results comparison',
        type: 'matplotlib' as const,
        description:
          'Bar or line chart comparing proposed method against baselines.',
      },
      {
        id: 'fig3',
        caption: 'Ablation study',
        type: 'matplotlib' as const,
        description: 'Chart showing the effect of removing key components.',
      },
    ],
    tables: [
      {
        id: 'tab1',
        caption: 'Dataset statistics',
        description:
          'Summary table of datasets used: size, splits, key characteristics.',
      },
      {
        id: 'tab2',
        caption: 'Main quantitative results',
        description:
          'Comparison table with baselines. Highlight best results in bold.',
      },
    ],
    estimated_pages: 9,
  }
}

/**
 * Check if the research state has a populated ClaimGraph with admitted claims.
 */
function hasPopulatedClaimGraph(researchDir: string): boolean {
  try {
    const state = loadResearchState(researchDir)
    if (!state?.claimGraph?.claims) return false
    return state.claimGraph.claims.some((c: any) => c.phase === 'admitted')
  } catch {
    return false
  }
}

// ── Pipeline Write UI ───────────────────────────────────

function PipelineWriteUI({
  researchDir,
  onDone,
}: {
  researchDir: string
  onDone: (result: string) => void
}): React.ReactNode {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [startTime] = useState(Date.now())
  const [phase, setPhase] = useState<string>(
    '[1/8] Planning narrative structure...',
  )

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER.length)
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 80)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    ;(async () => {
      resetCommandUsage()
      try {
        const state = loadResearchState(researchDir)
        if (!state) {
          onDone('No research state found. Run /run first.')
          return
        }

        const pipeline = new WritingPipeline({
          projectDir: researchDir,
          state,
          onProgress: (p: WritingPipelinePhase, msg: string) => {
            const label = PHASE_LABELS[p] ?? p
            setPhase(`${label}: ${msg}`)
          },
        })

        const result = await pipeline.run()

        const lines: string[] = []
        if (result.success && result.pdfPath) {
          lines.push(`PDF compiled successfully: ${result.pdfPath}`)
        } else {
          lines.push('Paper writing completed with issues.')
        }

        lines.push(`Phases completed: ${result.phases_completed.join(' -> ')}`)

        if (result.pageCheck) {
          const pc = result.pageCheck
          lines.push(
            `Pages: ${pc.mainBodyPages}/${pc.limit === 'unlimited' ? 'unlimited' : pc.limit} (${pc.passed ? 'OK' : `over by ${pc.overBy}`})`,
          )
        }

        if (result.warnings.length > 0) {
          lines.push(`\nWarnings (${result.warnings.length}):`)
          for (const w of result.warnings.slice(0, 5)) {
            lines.push(`  - ${w}`)
          }
          if (result.warnings.length > 5) {
            lines.push(`  ... and ${result.warnings.length - 5} more`)
          }
        }

        const usage = formatUsage(getCommandUsage())
        if (usage) lines.push('', usage)
        onDone(lines.join('\n'))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        onDone(`Error in writing pipeline: ${msg}`)
      }
    })()
  }, [])

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

  return (
    <Box flexDirection="column" paddingLeft={1} marginTop={1}>
      <Text dimColor>{'━'.repeat(60)}</Text>
      <Box>
        <Text color="cyan">{SPINNER[frame]} </Text>
        <Text bold>Writing Paper</Text>
        <Text dimColor> ({timeStr})</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>{phase}</Text>
      </Box>
    </Box>
  )
}

// ── Legacy Write UI: spinner while generating ───────────

function LegacyWriteUI({
  researchDir,
  onDone,
}: {
  researchDir: string
  onDone: (result: string) => void
}): React.ReactNode {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [startTime] = useState(Date.now())
  const [verb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)])
  const [stage, setStage] = useState('Loading proposals...')

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER.length)
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 80)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    ;(async () => {
      resetCommandUsage()
      try {
        const proposalsPath = join(researchDir, 'proposals.json')
        if (!existsSync(proposalsPath)) {
          onDone('No proposals.json found. Run /propose first.')
          return
        }

        const proposals = JSON.parse(
          readFileSync(proposalsPath, 'utf-8'),
        ) as any[]
        const proposal = proposals[0]
        if (!proposal) {
          onDone('No proposals found.')
          return
        }

        let experimentResults: any = undefined
        const experimentsDir = join(researchDir, 'experiments')
        if (existsSync(experimentsDir)) {
          const runsDir = join(experimentsDir, '.checkpoints')
          if (existsSync(runsDir)) experimentResults = { runs_dir: runsDir }
        }

        setStage('Creating paper outline...')
        const writer = new PaperWriter(researchDir, DEFAULT_MODEL)
        const outline = await writer.createOutline(proposal, experimentResults)

        setStage(
          `Writing sections: ${outline.sections.map((s: any) => s.name).join(', ')}...`,
        )
        const pdfPath = await writer.writePaper(
          outline,
          existsSync(experimentsDir) ? experimentsDir : undefined,
        )

        const lines = [
          `Paper: "${outline.title}"`,
          `Venue: ${outline.venue}`,
          `Sections: ${outline.sections.map((s: any) => s.name).join(', ')}`,
          `Figures: ${outline.figures.length}, Tables: ${outline.tables.length}`,
          '',
        ]
        if (pdfPath.endsWith('.pdf')) {
          lines.push(`PDF compiled successfully: ${pdfPath}`)
        } else {
          lines.push(`Paper written (LaTeX): ${pdfPath}`)
          lines.push(`Run /write --compile to attempt compilation.`)
        }
        const usage = formatUsage(getCommandUsage())
        if (usage) lines.push('', usage)
        onDone(lines.join('\n'))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        onDone(`Error writing paper: ${msg}`)
      }
    })()
  }, [])

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

  return (
    <Box flexDirection="column" paddingLeft={1} marginTop={1}>
      <Text dimColor>{'━'.repeat(60)}</Text>
      <Box>
        <Text color="cyan">{SPINNER[frame]} </Text>
        <Text bold>{verb}...</Text>
        <Text dimColor> ({timeStr})</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>{stage}</Text>
      </Box>
    </Box>
  )
}

// ── Plan-Only UI ────────────────────────────────────────

function PlanOnlyUI({
  researchDir,
  onDone,
}: {
  researchDir: string
  onDone: (result: string) => void
}): React.ReactNode {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER.length)
    }, 80)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    ;(async () => {
      resetCommandUsage()
      try {
        const state = loadResearchState(researchDir)
        if (!state) {
          onDone('No research state found. Run /run first.')
          return
        }

        const resolver = new TemplateResolver()
        const templateId = (state.proposal as any)?.template ?? 'neurips'
        let resolved
        try {
          resolved = resolver.resolve(templateId)
        } catch {
          resolved = resolver.resolve('neurips')
        }

        const planner = new NarrativePlanner(researchDir, DEFAULT_MODEL)
        const plan = await planner.plan(state, resolved)

        const lines = [
          `Narrative Plan for "${state.proposal?.title ?? 'Paper'}"`,
          '',
          `Narrative Arc:`,
          `  Hook: ${plan.narrative_arc.hook}`,
          `  Gap: ${plan.narrative_arc.gap}`,
          `  Insight: ${plan.narrative_arc.insight}`,
          '',
          `Sections (${plan.sections.length}):`,
          ...plan.sections.map(
            s =>
              `  ${s.name} — "${s.title}" (${s.page_budget} pages, ${s.claims_covered.length} claims, tone: ${s.tone})`,
          ),
          '',
        ]

        if (plan.hero_figure) {
          lines.push(`Hero Figure: ${plan.hero_figure.description}`)
        }
        if (plan.main_table) {
          lines.push(`Main Table: ${plan.main_table.content}`)
        }
        if (plan.appendix_sections.length > 0) {
          lines.push(
            `Appendix: ${plan.appendix_sections.map(a => a.name).join(', ')}`,
          )
        }

        const usage = formatUsage(getCommandUsage())
        if (usage) lines.push('', usage)
        onDone(lines.join('\n'))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        onDone(`Error generating plan: ${msg}`)
      }
    })()
  }, [])

  return (
    <Box>
      <Text color="cyan">{SPINNER[frame]} </Text>
      <Text bold>Generating narrative plan...</Text>
    </Box>
  )
}

// ── Compile UI ───────────────────────────────────────────

function CompileUI({
  researchDir,
  onDone,
}: {
  researchDir: string
  onDone: (result: string) => void
}): React.ReactNode {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [startTime] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER.length)
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 80)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const texPath = join(researchDir, 'paper', 'main.tex')
    if (!existsSync(texPath)) {
      onDone('No paper found. Run /write first.')
      return
    }
    const engine = new LaTeXEngine(researchDir)
    engine
      .compile(texPath)
      .then(result => {
        if (result.success) {
          onDone(`Compilation successful! PDF: ${result.pdf_path}`)
        } else {
          onDone(
            `Compilation failed:\n${result.errors.map((e: any) => `  ${e.type}: ${e.message}`).join('\n')}`,
          )
        }
      })
      .catch(err => {
        onDone(
          `Compile error: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
  }, [])

  const secs = elapsed % 60
  return (
    <Box>
      <Text color="cyan">{SPINNER[frame]} </Text>
      <Text bold>Compiling LaTeX...</Text>
      <Text dimColor> ({secs}s)</Text>
    </Box>
  )
}

// ── Command ──────────────────────────────────────────────

const writePaperCommand: Command = {
  type: 'local-jsx',
  name: 'write-paper',
  userFacingName() {
    return 'write'
  },
  description: 'Write and compile the paper in LaTeX',
  isEnabled: true,
  isHidden: false,
  argumentHint: '[--plan-figures] [--compile] [--plan-only]',
  aliases: [],

  async call(
    onDone: (result?: string) => void,
    _context: any,
    args?: string,
  ): Promise<React.ReactNode> {
    const researchDir = getSessionDir()
    const argsStr = args ?? ''

    // --compile
    if (argsStr.includes('--compile')) {
      return <CompileUI researchDir={researchDir} onDone={r => onDone(r)} />
    }

    // --plan-only
    if (argsStr.includes('--plan-only')) {
      return <PlanOnlyUI researchDir={researchDir} onDone={r => onDone(r)} />
    }

    // --plan-figures
    if (argsStr.includes('--plan-figures')) {
      const proposalsPath = join(researchDir, 'proposals.json')
      if (!existsSync(proposalsPath)) {
        onDone('No proposals.json found. Run /propose first.')
        return null
      }
      let proposals: any[]
      try {
        proposals = JSON.parse(readFileSync(proposalsPath, 'utf-8'))
      } catch {
        onDone('Could not parse proposals.json.')
        return null
      }
      const proposal = proposals[0]
      if (!proposal) {
        onDone('No proposals found.')
        return null
      }
      const plan = buildFigurePlan(proposal)
      return (
        <FigurePlanBrowser
          plan={plan}
          onApprove={() =>
            onDone(
              `Figure plan approved. Run /write to generate the full paper.`,
            )
          }
          onCancel={() => onDone('Figure planning cancelled.')}
        />
      )
    }

    // Auto-detect: claim-driven pipeline if ClaimGraph has admitted claims
    if (hasPopulatedClaimGraph(researchDir)) {
      return (
        <PipelineWriteUI researchDir={researchDir} onDone={r => onDone(r)} />
      )
    }

    // Fallback: legacy outline + write path
    return <LegacyWriteUI researchDir={researchDir} onDone={r => onDone(r)} />
  },
}

export default writePaperCommand
