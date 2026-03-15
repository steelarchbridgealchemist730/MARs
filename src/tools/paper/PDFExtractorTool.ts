import { z } from 'zod'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import type { Tool } from '@tool'

const inputSchema = z.strictObject({
  pdf_path: z.string().describe('Absolute path to the PDF file to extract'),
  output_dir: z
    .string()
    .optional()
    .describe(
      'Directory to write extraction results and images. Defaults to a sibling directory of the PDF.',
    ),
  extract_figures: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to render figure pages as images for vision analysis'),
})

type Input = z.infer<typeof inputSchema>

interface ExtractedSection {
  title: string
  level: number
  char_offset: number
}

interface ExtractedTable {
  page: number
  data: string[][]
}

interface ExtractedFigure {
  image_path: string
  page: number
  width: number
  height: number
  format: string
  captions: string[]
}

interface ExtractedReference {
  text: string
  number?: number
  year?: number
  doi?: string
  arxiv_id?: string
}

interface ExtractedChunk {
  section_title: string
  level: number
  page_start: number
  page_end: number
  content: string
  word_count: number
}

type Output = {
  text: {
    markdown: string
    full_text: string
    sections: ExtractedSection[]
    tables: ExtractedTable[]
  }
  figures: ExtractedFigure[]
  references: ExtractedReference[]
  metadata: {
    title: string
    authors: string[]
    abstract: string
    year: number | null
  }
  chunks: ExtractedChunk[]
  output_file: string
  text_length: number
  figure_count: number
  page_count: number
}

const SCRIPT_PATH = join(import.meta.dir, 'scripts', 'extract_pdf.py')

const TOOL_NAME = 'PDFExtractor'

const PROMPT = `Extract structured content from a PDF file.
Uses pymupdf4llm for structured Markdown extraction (preserving headings, tables, math, lists),
pdfplumber for supplementary table extraction, and selective page rendering for figures.
Returns structured Markdown text with sections, figure page images, parsed references (numbered and author-year),
metadata (title, authors, abstract), and section-level chunks for indexing.
Requires Python 3 with pymupdf4llm and pdfplumber installed.`

