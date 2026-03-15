import React from 'react'
import { join } from 'path'
import { existsSync, readFileSync, readdirSync } from 'fs'
import type { Command } from '@commands'
import { CommandSpinner } from '@components/CommandSpinner'
import { ProjectManager } from '../paper/project-manager'
import { AutoModeOrchestrator } from '../paper/auto-mode'
import { getSessionDir, listSessions } from '../paper/session'

const paper: Command = {
  type: 'local-jsx',
  name: 'paper',
  userFacingName() {
    return 'paper'
  },
  description:
    'Claude Paper: academic research automation (init, status, auto, resume)',
  isEnabled: true,
  isHidden: false,
  argumentHint: '<subcommand> [args]',
  aliases: [],

  async call(
    onDone: (result?: string) => void,
    _context: any,
    args?: string,
  ): Promise<React.ReactNode> {
    const argsStr = args ?? ''
    const parts = argsStr.trim().split(/\s+/)
    const subcommand = parts[0] || 'help'
    const restArgs = parts.slice(1).join(' ')

    // Subcommands that need LLM (show spinner)
    if (subcommand === 'ask' && restArgs.trim()) {
      return (
        <CommandSpinner
          label={`Thinking about "${restArgs.slice(0, 40)}..."`}
          runner={() => handleAsk(restArgs)}
          onDone={result => onDone(result)}
        />
      )
    }

    if (subcommand === 'auto' && restArgs.trim()) {
      // Delegate to /auto command logic
      onDone(await handleAuto(restArgs))
      return null
    }

    // Subcommands with spinners
    if (subcommand === 'compile') {
      return (
        <CommandSpinner
          label="Compiling LaTeX..."
          runner={() => handleCompile()}
          onDone={result => onDone(result)}
        />
      )
    }

    // Synchronous subcommands
    let result: string
    switch (subcommand) {
      case 'init':
        result = handleInit(restArgs)
        break
      case 'status':
        result = handleStatus()
        break
      case 'structure':
        result = handleStructure()
        break
      case 'preview':
        result = await handlePreview()
        break
      case 'resume':
        result = handleResume()
        break
      case 'ask':
        result = await handleAsk(restArgs)
        break
      case 'sessions':
        result = handleSessions()
        break
      default:
        result = handleHelp()
    }
    onDone(result)
    return null
  },
}

function handleHelp(): string {
  return [
    'Claude Paper - Academic Research Automation',
    '',
    'Usage:',
    '  /paper init [--template <name>] --topic "<topic>"  Initialize a new project',
    '  /paper status                                       Show project status',
    '  /paper structure                                    Show paper structure and word counts',
    '  /paper compile                                      Compile LaTeX to PDF',
    '  /paper preview                                      Open compiled PDF',
    '  /paper auto "<topic>"                               Auto mode: full pipeline',
    '  /paper resume                                       Resume an existing project',
    '  /paper ask "<question>"                             Ask about your research',
    '  /paper sessions                                     List all research sessions',
    '  /paper help                                         Show this help',
    '',
    'Templates: neurips, icml, aaai, acl, jfe, rfs, custom',
    '',
    'Example:',
    '  /paper init --topic "GARCH model for Bitcoin volatility"',
    '  /paper auto "Rough volatility estimation"',
    '  /paper ask "What are the main research gaps?"',
  ].join('\n')
}

