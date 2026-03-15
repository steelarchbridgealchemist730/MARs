import React from 'react'
import { join } from 'path'
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs'
import type { Command } from '@commands'
import { CommandSpinner } from '@components/CommandSpinner'
import { ExperimentRunner, ResourceEstimator } from '../paper/experiment'
import type { ExperimentPlan, ExperimentRun } from '../paper/experiment'
import { probeSystem } from '../paper/system-probe'
import { getSessionDir } from '../paper/session'
import { getAnthropicClient } from '../paper/llm-client'
import type { Proposal } from '../paper/proposal/types'

function client() {
  return getAnthropicClient()
}

function getCwd(): string {
  return process.cwd()
}

function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function formatExperimentStatus(cwd: string): string {
  const runsDir = join(
    cwd,
    '.claude-paper-research',
    'experiments',
    '.checkpoints',
  )

  if (!existsSync(runsDir)) {
    return 'No experiment runs found. Run /experiment to start one.'
  }

  let entries: string[]
  try {
    entries = readdirSync(runsDir).filter(f => f.endsWith('.json'))
  } catch {
    return 'Could not read experiment runs directory.'
  }

  if (entries.length === 0) {
    return 'No experiment runs found. Run /experiment to start one.'
  }

  const lines: string[] = ['=== Experiment Runs ===', '']

  for (const entry of entries.sort().reverse().slice(0, 10)) {
    const runPath = join(runsDir, entry)
    try {
      const run: ExperimentRun = JSON.parse(readFileSync(runPath, 'utf-8'))
      const statusIcon =
        run.status === 'completed'
          ? '[ok]'
          : run.status === 'failed'
            ? '[fail]'
            : run.status === 'running'
              ? '[run]'
              : '[...]'
      lines.push(`${statusIcon} ${run.id}`)
      lines.push(`     plan: ${run.plan_id}`)
      lines.push(`     status: ${run.status}`)
      if (run.started_at) lines.push(`     started: ${run.started_at}`)
      if (run.completed_at) lines.push(`     completed: ${run.completed_at}`)
      if (run.exit_code !== undefined)
        lines.push(`     exit_code: ${run.exit_code}`)
      if (Object.keys(run.metrics).length > 0) {
        const mStr = Object.entries(run.metrics)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
        lines.push(`     metrics: ${mStr}`)
      }
      if (run.error) lines.push(`     error: ${run.error.slice(0, 120)}`)
      lines.push('')
    } catch {
      lines.push(`[?] ${entry} (could not parse)`)
      lines.push('')
    }
  }

  return lines.join('\n')
}

async function generateExperimentPlan(
  proposal: Proposal,
  modelName: string,
): Promise<ExperimentPlan> {
  const systemPrompt = `You are an expert research scientist. Given a research proposal, generate a concrete experiment plan as JSON with exactly this structure:
{
  "title": "string",
  "description": "string",
  "scripts": [
    {
      "name": "string",
      "filename": "string (e.g. main.py)",
      "description": "string",
      "language": "python"
    }
  ],
  "dependencies": ["package1", "package2"],
  "datasets": [
    {
      "name": "string",
      "source": "string",
      "auto_downloadable": true,
      "instructions": "string (optional)",
      "estimated_size_gb": 0.1
    }
  ]
}
Return ONLY the JSON object, no markdown fences or extra text. Keep dependencies minimal and realistic. Use common packages (numpy, pandas, scikit-learn, matplotlib, etc.) as appropriate.`

  const userContent = `Generate an experiment plan for this research proposal:

Title: ${proposal.title}
Abstract: ${proposal.abstract}
Methodology: ${proposal.methodology}
Feasibility data: ${proposal.feasibility.data_required}
Compute estimate: ${proposal.feasibility.compute_estimate}`

  const response = await client().messages.create({
    model: modelName,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  })

  const rawText =
    response.content[0].type === 'text' ? response.content[0].text : '{}'

  let parsed: any = {}
  try {
    parsed = JSON.parse(rawText)
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        parsed = JSON.parse(match[0])
      } catch {
        parsed = {}
      }
    }
  }

  const now = new Date().toISOString()
  const planId = `plan-${Date.now()}`

  const plan: ExperimentPlan = {
    id: planId,
    proposal_id: proposal.id,
    title: parsed.title ?? proposal.title,
    description: parsed.description ?? proposal.abstract,
    scripts: Array.isArray(parsed.scripts)
      ? parsed.scripts.map((s: any) => ({
          name: s.name ?? 'main',
          filename: s.filename ?? 'main.py',
          description: s.description ?? '',
          language: (s.language ?? 'python') as 'python' | 'bash' | 'r',
        }))
      : [
          {
            name: 'main',
            filename: 'main.py',
            description: 'Main experiment script',
            language: 'python' as const,
          },
        ],
    dependencies: Array.isArray(parsed.dependencies)
      ? parsed.dependencies.map(String)
      : [],
    datasets: Array.isArray(parsed.datasets)
      ? parsed.datasets.map((d: any) => ({
          name: d.name ?? 'dataset',
          source: d.source ?? 'custom',
          auto_downloadable: d.auto_downloadable ?? false,
          instructions: d.instructions,
          estimated_size_gb: d.estimated_size_gb,
        }))
      : [],
    resource_estimate: {
      gpu_required: false,
      ram_gb: 8,
      disk_gb: 5,
      estimated_wall_time_hours: 1,
      feasible: true,
    },
    created_at: now,
  }

  return plan
}

