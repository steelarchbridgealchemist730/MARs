import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'fs'
import { join } from 'path'
import {
  makeMinimalState,
  makeNarrativePlan,
  MOCK_CHAT_RESPONSE,
} from './writing-test-helpers'
import type { WritingPipelinePhase } from '../../src/paper/writing/types'

const TMP = join(import.meta.dir, '__writing_pipeline_integration_tmp__')

// ── Mock LLM client ────────────────────────────────────────

const MOCK_PLAN = makeNarrativePlan()

let llmCallCount = 0
let llmMockFn: (opts: any) => Promise<any>

function defaultLlmMock(opts: any) {
  const system = opts.system ?? ''
  if (system.includes('writing strategist'))
    return MOCK_CHAT_RESPONSE(JSON.stringify(MOCK_PLAN))
  if (system.includes('academic writer'))
    return MOCK_CHAT_RESPONSE(
      '\\label{sec:test}\nSome content about our method.',
    )
  if (system.includes('LaTeX debugger') || system.includes('LaTeX expert'))
    return MOCK_CHAT_RESPONSE(
      '\\documentclass{article}\n\\begin{document}\nFixed\n\\end{document}',
    )
  if (system.includes('paper editor')) return MOCK_CHAT_RESPONSE('[]')
  if (system.includes('academic editor'))
    return MOCK_CHAT_RESPONSE('Compressed content.')
  return MOCK_CHAT_RESPONSE('Generic response')
}

mock.module('../../src/paper/llm-client', () => ({
  chatCompletion: async (opts: any) => {
    llmCallCount++
    return llmMockFn(opts)
  },
  loadModelAssignments: () => ({}),
}))

// ── Mock Bun.spawn ─────────────────────────────────────────

const originalSpawn = Bun.spawn
let compilerShouldFail = false

function installSpawnMock() {
  ;(Bun as any).spawn = (cmd: string[], opts: any) => {
    const binary = cmd[0] ?? ''
    const texDir = opts?.cwd ?? TMP

    // pdfinfo: return page count
    if (binary === 'pdfinfo') {
      const pdfPath = cmd[1] ?? ''
      const fakeStdout = existsSync(pdfPath) ? 'Pages:          3\n' : ''
      return {
        exited: Promise.resolve(),
        exitCode: existsSync(pdfPath) ? 0 : 1,
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(fakeStdout))
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close()
          },
        }),
      }
    }

    // Compiler commands (pdflatex, bibtex, latexmk)
    if (compilerShouldFail) {
      writeFileSync(
        join(texDir, 'main.log'),
        'This is pdfTeX\n! Fatal error occurred.\n! Emergency stop.',
        'utf-8',
      )
      return {
        exited: Promise.resolve(),
        exitCode: 1,
        stdout: new ReadableStream({
          start(c) {
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close()
          },
        }),
      }
    }

    // Success: write log and PDF
    writeFileSync(
      join(texDir, 'main.log'),
      'This is pdfTeX\nOutput written on main.pdf (3 pages)',
      'utf-8',
    )
    writeFileSync(join(texDir, 'main.pdf'), 'fake-pdf')
    return {
      exited: Promise.resolve(),
      exitCode: 0,
      stdout: new ReadableStream({
        start(c) {
          c.close()
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close()
        },
      }),
    }
  }
}

function restoreSpawn() {
  ;(Bun as any).spawn = originalSpawn
}

// Import AFTER mocks
const { WritingPipeline } = await import('../../src/paper/writing/pipeline')

// ── Setup / Teardown ────────────────────────────────────────

function setupProjectDir() {
  const paperDir = join(TMP, 'paper')
  const sectionsDir = join(paperDir, 'sections')
  mkdirSync(sectionsDir, { recursive: true })

  writeFileSync(
    join(paperDir, 'main.tex'),
    `\\documentclass{article}
\\begin{document}
\\title{Test Paper}
\\author{
  Alice \\\\
  \\And
  Bob \\\\
}
\\maketitle
\\input{sections/introduction}
\\input{sections/methodology}
\\input{sections/conclusion}
\\bibliography{bibliography}
\\end{document}
`,
    'utf-8',
  )

  writeFileSync(join(paperDir, 'bibliography.bib'), '', 'utf-8')
  return paperDir
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  llmCallCount = 0
  compilerShouldFail = false
  llmMockFn = defaultLlmMock
  installSpawnMock()
})

