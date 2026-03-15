import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { chatCompletion } from '../llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import type { BibTeXManager } from './bibtex-manager'
import type { VenueConstraints } from './template-types'
import type { DiagnosisIssue } from './types'

// ── Command → Package mapping ────────────────────────────

const COMMAND_PACKAGE_MAP: Record<string, string> = {
  '\\toprule': 'booktabs',
  '\\midrule': 'booktabs',
  '\\bottomrule': 'booktabs',
  '\\cmidrule': 'booktabs',
  '\\mathbb': 'amsfonts',
  '\\mathcal': 'amsfonts',
  '\\boldsymbol': 'bm',
  '\\bm': 'bm',
  '\\url': 'url',
  '\\href': 'hyperref',
  '\\resizebox': 'graphicx',
  '\\scalebox': 'graphicx',
  '\\rotatebox': 'graphicx',
  '\\includegraphics': 'graphicx',
  '\\multirow': 'multirow',
  '\\xspace': 'xspace',
  '\\textcolor': 'xcolor',
  '\\colorbox': 'xcolor',
  '\\definecolor': 'xcolor',
  '\\SI': 'siunitx',
  '\\si': 'siunitx',
  '\\num': 'siunitx',
  '\\subcaption': 'subcaption',
  '\\subfloat': 'subfig',
  '\\algorithmic': 'algorithmicx',
  '\\Require': 'algorithmicx',
  '\\Ensure': 'algorithmicx',
  '\\State': 'algorithmicx',
  '\\tikz': 'tikz',
  '\\usetikzlibrary': 'tikz',
  '\\pgfplotstableread': 'pgfplotstable',
  '\\theoremstyle': 'amsthm',
  '\\DeclareMathOperator': 'amsmath',
  '\\operatorname': 'amsmath',
  '\\text': 'amsmath',
  '\\intertext': 'amsmath',
  '\\xleftarrow': 'amsmath',
  '\\xrightarrow': 'amsmath',
  '\\cancel': 'cancel',
  '\\nicefrac': 'nicefrac',
  '\\adjustbox': 'adjustbox',
}

// ── LaTeXFixers ──────────────────────────────────────────

export class LaTeXFixers {
  private projectDir: string
  private bibManager: BibTeXManager | null
  private constraints: VenueConstraints | null
  private modelName: string
  private templateDir: string | null

  constructor(
    projectDir: string,
    options?: {
      bibManager?: BibTeXManager | null
      constraints?: VenueConstraints | null
      modelName?: string
      templateDir?: string | null
    },
  ) {
    this.projectDir = projectDir
    this.bibManager = options?.bibManager ?? null
    this.constraints = options?.constraints ?? null
    this.modelName = options?.modelName ?? DEFAULT_MODEL_ASSIGNMENTS.quick
    this.templateDir = options?.templateDir ?? null
  }

  /**
   * Dispatch a fix for a given diagnosis issue.
   * Returns true if the fix was applied.
   */
  async fix(issue: DiagnosisIssue, texPath: string): Promise<boolean> {
    const texDir = dirname(texPath)

    switch (issue.type) {
      case 'undefined_citation':
        return this.fixUndefinedCitation(issue, texDir)
      case 'undefined_reference':
        return this.fixUndefinedReference(issue, texPath)
      case 'undefined_command':
        return this.fixUndefinedCommand(issue, texPath)
      case 'overfull_hbox':
        return this.fixOverfullHbox(issue, texPath)
      case 'overfull_vbox':
        return this.fixOverfullVbox(issue, texPath)
      case 'syntax_error':
        return this.fixSyntaxError(issue, texPath)
      case 'missing_file':
        return this.fixMissingFile(issue, texPath)
      case 'missing_package':
        return this.fixMissingPackage(issue, texPath)
      case 'math_error':
        return this.fixMathError(issue, texPath)
      case 'package_error':
        return false // Package errors usually need manual intervention
      default:
        return false
    }
  }

  /**
   * Fix undefined citation by:
   * 1. bibManager.syncFromLiterature()
   * 2. fuzzy match findClosestKey()
   * 3. autoFixCiteKey() (S2 lookup)
   * 4. LLM targeted fallback
   */
  async fixUndefinedCitation(
    issue: DiagnosisIssue,
    texDir: string,
  ): Promise<boolean> {
    const citeKey = issue.citeKey
    if (!citeKey) return false

    if (!this.bibManager) {
      // No bib manager — try running bibtex as last resort
      return this.runBibtex(texDir)
    }

    // 1. Sync from literature bib
    const litBibPath = join(this.projectDir, 'bibliography.bib')
    if (existsSync(litBibPath)) {
      const paperDir = join(this.projectDir, 'paper')
      await this.bibManager.syncFromLiterature(litBibPath, paperDir)
      if (this.bibManager.hasKey(citeKey)) return true
    }

    // 2. Fuzzy match
    const closest = await this.bibManager.findClosestKey(citeKey)
    if (closest) {
      // Replace the broken key in all .tex files
      this.replaceCiteKeyInTexFiles(texDir, citeKey, closest)
      return true
    }

    // 3. Auto-fix via S2 lookup
    const fixed = await this.bibManager.autoFixCiteKey(citeKey)
    if (fixed) return true

    // 4. Run bibtex as fallback
    return this.runBibtex(texDir)
  }

