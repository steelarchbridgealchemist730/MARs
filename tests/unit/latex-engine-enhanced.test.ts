import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { LaTeXEngine } from '../../src/paper/writing/latex-engine'
import type { Diagnosis, DiagnosisIssue } from '../../src/paper/writing/types'

const TMP = join(import.meta.dir, '__latex_engine_test_tmp__')

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
})

function writeFile(relPath: string, content: string) {
  const dir = join(TMP, ...relPath.split('/').slice(0, -1))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(TMP, relPath), content, 'utf-8')
}

// ─── diagnoseFromLog ────────────────────────────────────────

describe('diagnoseFromLog', () => {
  test('parses ! errors with line numbers', () => {
    const logContent = `This is pdfTeX, Version 3.14159265
(./main.tex
! Undefined control sequence.
l.42 \\toprule

! Missing $ inserted.
l.55 \\alpha + \\beta
`
    writeFile('test.log', logContent)

    const engine = new LaTeXEngine(TMP)
    const diagnosis = engine.diagnoseFromLog(join(TMP, 'test.log'))

    expect(diagnosis.errorCount).toBe(2)
    const types = diagnosis.issues.map(i => i.type)
    expect(types).toContain('undefined_command')
    expect(types).toContain('math_error')

    const undefinedCmd = diagnosis.issues.find(
      i => i.type === 'undefined_command',
    )
    expect(undefinedCmd).toBeDefined()
    expect(undefinedCmd!.line).toBe(42)
    expect(undefinedCmd!.severity).toBe('error')
  })

  test('parses Overfull \\hbox with overflow_pt', () => {
    const logContent = `(./main.tex
Overfull \\hbox (15.23pt too wide) in paragraph at lines 30--35
`
    writeFile('hbox.log', logContent)

    const engine = new LaTeXEngine(TMP)
    const diagnosis = engine.diagnoseFromLog(join(TMP, 'hbox.log'))

    const hbox = diagnosis.issues.find(i => i.type === 'overfull_hbox')
    expect(hbox).toBeDefined()
    expect(hbox!.overflow_pt).toBeCloseTo(15.23)
    expect(hbox!.severity).toBe('warning')
    expect(hbox!.autoFixable).toBe(true)
    expect(hbox!.line).toBe(30)
  })

  test('parses Overfull \\vbox', () => {
    const logContent = `Overfull \\vbox (8.5pt too high) has occurred while \\output is active
`
    writeFile('vbox.log', logContent)

    const engine = new LaTeXEngine(TMP)
    const diagnosis = engine.diagnoseFromLog(join(TMP, 'vbox.log'))

    const vbox = diagnosis.issues.find(i => i.type === 'overfull_vbox')
    expect(vbox).toBeDefined()
    expect(vbox!.overflow_pt).toBeCloseTo(8.5)
    expect(vbox!.severity).toBe('warning')
  })

  test('parses Citation undefined', () => {
    const logContent = `LaTeX Warning: Citation \`smith2024neural' on page 3 undefined on input line 45.
LaTeX Warning: Citation \`jones2023deep' on page 5 undefined on input line 78.
`
    writeFile('cite.log', logContent)

    const engine = new LaTeXEngine(TMP)
    const diagnosis = engine.diagnoseFromLog(join(TMP, 'cite.log'))

    const citations = diagnosis.issues.filter(
      i => i.type === 'undefined_citation',
    )
    expect(citations.length).toBe(2)
    expect(citations[0]!.citeKey).toBe('smith2024neural')
    expect(citations[1]!.citeKey).toBe('jones2023deep')
  })

  test('parses Reference undefined', () => {
    const logContent = `LaTeX Warning: Reference \`fig:overview' on page 2 undefined on input line 23.
`
    writeFile('ref.log', logContent)

    const engine = new LaTeXEngine(TMP)
    const diagnosis = engine.diagnoseFromLog(join(TMP, 'ref.log'))

    const refs = diagnosis.issues.filter(i => i.type === 'undefined_reference')
    expect(refs.length).toBe(1)
    expect(refs[0]!.refLabel).toBe('fig:overview')
  })

  test('parses File not found', () => {
    const logContent = `! LaTeX Error: File \`custom.sty' not found.
l.3 \\usepackage{custom}
`
    writeFile('file.log', logContent)

    const engine = new LaTeXEngine(TMP)
    const diagnosis = engine.diagnoseFromLog(join(TMP, 'file.log'))

    // The ! error should be classified
    expect(diagnosis.errorCount).toBeGreaterThan(0)
  })

  test('parses Package error', () => {
    const logContent = [
      '(./main.tex',
      "Package hyperref Error: Wrong DVI mode driver option `dvips',",
      '(hyperref)                because XeTeX is detected.',
    ].join('\n')
    writeFile('pkg.log', logContent)

    const engine = new LaTeXEngine(TMP)
    const diagnosis = engine.diagnoseFromLog(join(TMP, 'pkg.log'))

    const pkgError = diagnosis.issues.find(i => i.type === 'package_error')
    expect(pkgError).toBeDefined()
    expect(pkgError!.packageName).toBe('hyperref')
    expect(pkgError!.autoFixable).toBe(false)
  })

  test('tracks current file from parenthesis patterns', () => {
    const logContent = `(./main.tex
(./sections/intro.tex
! Undefined control sequence.
l.10 \\mycommand
)
)
`
    writeFile('track.log', logContent)

    const engine = new LaTeXEngine(TMP)
    const diagnosis = engine.diagnoseFromLog(join(TMP, 'track.log'))

    const issue = diagnosis.issues.find(i => i.type === 'undefined_command')
    expect(issue).toBeDefined()
    expect(issue!.file).toBe('sections/intro.tex')
  })

  test('deduplicates identical issues', () => {
    const logContent = `LaTeX Warning: Citation \`smith2024' on page 1 undefined on input line 10.
LaTeX Warning: Citation \`smith2024' on page 2 undefined on input line 20.
LaTeX Warning: Citation \`jones2023' on page 1 undefined on input line 15.
`
    writeFile('dedup.log', logContent)

    const engine = new LaTeXEngine(TMP)
    const diagnosis = engine.diagnoseFromLog(join(TMP, 'dedup.log'))

    const citations = diagnosis.issues.filter(
      i => i.type === 'undefined_citation',
    )
    // smith2024 should appear only once (deduped by citeKey)
    const smithCount = citations.filter(c => c.citeKey === 'smith2024').length
    expect(smithCount).toBe(1)
    expect(citations.length).toBe(2) // smith2024 + jones2023
  })

  test('returns empty diagnosis for missing log', () => {
    const engine = new LaTeXEngine(TMP)
    const diagnosis = engine.diagnoseFromLog(join(TMP, 'nonexistent.log'))

    expect(diagnosis.issues.length).toBe(0)
    expect(diagnosis.errorCount).toBe(0)
    expect(diagnosis.warningCount).toBe(0)
  })

  test('handles combined errors and warnings in one log', () => {
    const logContent = `This is pdfTeX
(./main.tex
! Undefined control sequence.
l.10 \\toprule

Overfull \\hbox (5.0pt too wide) in paragraph at lines 20--25
LaTeX Warning: Citation \`abc2024' on page 1 undefined on input line 30.
LaTeX Warning: Reference \`tab:results' on page 2 undefined on input line 40.
`
    writeFile('combined.log', logContent)

    const engine = new LaTeXEngine(TMP)
    const diagnosis = engine.diagnoseFromLog(join(TMP, 'combined.log'))

    expect(diagnosis.errorCount).toBe(1) // undefined_command
    expect(diagnosis.warningCount).toBe(3) // hbox + citation + reference
    expect(diagnosis.issues.length).toBe(4)
  })
})

// ─── Constructor options ────────────────────────────────────

describe('LaTeXEngine constructor', () => {
  test('works with no options (backward compatible)', () => {
    const engine = new LaTeXEngine(TMP)
    expect(engine).toBeDefined()
  })

  test('accepts options', () => {
    const engine = new LaTeXEngine(TMP, {
      manifest: null,
      constraints: null,
      bibManager: null,
      templateDir: null,
    })
    expect(engine).toBeDefined()
  })
})
