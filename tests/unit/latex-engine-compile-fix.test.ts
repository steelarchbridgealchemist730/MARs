import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

const TMP = join(import.meta.dir, '__latex_compile_fix_tmp__')

// ── Mock LLM client ────────────────────────────────────────
// Must be before any import of modules that depend on llm-client.

let llmCallCount = 0
let llmMockFn: (opts: any) => Promise<any> = async () => ({
  text: '',
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  stop_reason: 'end_turn',
})

mock.module('../../src/paper/llm-client', () => ({
  chatCompletion: async (opts: any) => {
    llmCallCount++
    return llmMockFn(opts)
  },
  loadModelAssignments: () => ({}),
}))

// Import AFTER mock
const { LaTeXEngine } = await import('../../src/paper/writing/latex-engine')

// ── Bun.spawn mock infrastructure ──────────────────────────

const originalSpawn = Bun.spawn

interface SpawnBehavior {
  failUntil: number // compile attempts 1..failUntil will fail, rest succeed
  errorLog: string // log content for failed attempts
  cleanLog: string // log content for successful attempts
}

let compileCount = 0
let spawnBehavior: SpawnBehavior = {
  failUntil: 0,
  errorLog: '',
  cleanLog: 'This is pdfTeX\nOutput written on main.pdf (1 page)',
}

