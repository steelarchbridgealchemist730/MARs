import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { LaTeXFixers } from '../../src/paper/writing/latex-fixers'
import type { DiagnosisIssue } from '../../src/paper/writing/types'

const TMP = join(import.meta.dir, '__latex_fixers_test_tmp__')

function texDir() {
  return join(TMP, 'paper')
}

function writeTexFile(relPath: string, content: string) {
  const dir = join(TMP, ...relPath.split('/').slice(0, -1))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(TMP, relPath), content, 'utf-8')
}

function readTexFile(relPath: string): string {
  return readFileSync(join(TMP, relPath), 'utf-8')
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
})

// ─── fixUndefinedCommand ────────────────────────────────────

describe('fixUndefinedCommand', () => {
  test('inserts \\usepackage{booktabs} for \\toprule', async () => {
    const mainTex = `\\documentclass{article}
\\begin{document}
\\begin{tabular}{cc}
\\toprule
A & B \\\\
\\bottomrule
\\end{tabular}
\\end{document}
`
    writeTexFile('paper/main.tex', mainTex)

    const fixers = new LaTeXFixers(TMP)
    const issue: DiagnosisIssue = {
      type: 'undefined_command',
      severity: 'error',
      message: 'Undefined control sequence \\toprule',
      command: '\\toprule',
      autoFixable: true,
    }

    const result = await fixers.fix(issue, join(TMP, 'paper/main.tex'))
    expect(result).toBe(true)

    const updated = readTexFile('paper/main.tex')
    expect(updated).toContain('\\usepackage{booktabs}')
    expect(updated).toContain('\\begin{document}')
  })

  test('inserts \\usepackage{amsfonts} for \\mathbb', async () => {
    const mainTex = `\\documentclass{article}
\\begin{document}
$\\mathbb{R}$
\\end{document}
`
    writeTexFile('paper/main.tex', mainTex)

    const fixers = new LaTeXFixers(TMP)
    const issue: DiagnosisIssue = {
      type: 'undefined_command',
      severity: 'error',
      message: 'Undefined control sequence \\mathbb',
      command: '\\mathbb',
      autoFixable: true,
    }

    const result = await fixers.fix(issue, join(TMP, 'paper/main.tex'))
    expect(result).toBe(true)

    const updated = readTexFile('paper/main.tex')
    expect(updated).toContain('\\usepackage{amsfonts}')
  })

  test('does not duplicate existing \\usepackage', async () => {
    const mainTex = `\\documentclass{article}
\\usepackage{booktabs}
\\begin{document}
\\toprule
\\end{document}
`
    writeTexFile('paper/main.tex', mainTex)

    const fixers = new LaTeXFixers(TMP)
    const issue: DiagnosisIssue = {
      type: 'undefined_command',
      severity: 'error',
      message: 'Undefined control sequence \\toprule',
      command: '\\toprule',
      autoFixable: true,
    }

    const result = await fixers.fix(issue, join(TMP, 'paper/main.tex'))
    expect(result).toBe(false) // already present

    const updated = readTexFile('paper/main.tex')
    const count = (updated.match(/\\usepackage\{booktabs\}/g) ?? []).length
    expect(count).toBe(1)
  })
})

// ─── fixOverfullHbox ────────────────────────────────────────

describe('fixOverfullHbox', () => {
  test('reduces includegraphics width', async () => {
    const tex = `\\documentclass{article}
\\usepackage{graphicx}
\\begin{document}
Some text
\\includegraphics[width=1.2\\textwidth]{fig.png}
More text
\\end{document}
`
    writeTexFile('paper/section.tex', tex)

    const fixers = new LaTeXFixers(TMP)
    const issue: DiagnosisIssue = {
      type: 'overfull_hbox',
      severity: 'warning',
      message: 'Overfull \\hbox (20pt too wide)',
      file: 'section.tex',
      line: 5,
      overflow_pt: 20,
      autoFixable: true,
    }

    const result = await fixers.fix(issue, join(TMP, 'paper/section.tex'))
    expect(result).toBe(true)

    const updated = readTexFile('paper/section.tex')
    expect(updated).toContain('width=0.95\\columnwidth')
    expect(updated).not.toContain('width=1.2\\textwidth')
  })

  test('wraps tabular in resizebox', async () => {
    const tex = `\\documentclass{article}
\\usepackage{graphicx}
\\begin{document}
Some text
\\begin{tabular}{llllllll}
A & B & C & D & E & F & G & H \\\\
\\end{tabular}
More text
\\end{document}
`
    writeTexFile('paper/table.tex', tex)

    const fixers = new LaTeXFixers(TMP)
    const issue: DiagnosisIssue = {
      type: 'overfull_hbox',
      severity: 'warning',
      message: 'Overfull \\hbox (30pt too wide)',
      file: 'table.tex',
      line: 5,
      overflow_pt: 30,
      autoFixable: true,
    }

    const result = await fixers.fix(issue, join(TMP, 'paper/table.tex'))
    expect(result).toBe(true)

    const updated = readTexFile('paper/table.tex')
    expect(updated).toContain('\\resizebox{\\columnwidth}{!}{\\begin{tabular}')
    expect(updated).toContain('\\end{tabular}}')
  })
})