  /**
   * Fix overfull hbox by:
   * 1. Check if it's an \includegraphics — reduce width
   * 2. Check if it's a table — wrap in \resizebox
   * 3. Check if it's math — try multline/aligned
   * 4. LLM shorten +-5 lines
   */
  async fixOverfullHbox(
    issue: DiagnosisIssue,
    texPath: string,
  ): Promise<boolean> {
    if (!issue.file || !issue.line) return false

    const targetPath = this.resolveTexFile(issue.file, texPath)
    if (!targetPath || !existsSync(targetPath)) return false

    const content = readFileSync(targetPath, 'utf-8')
    const lines = content.split('\n')
    const lineIdx = issue.line - 1
    if (lineIdx < 0 || lineIdx >= lines.length) return false

    // Get context around the problematic line
    const start = Math.max(0, lineIdx - 3)
    const end = Math.min(lines.length, lineIdx + 4)
    const context = lines.slice(start, end).join('\n')

    // Strategy 1: \includegraphics width reduction
    if (context.includes('\\includegraphics')) {
      const newContext = context.replace(
        /\\includegraphics\[([^\]]*?)width\s*=\s*[^\],]+/g,
        '\\includegraphics[$1width=0.95\\columnwidth',
      )
      if (newContext !== context) {
        const newContent = [
          ...lines.slice(0, start),
          ...newContext.split('\n'),
          ...lines.slice(end),
        ].join('\n')
        writeFileSync(targetPath, newContent, 'utf-8')
        return true
      }
    }

    // Strategy 2: Table environment — wrap in \resizebox
    if (
      context.includes('\\begin{tabular') &&
      !context.includes('\\resizebox')
    ) {
      const newContext = context
        .replace(
          /\\begin\{tabular\}/,
          '\\resizebox{\\columnwidth}{!}{\\begin{tabular}',
        )
        .replace(/\\end\{tabular\}/, '\\end{tabular}}')
      if (newContext !== context) {
        const newContent = [
          ...lines.slice(0, start),
          ...newContext.split('\n'),
          ...lines.slice(end),
        ].join('\n')
        writeFileSync(targetPath, newContent, 'utf-8')
        return true
      }
    }

    // Strategy 3: Math environment — convert equation to multline
    if (
      context.includes('\\begin{equation') &&
      !context.includes('\\begin{multline')
    ) {
      const newContext = context
        .replace(/\\begin\{equation\*?\}/, '\\begin{multline*}')
        .replace(/\\end\{equation\*?\}/, '\\end{multline*}')
      if (newContext !== context) {
        const newContent = [
          ...lines.slice(0, start),
          ...newContext.split('\n'),
          ...lines.slice(end),
        ].join('\n')
        writeFileSync(targetPath, newContent, 'utf-8')
        return true
      }
    }