export const PDFExtractorTool = {
  name: TOOL_NAME,
  async description() {
    return 'Extract structured Markdown, figures, tables, and references from a PDF file'
  },
  userFacingName: () => 'PDF Extractor',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async isEnabled() {
    try {
      const proc = Bun.spawn(['python3', '-c', 'import fitz'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const code = await proc.exited
      return code === 0
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
    if (verbose) {
      return `Extracting PDF: "${input.pdf_path}" (figures: ${input.extract_figures ?? true})`
    }
    return `PDF extract: "${input.pdf_path.split('/').pop()}"`
  },

  renderResultForAssistant(output: Output) {
    const lines = [
      `PDF extraction complete:`,
      `- **Title**: ${output.metadata.title}`,
      `- **Authors**: ${output.metadata.authors.join(', ') || 'Unknown'}`,
      `- **Pages**: ${output.page_count}`,
      `- **Text length**: ${output.text_length} characters`,
      `- **Sections**: ${output.text.sections.length}`,
      `- **Tables**: ${output.text.tables.length}`,
      `- **Figures**: ${output.figure_count} (rendered figure pages)`,
      `- **References**: ${output.references.length}`,
      `- **Chunks**: ${output.chunks.length} (section-level)`,
      `- **Output**: ${output.output_file}`,
      '',
    ]

    if (output.metadata.abstract) {
      lines.push(`**Abstract**: ${output.metadata.abstract.slice(0, 500)}`)
      lines.push('')
    }

    if (output.text.sections.length > 0) {
      lines.push('**Sections**:')
      for (const s of output.text.sections) {
        const indent = '  '.repeat(Math.max(0, s.level - 1))
        lines.push(`${indent}- ${s.title}`)
      }
      lines.push('')
    }

    if (output.figures.length > 0) {
      lines.push('**Figure pages**:')
      for (const f of output.figures) {
        const captionPreview = f.captions?.[0]?.slice(0, 80) ?? 'no caption'
        lines.push(`- p.${f.page}: ${captionPreview}`)
      }
      lines.push('')
    }

    // Include first 2000 chars of Markdown for the assistant
    if (output.text.markdown) {
      lines.push('**Text preview**:')
      lines.push(output.text.markdown.slice(0, 2000))
      if (output.text.markdown.length > 2000) {
        lines.push(`\n... (${output.text_length - 2000} more characters)`)
      }
    }

    return lines.join('\n')
  },

  renderToolResultMessage(output: Output) {
    return `Extracted PDF: ${output.metadata.title} (${output.text_length} chars, ${output.figure_count} figures, ${output.text.sections.length} sections, ${output.chunks.length} chunks)`
  },

  async *call(input: Input) {
    const pdfPath = input.pdf_path

    if (!existsSync(pdfPath)) {
      throw new Error(`PDF file not found: ${pdfPath}`)
    }

    const outputDir =
      input.output_dir ??
      join(
        dirname(pdfPath),
        `${pdfPath
          .split('/')
          .pop()
          ?.replace(/\.pdf$/i, '')}_extracted`,
      )

    yield {
      type: 'progress' as const,
      content: `Extracting PDF: ${pdfPath.split('/').pop()}...`,
    }

    // Verify at least PyMuPDF is available
    const checkProc = Bun.spawn(['python3', '-c', 'import fitz'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const checkCode = await checkProc.exited
    if (checkCode !== 0) {
      throw new Error(
        'Python dependency missing. Install with: pip install pymupdf4llm pdfplumber',
      )
    }

    if (!existsSync(SCRIPT_PATH)) {
      throw new Error(`Extraction script not found: ${SCRIPT_PATH}`)
    }

    yield {
      type: 'progress' as const,
      content: 'Running structured Markdown extraction...',
    }

    const proc = Bun.spawn(['python3', SCRIPT_PATH, pdfPath, outputDir], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(
        `PDF extraction failed (exit code ${exitCode}): ${stderr.slice(0, 1000)}`,
      )
    }

    let status: Record<string, any>
    try {
      status = JSON.parse(stdout.trim())
    } catch {
      throw new Error(
        `Failed to parse extraction output: ${stdout.slice(0, 500)}`,
      )
    }

    if (status.error) {
      throw new Error(`Extraction error: ${status.error}`)
    }

    const extractionPath = status.output ?? join(outputDir, 'extraction.json')
    if (!existsSync(extractionPath)) {
      throw new Error(`Extraction output file not found: ${extractionPath}`)
    }

    yield {
      type: 'progress' as const,
      content: 'Parsing extraction results...',
    }

    const raw = JSON.parse(await Bun.file(extractionPath).text())

    const figures: ExtractedFigure[] =
      input.extract_figures !== false ? raw.figures || [] : []

    const output: Output = {
      text: {
        markdown: raw.text?.markdown ?? raw.text?.full_text ?? '',
        full_text: raw.text?.markdown ?? raw.text?.full_text ?? '',
        sections: raw.text?.sections ?? [],
        tables: raw.text?.tables ?? [],
      },
      figures,
      references: raw.references ?? [],
      metadata: {
        title: raw.metadata?.title ?? 'Unknown',
        authors: raw.metadata?.authors ?? [],
        abstract: raw.metadata?.abstract ?? '',
        year: raw.metadata?.year ?? null,
      },
      chunks: raw.chunks ?? [],
      output_file: extractionPath,
      text_length: (raw.text?.markdown ?? raw.text?.full_text ?? '').length,
      figure_count: figures.length,
      page_count: raw.page_count ?? 0,
    }

    yield { type: 'result' as const, data: output }
  },
} satisfies Tool<typeof inputSchema, Output>