async function runExperiment(cwd: string, args: string): Promise<string> {
  const researchDir = getSessionDir()
  const proposalsPath = join(researchDir, 'proposals.json')

  // Parse --proposal N flag
  const proposalMatch = args.match(/--proposal\s+(\d+)/)
  const proposalIndex = proposalMatch ? parseInt(proposalMatch[1], 10) - 1 : 0

  // Load proposals
  let proposals: Proposal[] = []
  const proposalsRaw = readFileSafe(proposalsPath)
  if (proposalsRaw) {
    try {
      proposals = JSON.parse(proposalsRaw)
    } catch {
      proposals = []
    }
  }

  if (proposals.length === 0) {
    return [
      'No proposals found.',
      '',
      'Please run /deep-research <topic> and /propose first to generate research proposals.',
      `Expected proposals at: ${proposalsPath}`,
    ].join('\n')
  }

  const idx = Math.max(0, Math.min(proposalIndex, proposals.length - 1))
  const proposal = proposals[idx]

  const outputLines: string[] = [
    `Experiment Agent`,
    ``,
    `Selected proposal [${idx + 1}/${proposals.length}]: ${proposal.title}`,
    ``,
  ]

  // Probe system
  outputLines.push('Probing system capabilities...')
  const systemCaps = await probeSystem()

  // Generate experiment plan via LLM
  outputLines.push('Generating experiment plan...')
  const { extractModelId } = await import('../paper/agent-dispatch')
  const { DEFAULT_MODEL_ASSIGNMENTS } = await import('../paper/types')
  const modelName =
    process.env.CLAUDE_PAPER_CODING_MODEL ??
    extractModelId(DEFAULT_MODEL_ASSIGNMENTS.coding)

  let plan: ExperimentPlan
  try {
    plan = await generateExperimentPlan(proposal, modelName)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    outputLines.push(`Failed to generate experiment plan: ${msg}`)
    return outputLines.join('\n')
  }

  // Estimate resources
  const estimator = new ResourceEstimator()
  const estimate = await estimator.estimate(plan, systemCaps)
  plan.resource_estimate = estimate

  outputLines.push('')
  outputLines.push('Resource Estimate:')
  outputLines.push(`  GPU required: ${estimate.gpu_required ? 'yes' : 'no'}`)
  if (estimate.gpu_hours !== undefined)
    outputLines.push(`  GPU hours: ~${estimate.gpu_hours}`)
  if (estimate.peak_vram_gb !== undefined)
    outputLines.push(`  Peak VRAM: ~${estimate.peak_vram_gb} GB`)
  outputLines.push(`  RAM: ~${estimate.ram_gb} GB`)
  outputLines.push(`  Disk: ~${estimate.disk_gb} GB`)
  outputLines.push(
    `  Wall time: ~${estimate.estimated_wall_time_hours} hour(s)`,
  )
  outputLines.push(`  Feasible: ${estimate.feasible ? 'yes' : 'NO'}`)
  if (estimate.bottleneck)
    outputLines.push(`  Bottleneck: ${estimate.bottleneck}`)
  outputLines.push('')

  if (!estimate.feasible) {
    outputLines.push('Experiment is not feasible on this system. Aborting run.')
    outputLines.push(`Reason: ${estimate.bottleneck ?? 'unknown'}`)
    return outputLines.join('\n')
  }

  outputLines.push(`Experiment Plan: ${plan.title}`)
  outputLines.push(`  Dependencies: ${plan.dependencies.join(', ') || 'none'}`)
  outputLines.push(`  Scripts: ${plan.scripts.map(s => s.filename).join(', ')}`)
  outputLines.push('')

  // Use experiments subdir inside the research dir
  const experimentProjectDir = researchDir

  // Generate experiment scripts via LLM
  outputLines.push('Generating experiment scripts...')
  const runner = new ExperimentRunner(experimentProjectDir)
  try {
    await runner.generateScript(plan, modelName)
    outputLines.push(
      `Generated script: ${plan.scripts[0]?.filename ?? 'main.py'}`,
    )
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    outputLines.push(
      `Warning: Could not generate script via LLM (${msg}). Using placeholder.`,
    )
  }

  outputLines.push('')
  outputLines.push('Starting experiment run...')
  outputLines.push('')

  // Run and stream output
  let run: ExperimentRun
  try {
    run = await runner.run(plan, (line: string) => {
      outputLines.push(`  | ${line}`)
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    outputLines.push(`Experiment run failed: ${msg}`)
    return outputLines.join('\n')
  }

  outputLines.push('')
  outputLines.push('=== Run Complete ===')
  outputLines.push(`  Run ID: ${run.id}`)
  outputLines.push(`  Status: ${run.status}`)
  if (run.exit_code !== undefined)
    outputLines.push(`  Exit code: ${run.exit_code}`)
  if (run.logs_path) outputLines.push(`  Logs: ${run.logs_path}`)
  if (Object.keys(run.metrics).length > 0) {
    outputLines.push('  Metrics:')
    for (const [k, v] of Object.entries(run.metrics)) {
      outputLines.push(`    ${k}: ${v}`)
    }
  }
  if (run.error) {
    outputLines.push(`  Error: ${run.error.slice(0, 300)}`)
  }

  return outputLines.join('\n')
}

async function resumeExperiment(cwd: string, runId: string): Promise<string> {
  const researchDir = getSessionDir()
  const runsDir = join(researchDir, 'experiments', '.checkpoints')

  // Find the run file
  let runFile = join(runsDir, `${runId}.json`)
  if (!existsSync(runFile)) {
    // Try partial match
    const files = existsSync(runsDir)
      ? readdirSync(runsDir).filter(
          f => f.startsWith(runId) && f.endsWith('.json'),
        )
      : []
    if (files.length === 0) return `Run "${runId}" not found.`
    runFile = join(runsDir, files[0])
  }

  let run: ExperimentRun
  try {
    run = JSON.parse(readFileSync(runFile, 'utf-8'))
  } catch {
    return `Could not parse run file: ${runFile}`
  }

  if (run.status === 'completed') {
    return `Run ${run.id} already completed (exit code: ${run.exit_code}).`
  }

  if (run.status === 'running') {
    return `Run ${run.id} is currently running. Use --abort to stop it first.`
  }

  // Re-run the experiment with the original plan
  const runner = new ExperimentRunner(researchDir)

  // Load the original plan from persisted plans
  const plan = runner.loadPlan(run.plan_id)
  if (!plan) {
    return [
      `Could not find original experiment plan "${run.plan_id}".`,
      'The plan may have been created before plan persistence was added.',
      'Please run /experiment again to create a new experiment.',
    ].join('\n')
  }

  const lines: string[] = [
    `Resuming experiment run ${run.id}...`,
    `  Plan: ${plan.title}`,
    `  Scripts: ${plan.scripts.map(s => s.filename).join(', ')}`,
    '',
  ]

  let newRun: ExperimentRun
  try {
    newRun = await runner.run(plan, (line: string) => {
      lines.push(`  | ${line}`)
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Failed to resume experiment: ${msg}`
  }

  lines.push('')
  lines.push('=== Resumed Run Complete ===')
  lines.push(`  Run ID: ${newRun.id}`)
  lines.push(`  Status: ${newRun.status}`)
  if (newRun.exit_code !== undefined)
    lines.push(`  Exit code: ${newRun.exit_code}`)

  return lines.join('\n')
}

function abortExperiment(cwd: string, runId: string): string {
  const researchDir = getSessionDir()
  const runsDir = join(researchDir, 'experiments', '.checkpoints')

  let runFile = join(runsDir, `${runId}.json`)
  if (!existsSync(runFile)) {
    const files = existsSync(runsDir)
      ? readdirSync(runsDir).filter(
          f => f.startsWith(runId) && f.endsWith('.json'),
        )
      : []
    if (files.length === 0) return `Run "${runId}" not found.`
    runFile = join(runsDir, files[0])
  }

  let run: ExperimentRun
  try {
    run = JSON.parse(readFileSync(runFile, 'utf-8'))
  } catch {
    return `Could not parse run file: ${runFile}`
  }

  if (run.status === 'completed') {
    return `Run ${run.id} is already completed.`
  }

  // Mark as aborted
  run.status = 'failed' as any
  run.error = 'Aborted by user'
  run.completed_at = new Date().toISOString()

  try {
    writeFileSync(runFile, JSON.stringify(run, null, 2), 'utf-8')
    return `Run ${run.id} aborted.`
  } catch {
    return `Failed to update run file.`
  }
}

const experiment: Command = {
  type: 'local-jsx',
  name: 'experiment',
  userFacingName() {
    return 'experiment'
  },
  description: 'Design and run experiments with resource-aware isolation',
  isEnabled: true,
  isHidden: false,
  argumentHint: '[--status] [--resume <id>] [--abort <id>]',
  aliases: [],

  async call(
    onDone: (result?: string) => void,
    _context: any,
    args?: string,
  ): Promise<React.ReactNode> {
    const argsStr = args ?? ''
    const parts = argsStr.trim().split(/\s+/)
    const subcommand = parts[0] || ''

    if (subcommand === '--status' || subcommand === 'status') {
      onDone(formatExperimentStatus(getCwd()))
      return null
    }

    if (subcommand === '--resume' || subcommand === 'resume') {
      const runId = parts[1]
      if (!runId) {
        onDone(
          'Usage: /experiment --resume <run-id>\nUse /experiment --status to see run IDs.',
        )
        return null
      }
      const runsDir = join(getSessionDir(), 'experiments', '.checkpoints')
      const runFile = join(runsDir, `${runId}.json`)
      if (!existsSync(join(runsDir, `${runId}.json`))) {
        // Try partial match
        const matchingFiles = existsSync(runsDir)
          ? readdirSync(runsDir).filter(
              f => f.startsWith(runId) && f.endsWith('.json'),
            )
          : []
        if (matchingFiles.length === 0) {
          onDone(
            `Run "${runId}" not found. Use /experiment --status to see available run IDs.`,
          )
          return null
        }
      }
      return (
        <CommandSpinner
          label={`Resuming experiment ${runId}...`}
          runner={() => resumeExperiment(getCwd(), runId)}
          onDone={result => onDone(result)}
        />
      )
    }

    if (subcommand === '--abort' || subcommand === 'abort') {
      const runId = parts[1]
      if (!runId) {
        onDone(
          'Usage: /experiment --abort <run-id>\nUse /experiment --status to see run IDs.',
        )
        return null
      }
      onDone(abortExperiment(getCwd(), runId))
      return null
    }

    return (
      <CommandSpinner
        label="Running experiment..."
        runner={() => runExperiment(getCwd(), argsStr)}
        onDone={result => onDone(result)}
      />
    )
  },
}

export default experiment