    // Strategy 4: LLM targeted fix on +-5 lines
    return this.llmFixContext(
      targetPath,
      lineIdx,
      5,
      'Fix the overfull hbox. Shorten the content to fit within the column width without losing meaning.',
    )
  }

  /**
   * Fix overfull vbox by:
   * 1. Change float placement [htbp] -> [tb]
   * 2. Add \clearpage if needed
   */
  async fixOverfullVbox(
    issue: DiagnosisIssue,
    texPath: string,
  ): Promise<boolean> {
    if (!issue.file || !issue.line) return false

    const targetPath = this.resolveTexFile(issue.file, texPath)
    if (!targetPath || !existsSync(targetPath)) return false

    const content = readFileSync(targetPath, 'utf-8')
    const lines = content.split('\n')
    const lineIdx = issue.line - 1
    if (lineIdx < 0 || lineIdx >= lines.length) return false

    // Strategy 1: Change float placement
    const start = Math.max(0, lineIdx - 5)
    const end = Math.min(lines.length, lineIdx + 6)
    const context = lines.slice(start, end).join('\n')

    if (context.includes('[htbp]') || context.includes('[!htbp]')) {
      const newContext = context.replace(/\[!?htbp\]/g, '[tb]')
      if (newContext !== context) {
        const newContent = [
          ...lines.slice(0, start),
          ...newContext.split('\n'),
          ...lines.slice(end),
        ].join('\n')
        writeFileSync(targetPath, newContent, 'utf-8')
        return true
      }
    }

    // Strategy 2: Add \clearpage before the problematic area
    if (lineIdx > 0) {
      lines.splice(lineIdx, 0, '\\clearpage')
      writeFileSync(targetPath, lines.join('\n'), 'utf-8')
      return true
    }

    return false
  }

  /**
   * Fix syntax error by extracting +-5 lines context and asking LLM to fix.
   */
  async fixSyntaxError(
    issue: DiagnosisIssue,
    texPath: string,
  ): Promise<boolean> {
    if (!issue.line) return false

    const targetPath = issue.file
      ? this.resolveTexFile(issue.file, texPath)
      : texPath
    if (!targetPath || !existsSync(targetPath)) return false

    return this.llmFixContext(
      targetPath,
      issue.line - 1,
      5,
      `Fix the LaTeX syntax error: ${issue.message}`,
    )
  }

  /**
   * Fix missing file by:
   * 1. Image -> placeholder
   * 2. .bbl -> run bibtex
   * 3. .sty -> copy from templateDir
   */
  async fixMissingFile(
    issue: DiagnosisIssue,
    texPath: string,
  ): Promise<boolean> {
    const missingFile = issue.missingFile
    if (!missingFile) return false

    const texDir = dirname(texPath)

    // .bbl file — run bibtex
    if (missingFile.endsWith('.bbl')) {
      return this.runBibtex(texDir)
    }

    // .sty file — copy from template dir
    if (missingFile.endsWith('.sty') && this.templateDir) {
      const stySource = join(this.templateDir, missingFile)
      if (existsSync(stySource)) {
        copyFileSync(stySource, join(texDir, missingFile))
        return true
      }
    }

    // Image file — add a placeholder
    if (/\.(png|jpg|jpeg|pdf|eps)$/i.test(missingFile)) {
      const content = readFileSync(texPath, 'utf-8')
      // Replace the \includegraphics referencing the missing file with a placeholder
      const escaped = missingFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(
        `\\\\includegraphics(\\[[^\\]]*\\])?\\{${escaped}\\}`,
      )
      if (pattern.test(content)) {
        const newContent = content.replace(
          pattern,
          '% Missing image: ' +
            missingFile +
            '\n\\fbox{\\parbox{0.8\\columnwidth}{\\centering Image not found: ' +
            missingFile +
            '}}',
        )
        writeFileSync(texPath, newContent, 'utf-8')
        return true
      }
    }

    return false
  }

  /**
   * Fix undefined command by looking up COMMAND_PACKAGE_MAP and inserting \usepackage.
   */
  async fixUndefinedCommand(
    issue: DiagnosisIssue,
    texPath: string,
  ): Promise<boolean> {
    const command = issue.command
    if (!command) return false

    // Look up the command in our mapping
    const pkg = COMMAND_PACKAGE_MAP[command]
    if (pkg) {
      return this.insertUsepackage(texPath, pkg)
    }

    // If we can't find the package, try LLM fix on context
    if (issue.line) {
      return this.llmFixContext(
        texPath,
        issue.line - 1,
        5,
        `Fix the undefined control sequence "${command}". Either add the required package or replace with an alternative.`,
      )
    }

    return false
  }

  /**
   * Fix undefined reference by re-running bibtex/biber.
   */
  async fixUndefinedReference(
    issue: DiagnosisIssue,
    texPath: string,
  ): Promise<boolean> {
    const texDir = dirname(texPath)
    return this.runBibtex(texDir)
  }

  /**
   * Fix missing package by inserting \usepackage{name} before \begin{document}.
   */
  async fixMissingPackage(
    issue: DiagnosisIssue,
    texPath: string,
  ): Promise<boolean> {
    const pkg = issue.packageName
    if (!pkg) return false
    return this.insertUsepackage(texPath, pkg)
  }

  /**
   * Fix math error by targeted LLM fix on +-5 lines.
   */
  async fixMathError(issue: DiagnosisIssue, texPath: string): Promise<boolean> {
    if (!issue.line) return false

    const targetPath = issue.file
      ? this.resolveTexFile(issue.file, texPath)
      : texPath
    if (!targetPath || !existsSync(targetPath)) return false

    return this.llmFixContext(
      targetPath,
      issue.line - 1,
      5,
      `Fix the math error: ${issue.message}`,
    )
  }

  // ── Internal helpers ──────────────────────────────────

  /**
   * Insert \usepackage{pkg} before \begin{document} in the main tex file.
   * Finds the main tex file by looking for \begin{document}.
   */
  private insertUsepackage(texPath: string, pkg: string): boolean {
    // Find the file containing \begin{document}
    const mainTexPath = this.findMainTexFile(texPath)
    if (!mainTexPath) return false

    const content = readFileSync(mainTexPath, 'utf-8')
    const usepackageLine = `\\usepackage{${pkg}}`

    if (content.includes(usepackageLine)) return false // already present

    const newContent = content.replace(
      /\\begin\{document\}/,
      `${usepackageLine}\n\\begin{document}`,
    )

    if (newContent === content) return false

    writeFileSync(mainTexPath, newContent, 'utf-8')
    return true
  }

  /**
   * Find the main tex file (the one containing \begin{document}).
   * If the given file has it, use that. Otherwise look for main.tex in the same dir.
   */
  private findMainTexFile(texPath: string): string | null {
    if (existsSync(texPath)) {
      const content = readFileSync(texPath, 'utf-8')
      if (content.includes('\\begin{document}')) return texPath
    }

    // Try main.tex in the same directory
    const mainPath = join(dirname(texPath), 'main.tex')
    if (existsSync(mainPath)) {
      const content = readFileSync(mainPath, 'utf-8')
      if (content.includes('\\begin{document}')) return mainPath
    }

    return texPath // fallback
  }

  /**
   * Resolve a filename from a log entry to an absolute path.
   * Log files often use relative paths like ./sections/intro.tex
   */
  private resolveTexFile(
    logFileName: string,
    mainTexPath: string,
  ): string | null {
    const texDir = dirname(mainTexPath)

    // Try as-is
    if (existsSync(logFileName)) return logFileName

    // Try relative to tex directory
    const resolved = join(texDir, logFileName.replace(/^\.\//, ''))
    if (existsSync(resolved)) return resolved

    // Fall back to main tex path
    return existsSync(mainTexPath) ? mainTexPath : null
  }

  /**
   * Replace a cite key in all .tex files under the directory.
   */
  private replaceCiteKeyInTexFiles(
    texDir: string,
    oldKey: string,
    newKey: string,
  ): void {
    const { readdirSync } = require('fs') as typeof import('fs')
    let files: string[]
    try {
      files = (
        readdirSync(texDir, { recursive: true }) as unknown as string[]
      ).filter(f => f.endsWith('.tex'))
    } catch {
      return
    }

    const escaped = oldKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(escaped, 'g')

    for (const relPath of files) {
      const fullPath = join(texDir, relPath)
      try {
        const content = readFileSync(fullPath, 'utf-8')
        const newContent = content.replace(pattern, newKey)
        if (newContent !== content) {
          writeFileSync(fullPath, newContent, 'utf-8')
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  /**
   * Run bibtex in the given directory.
   */
  private async runBibtex(texDir: string): Promise<boolean> {
    // Find the .aux file
    const { readdirSync } = require('fs') as typeof import('fs')
    let auxBase = 'main'
    try {
      const files = readdirSync(texDir) as string[]
      const auxFile = files.find(f => f.endsWith('.aux'))
      if (auxFile) {
        auxBase = auxFile.replace(/\.aux$/, '')
      }
    } catch {
      // Use default
    }

    try {
      const proc = Bun.spawn(['bibtex', auxBase], {
        cwd: texDir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await proc.exited
      return proc.exitCode === 0
    } catch {
      return false
    }
  }

  /**
   * LLM-targeted fix: extract +-N lines around the error, ask LLM to fix,
   * and replace those lines in the file.
   */
  private async llmFixContext(
    filePath: string,
    lineIdx: number,
    contextLines: number,
    instruction: string,
  ): Promise<boolean> {
    if (!existsSync(filePath)) return false

    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    const start = Math.max(0, lineIdx - contextLines)
    const end = Math.min(lines.length, lineIdx + contextLines + 1)
    const contextSnippet = lines.slice(start, end).join('\n')

    try {
      const response = await chatCompletion({
        modelSpec: this.modelName,
        max_tokens: 2048,
        system: `You are a LaTeX expert. Fix the issue in the provided LaTeX snippet. Return ONLY the corrected LaTeX snippet (the same number of lines or fewer), no markdown fences or explanations.`,
        messages: [
          {
            role: 'user',
            content: `${instruction}\n\nLines ${start + 1}-${end} of ${basename(filePath)}:\n\`\`\`latex\n${contextSnippet}\n\`\`\`\n\nReturn ONLY the corrected snippet.`,
          },
        ],
      })

      let fixed = response.text
        .replace(/^```(?:latex|tex)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim()

      if (!fixed || fixed.length < 5) return false

      // Replace the context in the original file
      const newLines = [
        ...lines.slice(0, start),
        ...fixed.split('\n'),
        ...lines.slice(end),
      ]
      writeFileSync(filePath, newLines.join('\n'), 'utf-8')
      return true
    } catch {
      return false
    }
  }
}
