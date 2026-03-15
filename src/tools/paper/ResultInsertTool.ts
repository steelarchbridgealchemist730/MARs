import { z } from 'zod'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { Tool } from '@tool'

const inputSchema = z.strictObject({
  action: z.enum(['table', 'figure']).describe('Type of result to insert'),
  source_path: z
    .string()
    .describe('Source file path (CSV for table, image for figure)'),
  output_path: z.string().describe('Output .tex file path'),
  caption: z.string().describe('Caption text'),
  label: z.string().describe('LaTeX label for referencing'),
  highlight_best: z
    .boolean()
    .optional()
    .default(false)
    .describe('Bold the best value in each column (for tables)'),
  bold_column: z
    .string()
    .optional()
    .describe('Column name representing "our method" to bold'),
  width: z
    .string()
    .optional()
    .default('0.8\\textwidth')
    .describe('Figure width (for figures)'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  success: boolean
  output_path: string
  latex_content: string
  error?: string
}

function csvToLatexTable(
  csvContent: string,
  caption: string,
  label: string,
  highlightBest: boolean,
  boldColumn?: string,
): string {
  const lines = csvContent
    .trim()
    .split('\n')
    .map(l => l.trim())
  if (lines.length === 0) return ''

  const headers = lines[0].split(',').map(h => h.trim())
  const rows = lines.slice(1).map(l => l.split(',').map(c => c.trim()))
  const numCols = headers.length

  // Detect numeric columns
  const isNumeric = headers.map((_, ci) =>
    rows.every(r => !isNaN(parseFloat(r[ci])) || r[ci] === ''),
  )

  // Find best (max) value per numeric column for highlighting
  const bestValues: (number | null)[] = headers.map((_, ci) => {
    if (!isNumeric[ci] || !highlightBest) return null
    const values = rows.map(r => parseFloat(r[ci])).filter(v => !isNaN(v))
    return values.length > 0 ? Math.max(...values) : null
  })

  // Build column spec
  const colSpec = headers.map((_, i) => (isNumeric[i] ? 'r' : 'l')).join(' ')

  const texLines: string[] = []
  texLines.push('\\begin{table}[htbp]')
  texLines.push('  \\centering')
  texLines.push(`  \\caption{${caption}}`)
  texLines.push(`  \\label{${label}}`)
  texLines.push(`  \\begin{tabular}{${colSpec}}`)
  texLines.push('    \\toprule')

  // Header row
  texLines.push(`    ${headers.map(h => `\\textbf{${h}}`).join(' & ')} \\\\`)
  texLines.push('    \\midrule')

  // Data rows
  for (const row of rows) {
    const cells = row.map((cell, ci) => {
      const isBoldRow = boldColumn && headers[ci] === boldColumn
      const isBestVal =
        highlightBest &&
        bestValues[ci] !== null &&
        parseFloat(cell) === bestValues[ci]

      if (isBoldRow || isBestVal) {
        return `\\textbf{${cell}}`
      }
      return cell
    })
    texLines.push(`    ${cells.join(' & ')} \\\\`)
  }

  texLines.push('    \\bottomrule')
  texLines.push('  \\end{tabular}')
  texLines.push('\\end{table}')

  return texLines.join('\n')
}

function imageToLatexFigure(
  imagePath: string,
  caption: string,
  label: string,
  width: string,
): string {
  const texLines: string[] = []
  texLines.push('\\begin{figure}[htbp]')
  texLines.push('  \\centering')
  texLines.push(`  \\includegraphics[width=${width}]{${imagePath}}`)
  texLines.push(`  \\caption{${caption}}`)
  texLines.push(`  \\label{${label}}`)
  texLines.push('\\end{figure}')
  return texLines.join('\n')
}

const TOOL_NAME = 'ResultInsert'

const PROMPT = `Insert experiment results into LaTeX format.
For tables: reads a CSV file and generates a formatted LaTeX tabular environment with booktabs styling.
For figures: generates a LaTeX figure environment with includegraphics.
Supports highlighting best values in tables and bolding specific columns.
Output is written to a .tex file that can be \\input{} in the main document.`

export const ResultInsertTool = {
  name: TOOL_NAME,
  async description() {
    return 'Insert experiment results into LaTeX'
  },
  userFacingName: () => 'Result Insert',
  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  async isEnabled() {
    return true
  },
  needsPermissions() {
    return true
  },
  async prompt() {
    return PROMPT
  },

  renderToolUseMessage(input: Input, { verbose }: { verbose: boolean }) {
    if (verbose) {
      return `Inserting ${input.action} from ${input.source_path} → ${input.output_path}`
    }
    return `Insert ${input.action}: ${input.label}`
  },

  renderResultForAssistant(output: Output) {
    if (output.success) {
      return `Generated LaTeX ${output.output_path}:\n\`\`\`latex\n${output.latex_content}\n\`\`\``
    }
    return `Error: ${output.error}`
  },

  renderToolResultMessage(output: Output) {
    if (output.success) {
      return `Wrote ${output.output_path}`
    }
    return `Failed: ${output.error}`
  },

  async *call(input: Input) {
    yield {
      type: 'progress' as const,
      content: `Generating LaTeX ${input.action} from ${input.source_path}...`,
    }

    try {
      let latexContent: string

      if (input.action === 'table') {
        const csvContent = readFileSync(input.source_path, 'utf-8')
        latexContent = csvToLatexTable(
          csvContent,
          input.caption,
          input.label,
          input.highlight_best ?? false,
          input.bold_column,
        )
      } else {
        latexContent = imageToLatexFigure(
          input.source_path,
          input.caption,
          input.label,
          input.width ?? '0.8\\textwidth',
        )
      }

      mkdirSync(dirname(input.output_path), { recursive: true })
      writeFileSync(input.output_path, latexContent, 'utf-8')

      const output: Output = {
        success: true,
        output_path: input.output_path,
        latex_content: latexContent,
      }
      yield { type: 'result' as const, data: output }
    } catch (err: any) {
      const output: Output = {
        success: false,
        output_path: input.output_path,
        latex_content: '',
        error: err.message ?? String(err),
      }
      yield { type: 'result' as const, data: output }
    }
  },
} satisfies Tool<typeof inputSchema, Output>