function installSpawnMock() {
  compileCount = 0
  ;(Bun as any).spawn = (cmd: string[], opts: any) => {
    compileCount++
    const texDir = opts?.cwd ?? TMP
    const texBaseName = 'main'

    if (compileCount <= spawnBehavior.failUntil) {
      writeFileSync(
        join(texDir, `${texBaseName}.log`),
        spawnBehavior.errorLog,
        'utf-8',
      )
      // No PDF created on failure
    } else {
      writeFileSync(
        join(texDir, `${texBaseName}.log`),
        spawnBehavior.cleanLog,
        'utf-8',
      )
      writeFileSync(join(texDir, `${texBaseName}.pdf`), 'fake-pdf-content')
    }

    return {
      exited: Promise.resolve(),
      exitCode: compileCount <= spawnBehavior.failUntil ? 1 : 0,
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

// ── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  compileCount = 0
  llmCallCount = 0
  llmMockFn = async () => ({
    text: '',
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    stop_reason: 'end_turn',
  })
})

afterEach(() => {
  restoreSpawn()
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
})

// ── Helper ──────────────────────────────────────────────────

function writeMainTex(content: string) {
  writeFileSync(join(TMP, 'main.tex'), content, 'utf-8')
}

const BASIC_TEX = `\\documentclass{article}
\\begin{document}
Hello world
\\end{document}
`

// ── Tests: compileAndFixDetailed — rule-based fixes ─────────

describe('compileAndFixDetailed — rule-based fixes', () => {
  test('succeeds on first compile (no fixes needed)', async () => {
    writeMainTex(BASIC_TEX)

    spawnBehavior = {
      failUntil: 0,
      errorLog: '',
      cleanLog: 'This is pdfTeX\nOutput written on main.pdf (1 page)',
    }
    installSpawnMock()

    const engine = new LaTeXEngine(TMP)
    const result = await engine.compileAndFixDetailed(
      join(TMP, 'main.tex'),
      'test-model',
    )

    expect(result.success).toBe(true)
    expect(result.attempts).toBe(1)
    expect(result.pdfPath).toBeDefined()
    expect(compileCount).toBe(1)
  })

  test('fixes undefined command (\\toprule) and succeeds on retry', async () => {
    writeMainTex(`\\documentclass{article}
\\begin{document}
\\begin{tabular}{ll}
\\toprule
A & B \\\\
\\bottomrule
\\end{tabular}
\\end{document}
`)

    const undefinedCmdLog = `This is pdfTeX
(./main.tex
! Undefined control sequence.
l.4 \\toprule
`

    spawnBehavior = {
      failUntil: 1,
      errorLog: undefinedCmdLog,
      cleanLog: 'This is pdfTeX\nOutput written on main.pdf (1 page)',
    }
    installSpawnMock()

    const engine = new LaTeXEngine(TMP)
    const result = await engine.compileAndFixDetailed(
      join(TMP, 'main.tex'),
      'test-model',
    )

    expect(result.success).toBe(true)
    expect(result.attempts).toBe(2)

    // Verify booktabs package was inserted
    const tex = readFileSync(join(TMP, 'main.tex'), 'utf-8')
    expect(tex).toContain('\\usepackage{booktabs}')
  })

  test('fixes missing package and succeeds on retry', async () => {
    writeMainTex(`\\documentclass{article}
\\begin{document}
\\url{https://example.com}
\\end{document}
`)

    const missingPkgLog = `This is pdfTeX
(./main.tex
! Undefined control sequence.
l.3 \\url
             {https://example.com}
`

    spawnBehavior = {
      failUntil: 1,
      errorLog: missingPkgLog,
      cleanLog: 'This is pdfTeX\nOutput written on main.pdf (1 page)',
    }
    installSpawnMock()

    const engine = new LaTeXEngine(TMP)
    const result = await engine.compileAndFixDetailed(
      join(TMP, 'main.tex'),
      'test-model',
    )

    expect(result.success).toBe(true)
    expect(result.attempts).toBe(2)

    const tex = readFileSync(join(TMP, 'main.tex'), 'utf-8')
    expect(tex).toContain('\\usepackage{url}')
  })

  test('gives up after max retries with unfixable error', async () => {
    writeMainTex(BASIC_TEX)

    // A package error that the fixer can't fix
    const unfixableLog = `This is pdfTeX
(./main.tex
Package foobar Error: Something went catastrophically wrong.
`

    spawnBehavior = {
      failUntil: 999,
      errorLog: unfixableLog,
      cleanLog: 'not reached',
    }
    installSpawnMock()

    const engine = new LaTeXEngine(TMP)
    const result = await engine.compileAndFixDetailed(
      join(TMP, 'main.tex'),
      'test-model',
      3, // maxRetries
    )

    expect(result.success).toBe(false)
    // Should try once then not be able to fix the package_error
    // compileAndFixDetailed: compile fails -> errors found -> fixers try -> anyFixed false -> llmFix -> false -> break
    // So attempts should be limited
    expect(result.attempts).toBeGreaterThanOrEqual(1)
    expect(result.attempts).toBeLessThanOrEqual(3)
    expect(result.unresolvedIssues.length).toBeGreaterThan(0)
  })
})

// ── Tests: compileAndFixDetailed — LLM fallback ────────────

describe('compileAndFixDetailed — LLM fallback', () => {
  test('falls back to LLM when rule-based fixes fail', async () => {
    writeMainTex(`\\documentclass{article}
\\begin{document}
\\unknowncommand{test}
\\end{document}
`)

    // A syntax error that won't have a rule-based fix
    const syntaxErrorLog = `This is pdfTeX
(./main.tex
! Undefined control sequence.
l.3 \\unknowncommand
                    {test}
`

    spawnBehavior = {
      failUntil: 1,
      errorLog: syntaxErrorLog,
      cleanLog: 'This is pdfTeX\nOutput written on main.pdf (1 page)',
    }
    installSpawnMock()

    // LLM mock returns fixed tex content
    llmMockFn = async () => ({
      text: `\\documentclass{article}
\\begin{document}
\\textbf{test}
\\end{document}
`,
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.01,
      stop_reason: 'end_turn',
    })

    const engine = new LaTeXEngine(TMP)
    const result = await engine.compileAndFixDetailed(
      join(TMP, 'main.tex'),
      'test-model',
    )

    expect(result.success).toBe(true)
    expect(llmCallCount).toBeGreaterThanOrEqual(1)
  })

  test('LLM fallback also fails gracefully', async () => {
    writeMainTex(`\\documentclass{article}
\\begin{document}
\\unknowncommand{test}
\\end{document}
`)

    const syntaxErrorLog = `This is pdfTeX
(./main.tex
! Undefined control sequence.
l.3 \\unknowncommand
                    {test}
`

    spawnBehavior = {
      failUntil: 999,
      errorLog: syntaxErrorLog,
      cleanLog: 'not reached',
    }
    installSpawnMock()

    // LLM mock returns same broken content (still has \\unknowncommand)
    llmMockFn = async () => ({
      text: `\\documentclass{article}
\\begin{document}
\\unknowncommand{test}
\\end{document}
`,
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.01,
      stop_reason: 'end_turn',
    })

    const engine = new LaTeXEngine(TMP)
    const result = await engine.compileAndFixDetailed(
      join(TMP, 'main.tex'),
      'test-model',
      3,
    )

    expect(result.success).toBe(false)
  })
})

// ── Tests: compileDetailed (single compile) ─────────────────

describe('compileDetailed', () => {
  test('returns success when PDF is created with clean log', async () => {
    writeMainTex(BASIC_TEX)

    spawnBehavior = {
      failUntil: 0,
      errorLog: '',
      cleanLog: 'This is pdfTeX\nOutput written on main.pdf (1 page)',
    }
    installSpawnMock()

    const engine = new LaTeXEngine(TMP)
    const result = await engine.compileDetailed(join(TMP, 'main.tex'))

    expect(result.success).toBe(true)
    expect(result.pdfPath).toBeDefined()
    expect(result.issues.length).toBe(0)
  })

  test('returns failure with issues when compile fails', async () => {
    writeMainTex(BASIC_TEX)

    spawnBehavior = {
      failUntil: 1,
      errorLog: `This is pdfTeX
(./main.tex
! Undefined control sequence.
l.3 \\unknowncommand
`,
      cleanLog: '',
    }
    installSpawnMock()

    const engine = new LaTeXEngine(TMP)
    const result = await engine.compileDetailed(join(TMP, 'main.tex'))

    expect(result.success).toBe(false)
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues[0].type).toBe('undefined_command')
  })
})
