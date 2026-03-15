import { z } from 'zod'
import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import type { Tool } from '@tool'

const inputSchema = z.strictObject({
  tex_file: z
    .string()
    .optional()
    .default('paper/main.tex')
    .describe('Path to main .tex file'),
  compiler: z
    .enum(['pdflatex', 'xelatex', 'lualatex'])
    .optional()
    .default('pdflatex')
    .describe('LaTeX compiler to use'),
  bibtex: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to run bibtex/biber'),
})

type Input = z.infer<typeof inputSchema>

interface LatexError {
  file: string
  line: number | null
  message: string
  type:
    | 'undefined_control'
    | 'missing_package'
    | 'math_error'
    | 'reference_error'
    | 'file_not_found'
    | 'other'
  context: string
}

type Output = {
  success: boolean
  pdf_path: string | null
  errors: LatexError[]
  warnings: string[]
  log_excerpt: string
}

function classifyError(message: string): LatexError['type'] {
  if (message.includes('Undefined control sequence')) return 'undefined_control'
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
    message.includes('Label')
  )
    return 'reference_error'
  if (message.includes('Package') || message.includes('usepackage'))
    return 'missing_package'
  return 'other'
}

function parseLatexLog(logContent: string): {
  errors: LatexError[]
  warnings: string[]
} {
  const errors: LatexError[] = []
  const warnings: string[] = []
  const lines = logContent.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Match error lines like "! Undefined control sequence."
    if (line.startsWith('!')) {
      const message = line.slice(2).trim()
      // Try to find file and line number from preceding lines
      let file = 'unknown'
      let lineNum: number | null = null

      // Look backwards for file:line pattern
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const fileMatch = lines[j].match(/^\.\/([^:]+):(\d+):/)
        if (fileMatch) {
          file = fileMatch[1]
          lineNum = parseInt(fileMatch[2], 10)
          break
        }
        const lMatch = lines[j].match(/^l\.(\d+)/)
        if (lMatch) {
          lineNum = parseInt(lMatch[1], 10)
          break
        }
      }

      // Also check next line for l.NNN
      if (i + 1 < lines.length) {
        const nextLineMatch = lines[i + 1].match(/^l\.(\d+)/)
        if (nextLineMatch) {
          lineNum = parseInt(nextLineMatch[1], 10)
        }
      }

      const contextLines = lines.slice(Math.max(0, i - 2), i + 3).join('\n')

      errors.push({
        file,
        line: lineNum,
        message,
        type: classifyError(message),
        context: contextLines,
      })
    }

    // Match warnings
    if (
      line.includes('LaTeX Warning:') ||
      line.includes('Package natbib Warning:')
    ) {
      warnings.push(line.trim())
    }
  }

  return { errors, warnings }
}

const TOOL_NAME = 'LatexCompile'

const PROMPT = `Compile a LaTeX document to PDF using latexmk.
Parses the .log file to extract structured errors and warnings.
Errors are classified by type (undefined command, missing package, math error, reference error, file not found).
Returns the PDF path on success, or structured error information on failure.`

export const LatexCompileTool = {
  name: TOOL_NAME,
  async description() {
    return 'Compile LaTeX document to PDF'
  },
  userFacingName: () => 'LaTeX Compile',
  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async isEnabled() {
    try {
      execSync('which latexmk', { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  },
  needsPermissions() {
    return true
  },
  async prompt() {
    return PROMPT
  },

  renderToolUseMessage(input: Input, { verbose }: { verbose: boolean }) {
    const texFile = input.tex_file ?? 'paper/main.tex'
    if (verbose) {
      return `Compiling ${texFile} with ${input.compiler ?? 'pdflatex'}`
    }
    return `LaTeX compile: ${texFile}`
  },

  renderResultForAssistant(output: Output) {
    if (output.success) {
      return `LaTeX compilation successful. PDF at: ${output.pdf_path}`
    }

    const lines = ['LaTeX compilation failed.\n']
    for (const err of output.errors) {
      lines.push(`**Error** (${err.type}) in ${err.file}:${err.line ?? '?'}`)
      lines.push(`  ${err.message}`)
      lines.push(`  Context:\n${err.context}\n`)
    }
    if (output.warnings.length > 0) {
      lines.push(`\nWarnings (${output.warnings.length}):`)
      for (const w of output.warnings.slice(0, 10)) {
        lines.push(`  - ${w}`)
      }
    }
    return lines.join('\n')
  },

  renderToolResultMessage(output: Output) {
    if (output.success) {
      return `Compiled successfully: ${output.pdf_path}`
    }
    return `Compilation failed with ${output.errors.length} error(s)`
  },

  async *call(input: Input) {
    const texFile = input.tex_file ?? 'paper/main.tex'
    const compiler = input.compiler ?? 'pdflatex'

    if (!existsSync(texFile)) {
      const output: Output = {
        success: false,
        pdf_path: null,
        errors: [
          {
            file: texFile,
            line: null,
            message: `File not found: ${texFile}`,
            type: 'file_not_found',
            context: '',
          },
        ],
        warnings: [],
        log_excerpt: '',
      }
      yield { type: 'result' as const, data: output }
      return
    }

    yield {
      type: 'progress' as const,
      content: `Compiling ${texFile} with ${compiler}...`,
    }

    const texDir = dirname(texFile)
    const cmd = `cd ${texDir} && latexmk -pdf -${compiler} -interaction=nonstopmode ${texFile.split('/').pop()} 2>&1`

    try {
      const result = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 120000, // 2 minute timeout
        maxBuffer: 10 * 1024 * 1024,
      })

      const pdfPath = texFile.replace(/\.tex$/, '.pdf')

      // Parse log for warnings even on success
      const logFile = join(
        texDir,
        texFile
          .split('/')
          .pop()!
          .replace(/\.tex$/, '.log'),
      )
      let warnings: string[] = []
      if (existsSync(logFile)) {
        const logContent = readFileSync(logFile, 'utf-8')
        const parsed = parseLatexLog(logContent)
        warnings = parsed.warnings
      }

      const output: Output = {
        success: true,
        pdf_path: pdfPath,
        errors: [],
        warnings,
        log_excerpt: result.slice(-500),
      }
      yield { type: 'result' as const, data: output }
    } catch (err: any) {
      // Compilation failed - parse log for errors
      const logFile = join(
        texDir,
        texFile
          .split('/')
          .pop()!
          .replace(/\.tex$/, '.log'),
      )
      let errors: LatexError[] = []
      let warnings: string[] = []
      let logExcerpt = err.stdout ?? err.message ?? ''

      if (existsSync(logFile)) {
        const logContent = readFileSync(logFile, 'utf-8')
        const parsed = parseLatexLog(logContent)
        errors = parsed.errors
        warnings = parsed.warnings
        logExcerpt = logContent.slice(-1000)
      }

      if (errors.length === 0) {
        errors.push({
          file: texFile,
          line: null,
          message: `Compilation failed: ${err.message ?? 'Unknown error'}`,
          type: 'other',
          context: logExcerpt.slice(-300),
        })
      }

      const output: Output = {
        success: false,
        pdf_path: null,
        errors,
        warnings,
        log_excerpt: logExcerpt,
      }
      yield { type: 'result' as const, data: output }
    }
  },
} satisfies Tool<typeof inputSchema, Output>