async function handleAsk(query: string): Promise<string> {
  if (!query.trim()) {
    return 'Usage: /paper ask "<question>"\nExample: /paper ask "What are the main research gaps?"'
  }

  const q = query.replace(/^["']|["']$/g, '').trim()
  const sessionDir = getSessionDir()

  // Load all reports as context
  const reportFiles = ['survey.md', 'gaps.md', 'taxonomy.md', 'timeline.md']
  const contextParts: string[] = []
  let totalLen = 0

  for (const file of reportFiles) {
    for (const subdir of ['literature', '']) {
      const filePath = join(sessionDir, subdir, file)
      if (!existsSync(filePath)) continue
      try {
        const content = readFileSync(filePath, 'utf-8')
        if (totalLen + content.length > 60000) break
        contextParts.push(`--- ${file} ---\n${content}`)
        totalLen += content.length
      } catch {
        continue
      }
    }
  }

  if (contextParts.length === 0) {
    return [
      'No research reports found.',
      '',
      'Run /deep-research first to generate reports, then try:',
      '  /paper ask "What are the main research gaps?"',
      '  /paper ask "Give me a summary of all papers"',
    ].join('\n')
  }

  // Send to LLM for intelligent answer
  try {
    const { chatCompletion } = await import('../paper/llm-client')
    const { DEFAULT_MODEL_ASSIGNMENTS } = await import('../paper/types')
    const response = await chatCompletion({
      modelSpec: DEFAULT_MODEL_ASSIGNMENTS.quick,
      max_tokens: 4096,
      system:
        'You are a research assistant. Answer the question based on the provided literature analysis reports. Be specific, cite paper titles, and use bullet points for clarity.',
      messages: [
        {
          role: 'user',
          content: `Research literature context:\n\n${contextParts.join('\n\n')}\n\nQuestion: ${q}`,
        },
      ],
    })
    return response.text || 'No response generated.'
  } catch (err: any) {
    return `Error: ${err.message}`
  }
}

function handleSessions(): string {
  const sessions = listSessions()
  if (sessions.length === 0) {
    return 'No research sessions found. Start one with /deep-research "your topic"'
  }
  const lines = ['Research Sessions:', '']
  for (const s of sessions) {
    lines.push(`  ${s.id}`)
    lines.push(`    Topic: ${s.topic}`)
    lines.push(`    Created: ${s.created_at}`)
    lines.push(`    Last active: ${s.last_active}`)
    lines.push('')
  }
  return lines.join('\n')
}

function handleInit(args: string): string {
  const topicMatch =
    args.match(/--topic\s+"([^"]+)"/) || args.match(/--topic\s+(\S+)/)
  const templateMatch = args.match(/--template\s+(\S+)/)

  if (!topicMatch) {
    // If no --topic flag, treat the entire args as the topic
    const topic = args.replace(/--template\s+\S+/, '').trim()
    if (!topic) {
      return 'Error: Topic is required.\nUsage: /paper init --topic "Your research topic"'
    }
    return initProject(topic, templateMatch?.[1])
  }

  return initProject(topicMatch[1], templateMatch?.[1])
}

function initProject(topic: string, template?: string): string {
  const projectDir = process.cwd()
  const pm = new ProjectManager(projectDir)

  if (pm.isInitialized()) {
    return `Project already initialized at ${projectDir}. Use /paper status to check.`
  }

  const state = pm.initProject(
    topic,
    undefined,
    template ? { paper: { template } as any } : undefined,
  )

  const lines = [
    `Project initialized!`,
    `  Topic: ${state.topic}`,
    `  ID: ${state.id}`,
    `  Template: ${template || 'neurips'}`,
    `  Directory: ${projectDir}`,
    '',
    'Project structure created:',
    '  literature/    - Paper downloads and notes',
    '  proposals/     - Research proposals',
    '  experiments/   - Code, data, and results',
    '  paper/         - LaTeX source files',
    '  reviews/       - Review history',
    '',
    'Next steps:',
    '  /deep-research "<topic>"   Start literature research',
    '  /propose                    Generate research proposals',
    '  /run                        Start the adaptive orchestrator',
    '  /auto --budget 50           Full auto mode',
  ]

  return lines.join('\n')
}

function handleStatus(): string {
  const projectDir = process.cwd()
  const pm = new ProjectManager(projectDir)

  if (!pm.isInitialized()) {
    return 'No project found. Run /paper init first.'
  }

  const state = pm.loadProject()

  const lines = [
    '=== Claude Paper Status ===',
    `Topic: ${state.topic}`,
    `ID: ${state.id}`,
    `Created: ${state.created_at.slice(0, 10)}`,
    '',
  ]

  const artifacts = state.artifacts
  lines.push('Artifacts:')
  if (artifacts.selected_proposal)
    lines.push(`  Proposal: ${artifacts.selected_proposal}`)
  if (artifacts.experiment_code)
    lines.push(`  Code: ${artifacts.experiment_code}`)
  if (artifacts.compiled_pdf) lines.push(`  PDF: ${artifacts.compiled_pdf}`)
  if (
    !artifacts.selected_proposal &&
    !artifacts.experiment_code &&
    !artifacts.compiled_pdf
  ) {
    lines.push('  (none yet)')
  }

  lines.push('')
  lines.push(
    'Use /status for full cognitive state (claims, evidence, stability).',
  )
  lines.push('========================')

  return lines.join('\n')
}

async function handleAuto(args: string): Promise<string> {
  const topic = args.replace(/^["']|["']$/g, '').trim()

  if (!topic) {
    return 'Error: Topic is required.\nUsage: /paper auto "Your research topic"'
  }

  const projectDir = process.cwd()
  const researchDir = join(projectDir, '.claude-paper-research')

  const logs: string[] = []
  const orchestrator = new AutoModeOrchestrator(researchDir)
  const result = await orchestrator.runAdaptive(topic, (msg: string) => {
    logs.push(msg)
  })

  return formatResult(result, logs)
}

function formatResult(
  result: { status: string; artifacts: string[] },
  logs: string[],
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
  }

  lines.push('========================')
  return lines.join('\n')
}

function handleStructure(): string {
  const sessionDir = getSessionDir()
  const paperDir = join(sessionDir, 'paper')
  const sectionsDir = join(paperDir, 'sections')

  if (!existsSync(paperDir)) {
    return 'No paper directory found. Run /write first to generate the paper.'
  }

  const lines = ['=== Paper Structure ===', '']

  // Show main.tex
  const mainTex = join(paperDir, 'main.tex')
  if (existsSync(mainTex)) {
    lines.push('main.tex (present)')
  } else {
    lines.push('main.tex (MISSING)')
  }

  // Show sections
  if (existsSync(sectionsDir)) {
    try {
      const sectionFiles = readdirSync(sectionsDir)
        .filter(f => f.endsWith('.tex'))
        .sort()
      lines.push(`\nSections (${sectionFiles.length}):`)
      for (const f of sectionFiles) {
        const content = readFileSafe(join(sectionsDir, f))
        const wordCount = content.split(/\s+/).filter(Boolean).length
        lines.push(`  ${f} (${wordCount} words)`)
      }
    } catch {
      lines.push('  (could not read sections directory)')
    }
  } else {
    lines.push('\nNo sections directory found.')
  }

  // Show references.bib
  const bibPath = join(paperDir, 'references.bib')
  if (existsSync(bibPath)) {
    try {
      const bibContent = readFileSync(bibPath, 'utf-8')
      const entryCount = (bibContent.match(/@\w+\{/g) || []).length
      lines.push(`\nreferences.bib (${entryCount} entries)`)
    } catch {
      lines.push('\nreferences.bib (present)')
    }
  }

  // Show fragments
  const fragmentsIndex = join(sessionDir, 'fragments', 'index.json')
  if (existsSync(fragmentsIndex)) {
    try {
      const fragments = JSON.parse(readFileSync(fragmentsIndex, 'utf-8'))
      const count = Array.isArray(fragments) ? fragments.length : 0
      lines.push(`\nFragments: ${count}`)
    } catch {
      // skip
    }
  }

  lines.push('\n========================')
  return lines.join('\n')
}

async function handleCompile(): Promise<string> {
  const sessionDir = getSessionDir()
  const paperDir = join(sessionDir, 'paper')
  const mainTex = join(paperDir, 'main.tex')

  if (!existsSync(mainTex)) {
    return 'No main.tex found. Run /write first to generate the paper.'
  }

  try {
    // Try latexmk first, fall back to pdflatex
    const proc = Bun.spawn(
      ['latexmk', '-pdf', '-interaction=nonstopmode', 'main.tex'],
      {
        cwd: paperDir,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    if (exitCode === 0) {
      const pdfPath = join(paperDir, 'main.pdf')
      return existsSync(pdfPath)
        ? `Compilation successful!\nPDF: ${pdfPath}`
        : `Compilation completed but main.pdf not found.\n${stdout.slice(-500)}`
    }

    // Parse errors from log
    const logPath = join(paperDir, 'main.log')
    let errors = ''
    if (existsSync(logPath)) {
      const log = readFileSync(logPath, 'utf-8')
      const errorLines = log
        .split('\n')
        .filter(l => l.startsWith('!') || l.includes('Error'))
        .slice(0, 10)
      errors = errorLines.join('\n')
    }

    return [
      'Compilation failed.',
      errors ? `\nErrors:\n${errors}` : '',
      stderr ? `\nStderr:\n${stderr.slice(-300)}` : '',
    ].join('')
  } catch {
    // latexmk not available, try pdflatex
    try {
      const proc = Bun.spawn(
        ['pdflatex', '-interaction=nonstopmode', 'main.tex'],
        {
          cwd: paperDir,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      await proc.exited
      // Run twice for references
      const proc2 = Bun.spawn(
        ['pdflatex', '-interaction=nonstopmode', 'main.tex'],
        {
          cwd: paperDir,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const exitCode = await proc2.exited

      if (exitCode === 0 && existsSync(join(paperDir, 'main.pdf'))) {
        return `Compilation successful!\nPDF: ${join(paperDir, 'main.pdf')}`
      }
      return 'Compilation failed. Check main.log for details.'
    } catch {
      return 'No LaTeX compiler found. Install texlive or mactex to compile.'
    }
  }
}

async function handlePreview(): Promise<string> {
  const sessionDir = getSessionDir()
  const pdfPath = join(sessionDir, 'paper', 'main.pdf')

  if (!existsSync(pdfPath)) {
    return 'No compiled PDF found. Run /paper compile first.'
  }

  // Try to open the PDF with system viewer
  try {
    const cmd =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'start'
          : 'xdg-open'
    Bun.spawn([cmd, pdfPath], { stdout: 'ignore', stderr: 'ignore' })
    return `Opening PDF: ${pdfPath}`
  } catch {
    return `PDF available at: ${pdfPath}\n(Could not open system viewer)`
  }
}

function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function handleResume(): string {
  const projectDir = process.cwd()
  const pm = new ProjectManager(projectDir)

  if (!pm.isInitialized()) {
    return `No project found at ${projectDir}. Use /paper init to create one.`
  }

  const state = pm.loadProject()

  return [
    `Resuming project: ${state.topic}`,
    '',
    'Use /run to start the adaptive orchestrator.',
    'Use /status for cognitive state overview.',
  ].join('\n')
}

export default paper