// ─── fixOverfullVbox ────────────────────────────────────────

describe('fixOverfullVbox', () => {
  test('changes [htbp] to [tb]', async () => {
    const tex = `\\documentclass{article}
\\begin{document}
Some text
\\begin{figure}[htbp]
\\centering
\\includegraphics{fig.png}
\\caption{A figure}
\\end{figure}
More text
\\end{document}
`
    writeTexFile('paper/fig.tex', tex)

    const fixers = new LaTeXFixers(TMP)
    const issue: DiagnosisIssue = {
      type: 'overfull_vbox',
      severity: 'warning',
      message: 'Overfull \\vbox (10pt too high)',
      file: 'fig.tex',
      line: 5,
      overflow_pt: 10,
      autoFixable: true,
    }

    const result = await fixers.fix(issue, join(TMP, 'paper/fig.tex'))
    expect(result).toBe(true)

    const updated = readTexFile('paper/fig.tex')
    expect(updated).toContain('[tb]')
    expect(updated).not.toContain('[htbp]')
  })
})

// ─── fixMissingPackage ──────────────────────────────────────

describe('fixMissingPackage', () => {
  test('inserts \\usepackage{hyperref}', async () => {
    const mainTex = `\\documentclass{article}
\\begin{document}
\\url{https://example.com}
\\end{document}
`
    writeTexFile('paper/main.tex', mainTex)

    const fixers = new LaTeXFixers(TMP)
    const issue: DiagnosisIssue = {
      type: 'missing_package',
      severity: 'error',
      message: "Package 'hyperref' not found",
      packageName: 'hyperref',
      autoFixable: true,
    }

    const result = await fixers.fix(issue, join(TMP, 'paper/main.tex'))
    expect(result).toBe(true)

    const updated = readTexFile('paper/main.tex')
    expect(updated).toContain('\\usepackage{hyperref}')
  })
})

// ─── fixMissingFile ─────────────────────────────────────────

describe('fixMissingFile', () => {
  test('copies .sty from template dir', async () => {
    writeTexFile(
      'paper/main.tex',
      '\\documentclass{article}\n\\begin{document}\n\\end{document}',
    )
    mkdirSync(join(TMP, 'template'), { recursive: true })
    writeFileSync(join(TMP, 'template', 'custom.sty'), '% custom style')

    const fixers = new LaTeXFixers(TMP, {
      templateDir: join(TMP, 'template'),
    })
    const issue: DiagnosisIssue = {
      type: 'missing_file',
      severity: 'error',
      message: "File 'custom.sty' not found",
      missingFile: 'custom.sty',
      autoFixable: true,
    }

    const result = await fixers.fix(issue, join(TMP, 'paper/main.tex'))
    expect(result).toBe(true)
    expect(existsSync(join(TMP, 'paper', 'custom.sty'))).toBe(true)
  })

  test('replaces missing image with placeholder', async () => {
    const mainTex = `\\documentclass{article}
\\usepackage{graphicx}
\\begin{document}
\\includegraphics[width=0.8\\textwidth]{missing.png}
\\end{document}
`
    writeTexFile('paper/main.tex', mainTex)

    const fixers = new LaTeXFixers(TMP)
    const issue: DiagnosisIssue = {
      type: 'missing_file',
      severity: 'error',
      message: "File 'missing.png' not found",
      missingFile: 'missing.png',
      autoFixable: true,
    }

    const result = await fixers.fix(issue, join(TMP, 'paper/main.tex'))
    expect(result).toBe(true)

    const updated = readTexFile('paper/main.tex')
    expect(updated).toContain('Missing image: missing.png')
    expect(updated).toContain('\\fbox')
    expect(updated).not.toContain('\\includegraphics')
  })
})

// ─── Context extraction for LLM fixes ──────────────────────

describe('syntax error context', () => {
  test('returns false for issues without line number', async () => {
    writeTexFile(
      'paper/main.tex',
      '\\documentclass{article}\n\\begin{document}\ntext\n\\end{document}',
    )

    const fixers = new LaTeXFixers(TMP)
    const issue: DiagnosisIssue = {
      type: 'syntax_error',
      severity: 'error',
      message: 'Some syntax error',
      autoFixable: true,
      // No line number — cannot extract context
    }

    const result = await fixers.fix(issue, join(TMP, 'paper/main.tex'))
    expect(result).toBe(false)
  })
})