afterEach(() => {
  restoreSpawn()
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
})

// ── Tests ───────────────────────────────────────────────────

describe('WritingPipeline.run() — mocked end-to-end', () => {
  test('completes all 8 phases', async () => {
    setupProjectDir()
    const state = makeMinimalState()

    const pipeline = new WritingPipeline({
      projectDir: TMP,
      state,
      templateId: 'custom',
      modelSpec: 'test-model',
    })

    const result = await pipeline.run()

    expect(result.success).toBe(true)
    expect(result.phases_completed).toContain('plan')
    expect(result.phases_completed).toContain('bibliography')
    expect(result.phases_completed).toContain('write_sections')
    expect(result.phases_completed).toContain('figures')
    expect(result.phases_completed).toContain('assemble')
    expect(result.phases_completed).toContain('compile')
    expect(result.phases_completed).toContain('page_check')
    expect(result.phases_completed).toContain('final_sync')
    expect(result.phases_completed.length).toBe(8)
    expect(result.pdfPath).toBeDefined()

    // Verify sections were written
    const sectionsDir = join(TMP, 'paper', 'sections')
    const files = readdirSync(sectionsDir).filter(f => f.endsWith('.tex'))
    expect(files.length).toBeGreaterThan(0)

    // Verify narrative plan was saved
    const planPath = join(TMP, 'paper', 'narrative-plan.json')
    expect(existsSync(planPath)).toBe(true)
  })

  test('fails gracefully when narrative planning fails', async () => {
    setupProjectDir()
    const state = makeMinimalState()

    llmMockFn = async () => {
      throw new Error('LLM API timeout')
    }

    const pipeline = new WritingPipeline({
      projectDir: TMP,
      state,
      templateId: 'custom',
      modelSpec: 'test-model',
    })

    const result = await pipeline.run()

    expect(result.success).toBe(false)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.some(w => w.includes('failed'))).toBe(true)
    expect(result.phases_completed).not.toContain('plan')
  })

  test('tracks progress via onProgress callback', async () => {
    setupProjectDir()
    const state = makeMinimalState()

    const progressCalls: Array<{
      phase: WritingPipelinePhase
      message: string
    }> = []

    const pipeline = new WritingPipeline({
      projectDir: TMP,
      state,
      templateId: 'custom',
      modelSpec: 'test-model',
      onProgress: (phase, message) => {
        progressCalls.push({ phase, message })
      },
    })

    await pipeline.run()

    expect(progressCalls.length).toBeGreaterThan(0)
    const phases = progressCalls.map(p => p.phase)
    expect(phases).toContain('plan')
    expect(phases).toContain('write_sections')
    expect(phases).toContain('compile')
  })

  test('compilation failure returns partial result', async () => {
    setupProjectDir()
    const state = makeMinimalState()
    compilerShouldFail = true
    installSpawnMock()

    const pipeline = new WritingPipeline({
      projectDir: TMP,
      state,
      templateId: 'custom',
      modelSpec: 'test-model',
    })

    const result = await pipeline.run()

    expect(result.success).toBe(false)
    expect(result.phases_completed).toContain('plan')
    expect(result.phases_completed).toContain('bibliography')
    expect(result.phases_completed).toContain('write_sections')
    expect(result.phases_completed).toContain('figures')
    expect(result.phases_completed).toContain('assemble')
    expect(result.phases_completed).not.toContain('compile')
  })

  test('handles template not found gracefully', async () => {
    setupProjectDir()
    const state = makeMinimalState()

    const pipeline = new WritingPipeline({
      projectDir: TMP,
      state,
      templateId: 'nonexistent_template_xyz',
      modelSpec: 'test-model',
    })

    const result = await pipeline.run()

    expect(result.warnings.some(w => w.includes('not found'))).toBe(true)
    expect(result.phases_completed.length).toBeGreaterThan(0)
  })
})
