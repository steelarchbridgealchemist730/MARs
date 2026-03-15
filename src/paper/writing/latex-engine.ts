import { existsSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { chatCompletion } from '../llm-client'
import { LaTeXFixers } from './latex-fixers'
import type { BibTeXManager } from './bibtex-manager'
import type { TemplateManifest, VenueConstraints } from './template-types'
import type {
  DiagnosisIssue,
  DiagnosisIssueType,
  DiagnosisSeverity,
  CompilationAttempt,
  CompilationResult,
  Diagnosis,
} from './types'

// ── Legacy types (kept for backward compat with parseLog callers) ──

interface LaTeXError {
  type:
    | 'undefined_command'
    | 'missing_package'
    | 'math_error'
    | 'reference_error'
    | 'file_not_found'
    | 'other'
  message: string
  line?: number
  context?: string
}

function classifyError(message: string): LaTeXError['type'] {
  if (
    message.includes('Undefined control sequence') ||
    message.includes('undefined control')
  )
    return 'undefined_command'
  if (message.includes('File') && message.includes('not found'))
    return 'file_not_found'
  if (
    message.includes('Missing $') ||
    message.includes('math mode') ||
    message.includes('Display math')
  )
    return 'math_error'
  if (
    message.includes('Citation') ||
    message.includes('Reference') ||
    message.includes('Label') ||
    message.includes('undefined reference')
  )
    return 'reference_error'
  if (message.includes('Package') || message.includes('usepackage'))
    return 'missing_package'
  return 'other'
}

// ── LaTeXEngine Options ──────────────────────────────────

export interface LaTeXEngineOptions {
  manifest?: TemplateManifest | null
  constraints?: VenueConstraints | null
  bibManager?: BibTeXManager | null
  templateDir?: string | null
}

// ── LaTeXEngine ──────────────────────────────────────────

export class LaTeXEngine {
  private projectDir: string
  private manifest: TemplateManifest | null
  private constraints: VenueConstraints | null
  private bibManager: BibTeXManager | null
  private templateDir: string | null

  constructor(projectDir: string, options?: LaTeXEngineOptions) {
    this.projectDir = projectDir
    this.manifest = options?.manifest ?? null
    this.constraints = options?.constraints ?? null
    this.bibManager = options?.bibManager ?? null
    this.templateDir = options?.templateDir ?? null
  }

  // ── Legacy compile (unchanged API) ──────────────────────

  async compile(texPath: string): Promise<{
    success: boolean
    errors: LaTeXError[]
    warnings: string[]
    pdf_path?: string
  }> {
    const texDir = dirname(texPath)
    const texBase = basename(texPath)

    const proc = Bun.spawn(
      [
        'latexmk',
        '-pdf',
        '-pdflatex=pdflatex -interaction=nonstopmode',
        '-halt-on-error',
        texBase,
      ],
      {
        cwd: texDir,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    await proc.exited

    const logPath = join(texDir, texBase.replace(/\.tex$/, '.log'))
    const { errors, warnings } = this.parseLog(logPath)

    const exitCode = proc.exitCode ?? 1
    const pdfPath = texPath.replace(/\.tex$/, '.pdf')

    if (exitCode === 0 && existsSync(pdfPath)) {
      return { success: true, errors, warnings, pdf_path: pdfPath }
    }

    return { success: false, errors, warnings }
  }

  // ── Legacy compileAndFix (delegates to compileAndFixDetailed) ──

  async compileAndFix(
    texPath: string,
    modelName: string,
    maxRetries = 15,
  ): Promise<boolean> {
    const result = await this.compileAndFixDetailed(
      texPath,
      modelName,
      maxRetries,
    )
    return result.success
  }

  // ── New: compileDetailed ──────────────────────────────

  /**
   * Compile using template manifest sequence if available,
   * falling back to latexmk. Returns a structured CompilationAttempt.
   */
  async compileDetailed(texPath: string): Promise<CompilationAttempt> {
    const texDir = dirname(texPath)
    const texBase = basename(texPath)
    const texBaseName = texBase.replace(/\.tex$/, '')

    if (this.manifest) {
      // Use manifest compilation sequence
      return this.compileWithSequence(
        texPath,
        this.manifest.compilation.sequence,
      )
    }

    // Fallback: latexmk
    const proc = Bun.spawn(
      [
        'latexmk',
        '-pdf',
        '-pdflatex=pdflatex -interaction=nonstopmode',
        '-halt-on-error',
        texBase,
      ],
      {
        cwd: texDir,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    await proc.exited

    const logPath = join(texDir, `${texBaseName}.log`)
    const diagnosis = this.diagnoseFromLog(logPath)
    const exitCode = proc.exitCode ?? 1
    const pdfPath = texPath.replace(/\.tex$/, '.pdf')

    return {
      success: exitCode === 0 && existsSync(pdfPath),
      issues: diagnosis.issues,
      warnings: diagnosis.issues
        .filter(i => i.severity === 'warning')
        .map(i => i.message),
      pdfPath: existsSync(pdfPath) ? pdfPath : null,
      logExcerpt: this.getLogExcerpt(logPath),
    }
  }

  /**
   * Compile using a specific sequence of commands (e.g., ['pdflatex', 'bibtex', 'pdflatex', 'pdflatex']).
   */
  private async compileWithSequence(
    texPath: string,
    sequence: string[],
  ): Promise<CompilationAttempt> {
    const texDir = dirname(texPath)
    const texBase = basename(texPath)
    const texBaseName = texBase.replace(/\.tex$/, '')

    for (const step of sequence) {
      let cmd: string[]
      if (step === 'bibtex' || step === 'biber') {
        cmd = [step, texBaseName]
      } else {
        // pdflatex, xelatex, lualatex
        cmd = [step, '-interaction=nonstopmode', '-halt-on-error', texBase]
      }

      const proc = Bun.spawn(cmd, {
        cwd: texDir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await proc.exited
    }

    // After full sequence, diagnose from log
    const logPath = join(texDir, `${texBaseName}.log`)
    const diagnosis = this.diagnoseFromLog(logPath)
    const pdfPath = texPath.replace(/\.tex$/, '.pdf')

    return {
      success: existsSync(pdfPath) && diagnosis.errorCount === 0,
      issues: diagnosis.issues,
      warnings: diagnosis.issues
        .filter(i => i.severity === 'warning')
        .map(i => i.message),
      pdfPath: existsSync(pdfPath) ? pdfPath : null,
      logExcerpt: this.getLogExcerpt(logPath),
    }
  }

  // ── New: diagnoseFromLog ──────────────────────────────

  /**
   * Enhanced log parser that produces structured DiagnosisIssue objects.
   * Parses errors, overfull boxes, undefined citations/references, and more.
   */
  diagnoseFromLog(logPath: string): Diagnosis {
    const issues: DiagnosisIssue[] = []

    if (!existsSync(logPath)) {
      return { issues, errorCount: 0, warningCount: 0 }
    }

    const logContent = readFileSync(logPath, 'utf-8')
    const lines = logContent.split('\n')

    // Track current file via parenthesis tracking
    let currentFile: string | undefined

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!

      // Track current file from (./filename.tex patterns
      const fileMatch = line.match(/\(\.\/([^\s()]+\.tex)/)
      if (fileMatch) {
        currentFile = fileMatch[1]
      }

      // ! errors (existing logic, now with DiagnosisIssue)
      if (line.startsWith('!')) {
        const message = line.slice(2).trim()
        let lineNum: number | undefined

        // Look ahead for l.NNN
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const lMatch = lines[j]!.match(/^l\.(\d+)/)
          if (lMatch) {
            lineNum = parseInt(lMatch[1]!, 10)
            break
          }
        }

        const contextLines = lines.slice(Math.max(0, i - 1), i + 4).join('\n')

        const issue = this.classifyDiagnosisIssue(
          message,
          lineNum,
          currentFile,
          contextLines,
        )
        issues.push(issue)
      }

      // Overfull \hbox
      const hboxMatch = line.match(
        /Overfull \\hbox \((\d+(?:\.\d+)?)pt too wide\)/,
      )
      if (hboxMatch) {
        const overflowPt = parseFloat(hboxMatch[1]!)
        let lineNum: number | undefined
        // Look for "at lines N--M" or next context
        const lineRangeMatch = line.match(/at lines (\d+)--(\d+)/)
        if (lineRangeMatch) {
          lineNum = parseInt(lineRangeMatch[1]!, 10)
        }
        issues.push({
          type: 'overfull_hbox',
          severity: 'warning',
          message: line.trim(),
          file: currentFile,
          line: lineNum,
          overflow_pt: overflowPt,
          autoFixable: true,
        })
      }

      // Overfull \vbox
      const vboxMatch = line.match(
        /Overfull \\vbox \((\d+(?:\.\d+)?)pt too high\)/,
      )
      if (vboxMatch) {
        const overflowPt = parseFloat(vboxMatch[1]!)
        issues.push({
          type: 'overfull_vbox',
          severity: 'warning',
          message: line.trim(),
          file: currentFile,
          overflow_pt: overflowPt,
          autoFixable: true,
        })
      }

      // Citation 'key' undefined
      const citeMatch = line.match(
        /Citation [`']([^'`]+)['`] (?:on page \d+ )?undefined/,
      )
      if (citeMatch) {
        issues.push({
          type: 'undefined_citation',
          severity: 'warning',
          message: line.trim(),
          file: currentFile,
          citeKey: citeMatch[1],
          autoFixable: true,
        })
      }

      // Reference 'label' undefined
      const refMatch = line.match(
        /Reference [`']([^'`]+)['`] on page \d+ undefined/,
      )
      if (refMatch) {
        issues.push({
          type: 'undefined_reference',
          severity: 'warning',
          message: line.trim(),
          file: currentFile,
          refLabel: refMatch[1],
          autoFixable: true,
        })
      }

      // LaTeX Warning: Reference 'label' undefined
      const refWarnMatch = line.match(
        /LaTeX Warning: Reference [`']([^'`]+)['`] on page \d+ undefined/,
      )
      if (refWarnMatch && !refMatch) {
        issues.push({
          type: 'undefined_reference',
          severity: 'warning',
          message: line.trim(),
          file: currentFile,
          refLabel: refWarnMatch[1],
          autoFixable: true,
        })
      }

      // File 'name' not found
      const fileNotFoundMatch = line.match(/File [`']([^'`]+)['`] not found/)
      if (fileNotFoundMatch) {
        issues.push({
          type: 'missing_file',
          severity: 'error',
          message: line.trim(),
          file: currentFile,
          missingFile: fileNotFoundMatch[1],
          autoFixable: true,
        })
      }

      // Package xyz Error
      const pkgErrorMatch = line.match(/Package ([a-zA-Z0-9-]+) Error/)
      if (pkgErrorMatch) {
        issues.push({
          type: 'package_error',
          severity: 'error',
          message: line.trim(),
          file: currentFile,
          packageName: pkgErrorMatch[1],
          autoFixable: false,
        })
      }
    }

    // Deduplicate issues by type + key/label/file
    const deduped = this.deduplicateIssues(issues)

    return {
      issues: deduped,
      errorCount: deduped.filter(i => i.severity === 'error').length,
      warningCount: deduped.filter(i => i.severity === 'warning').length,
    }
  }

  /**
   * Classify a ! error message into a structured DiagnosisIssue.
   */
  private classifyDiagnosisIssue(
    message: string,
    line: number | undefined,
    file: string | undefined,
    context: string,
  ): DiagnosisIssue {
    // Undefined control sequence
    if (
      message.includes('Undefined control sequence') ||
      message.includes('undefined control')
    ) {
      // Try to extract the command name from context
      const cmdMatch = context.match(/\\([a-zA-Z]+)/)
      return {
        type: 'undefined_command',
        severity: 'error',
        message,
        file,
        line,
        context,
        command: cmdMatch ? `\\${cmdMatch[1]}` : undefined,
        autoFixable: true,
      }
    }

    // Missing $ (math error)
    if (
      message.includes('Missing $') ||
      message.includes('math mode') ||
      message.includes('Display math')
    ) {
      return {
        type: 'math_error',
        severity: 'error',
        message,
        file,
        line,
        context,
        autoFixable: true,
      }
    }

    // File not found
    if (message.includes('File') && message.includes('not found')) {
      const fileMatch = message.match(/File [`']([^'`]+)['`]/)
      return {
        type: 'missing_file',
        severity: 'error',
        message,
        file,
        line,
        context,
        missingFile: fileMatch?.[1],
        autoFixable: true,
      }
    }

    // Missing package
    if (message.includes('Package') || message.includes('usepackage')) {
      const pkgMatch = message.match(/[`']([a-zA-Z0-9-]+)['`]/)
      return {
        type: 'missing_package',
        severity: 'error',
        message,
        file,
        line,
        context,
        packageName: pkgMatch?.[1],
        autoFixable: true,
      }
    }

    // Default: syntax error
    return {
      type: 'syntax_error',
      severity: 'error',
      message,
      file,
      line,
      context,
      autoFixable: true,
    }
  }

  /**
   * Deduplicate issues — keep first occurrence of each unique type+key combo.
   */
  private deduplicateIssues(issues: DiagnosisIssue[]): DiagnosisIssue[] {
    const seen = new Set<string>()
    return issues.filter(issue => {
      const key = `${issue.type}:${issue.citeKey ?? ''}:${issue.refLabel ?? ''}:${issue.command ?? ''}:${issue.missingFile ?? ''}:${issue.line ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  // ── New: compileAndFixDetailed ──────────────────────────

  /**
   * Enhanced compile-and-fix loop with type-specific fixers.
   * Returns structured CompilationResult with full attempt history.
   */
  async compileAndFixDetailed(
    texPath: string,
    modelName: string,
    maxRetries: number = 10,
  ): Promise<CompilationResult> {
    const history: CompilationAttempt[] = []
    const allWarnings: string[] = []

    const fixers = new LaTeXFixers(this.projectDir, {
      bibManager: this.bibManager,
      constraints: this.constraints,
      modelName,
      templateDir: this.templateDir,
    })

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const result = await this.compileDetailed(texPath)
      history.push(result)
      allWarnings.push(...result.warnings)

      if (result.success) {
        return {
          success: true,
          attempts: attempt + 1,
          history,
          pdfPath: result.pdfPath ?? undefined,
          warnings: [...new Set(allWarnings)],
          unresolvedIssues: [],
        }
      }

      // Get fixable errors
      const errors = result.issues.filter(
        i => i.severity === 'error' && i.autoFixable,
      )
      if (errors.length === 0) {
        // Also try fixing warnings that are auto-fixable (like undefined citations)
        const fixableWarnings = result.issues.filter(
          i => i.severity === 'warning' && i.autoFixable,
        )
        if (fixableWarnings.length === 0) break

        // Try fixing warnings
        let anyFixed = false
        for (const issue of fixableWarnings) {
          const fixed = await fixers.fix(issue, texPath)
          if (fixed) anyFixed = true
        }
        if (!anyFixed) break
        continue
      }

      // Try to fix each error with type-specific fixers
      let anyFixed = false
      for (const error of errors) {
        const fixed = await fixers.fix(error, texPath)
        if (fixed) anyFixed = true
      }

      if (!anyFixed) {
        // Fall back to legacy LLM whole-file fix
        const legacyErrors = errors.map(e => ({
          type: classifyError(e.message),
          message: e.message,
          line: e.line,
          context: e.context,
        }))
        const llmFixed = await this.llmFix(legacyErrors, texPath, modelName)
        if (!llmFixed) break
      }
    }

    // Return failure with unresolved issues
    const lastAttempt = history[history.length - 1]
    return {
      success: false,
      attempts: history.length,
      history,
      warnings: [...new Set(allWarnings)],
      unresolvedIssues: lastAttempt?.issues ?? [],
    }
  }

  // ── Legacy parseLog (kept as private, wraps diagnoseFromLog) ──

  private parseLog(logPath: string): {
    errors: LaTeXError[]
    warnings: string[]
  } {
    const diagnosis = this.diagnoseFromLog(logPath)

    // Convert DiagnosisIssue to legacy LaTeXError format
    const errors: LaTeXError[] = diagnosis.issues
      .filter(i => i.severity === 'error')
      .map(i => ({
        type: classifyError(i.message),
        message: i.message,
        line: i.line,
        context: i.context,
      }))

    const warnings: string[] = diagnosis.issues
      .filter(i => i.severity === 'warning')
      .map(i => i.message)

    return { errors, warnings }
  }

  // ── Legacy autoFix (kept for backward compat) ──

  private async autoFix(
    errors: LaTeXError[],
    texPath: string,
  ): Promise<boolean> {
    if (!existsSync(texPath)) return false

    let content = readFileSync(texPath, 'utf-8')
    let changed = false

    for (const error of errors) {
      // Missing package: insert \usepackage{...} in preamble
      if (error.type === 'missing_package') {
        const pkgMatch = error.message.match(/['`]([a-zA-Z0-9\-]+)[''']/)
        if (pkgMatch) {
          const pkg = pkgMatch[1]!
          const usepackageLine = `\\usepackage{${pkg}}`
          if (!content.includes(usepackageLine)) {
            content = content.replace(
              /\\begin\{document\}/,
              `${usepackageLine}\n\\begin{document}`,
            )
            changed = true
          }
        }
      }

      // Reference errors: run bibtex
      if (error.type === 'reference_error') {
        const texDir = dirname(texPath)
        const texBase = basename(texPath, '.tex')
        try {
          const bibtexProc = Bun.spawn(['bibtex', texBase], {
            cwd: texDir,
            stdout: 'pipe',
            stderr: 'pipe',
          })
          await bibtexProc.exited
          changed = true
        } catch (err: any) {
          if (typeof process !== 'undefined' && process.stderr) {
            process.stderr.write(
              `[latex-engine] BibTeX run failed: ${err.message ?? err}\n`,
            )
          }
        }
      }
    }

    if (changed) {
      writeFileSync(texPath, content, 'utf-8')
    }

    return changed
  }

  // ── Legacy llmFix (whole-file fallback) ──

  private async llmFix(
    errors: LaTeXError[],
    texPath: string,
    modelName: string,
  ): Promise<boolean> {
    if (!existsSync(texPath)) return false

    const texContent = readFileSync(texPath, 'utf-8')

    const errorSummary = errors
      .map(
        e =>
          `- [${e.type}] line ${e.line ?? '?'}: ${e.message}\n  Context: ${e.context ?? ''}`,
      )
      .join('\n')

    const systemPrompt = `You are an expert LaTeX debugger. Given a LaTeX file and compilation errors, provide a corrected version of the file. Return ONLY the complete corrected LaTeX content, no markdown fences or explanations.`

    const userContent = `The following LaTeX file has compilation errors. Fix the errors and return the corrected file.

ERRORS:
${errorSummary}

LATEX FILE (${texPath}):
${texContent.slice(0, 12000)}`

    try {
      const response = await chatCompletion({
        modelSpec: modelName,
        max_tokens: 8096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      })

      const rawText = response.text

      // Strip markdown fences if present
      const fixed = rawText
        .replace(/^```(?:latex|tex)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim()

      if (fixed && fixed.length > 50) {
        writeFileSync(texPath, fixed + '\n', 'utf-8')
        return true
      }
    } catch (err: any) {
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(
          `[latex-engine] LLM-based fix failed: ${err.message ?? err}\n`,
        )
      }
    }

    return false
  }

  // ── Helpers ──────────────────────────────────────────

  /**
   * Get first ~50 lines of log for diagnostics.
   */
  private getLogExcerpt(logPath: string): string | undefined {
    if (!existsSync(logPath)) return undefined
    try {
      const content = readFileSync(logPath, 'utf-8')
      const lines = content.split('\n')
      return lines.slice(0, 50).join('\n')
    } catch {
      return undefined
    }
  }
}
