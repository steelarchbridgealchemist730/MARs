import { join } from 'path'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { getAnthropicClient } from './llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from './types'
import { extractModelId } from './agent-dispatch'
import { PythonEnv } from './python-env'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PDFExtractResult {
  paper_id: string
  text: {
    markdown: string
    full_text: string // backward compat alias for markdown
    sections: Array<{ title: string; level: number; char_offset: number }>
    tables: Array<{ page: number; data: string[][] }>
  }
  figures: Array<{
    image_path: string
    page: number
    width: number
    height: number
    format: string
    captions: string[]
    description?: string
    key_data_points?: string[]
    chart_type?: string
  }>
  references: Array<{
    text: string
    number?: number
    year?: number
    doi?: string
    arxiv_id?: string
  }>
  metadata: {
    title: string
    authors: string[]
    abstract: string
    year: number | null
  }
  chunks: SectionChunk[]
  page_count: number
}

export interface SectionChunk {
  paper_id: string
  section_title: string
  level: number
  page_start: number
  page_end: number
  content: string
  word_count: number
  figure_descriptions?: string[]
}

// ---------------------------------------------------------------------------
// PDFExtractor
// ---------------------------------------------------------------------------

export class PDFExtractor {
  private scriptPath: string

  constructor() {
    this.scriptPath = join(
      import.meta.dir,
      '../tools/paper/scripts/extract_pdf.py',
    )
  }

  /**
   * Stage 1+2: Run Python script for structured Markdown extraction
   * and selective figure-page rendering.
   */
  async extract(
    pdfPath: string,
    paperId: string,
    outputDir: string,
    projectDir?: string,
  ): Promise<PDFExtractResult> {
    mkdirSync(outputDir, { recursive: true })

    // Use managed venv python if projectDir is provided
    let pythonBin = 'python3'
    if (projectDir) {
      const env = new PythonEnv(projectDir)
      await env.ensurePackage('pymupdf')
      await env.ensurePackage('pdfplumber')
      const venvPython = env.pythonPath()
      if (existsSync(venvPython)) {
        pythonBin = venvPython
      }
    }

    const proc = Bun.spawn([pythonBin, this.scriptPath, pdfPath, outputDir], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`PDF extraction failed: ${stderr}`)
    }

    const status = JSON.parse(stdout.trim())
    if (status.error) throw new Error(status.error)

    const extractionPath = join(outputDir, 'extraction.json')
    const raw = JSON.parse(await Bun.file(extractionPath).text())

    const chunks: SectionChunk[] = (raw.chunks || []).map(
      (c: Record<string, any>) => ({
        ...c,
        paper_id: paperId,
      }),
    )

    return {
      paper_id: paperId,
      text: {
        markdown: raw.text?.markdown ?? raw.text?.full_text ?? '',
        full_text: raw.text?.markdown ?? raw.text?.full_text ?? '',
        sections: raw.text?.sections ?? [],
        tables: raw.text?.tables ?? [],
      },
      figures: raw.figures ?? [],
      references: raw.references ?? [],
      metadata: {
        title: raw.metadata?.title ?? 'Unknown',
        authors: raw.metadata?.authors ?? [],
        abstract: raw.metadata?.abstract ?? '',
        year: raw.metadata?.year ?? null,
      },
      chunks,
      page_count: raw.page_count ?? 0,
    }
  }

  /**
   * Stage 3: Selective vision analysis.
   * Only sends figure-page images that likely contain charts/plots/diagrams
   * (based on caption keywords). Skips decorative or fully-described figures.
   */
  async analyzeFiguresWithVision(
    result: PDFExtractResult,
    modelName?: string,
  ): Promise<PDFExtractResult> {
    const model =
      modelName ?? extractModelId(DEFAULT_MODEL_ASSIGNMENTS.research)
    const client = getAnthropicClient()

    const analyzedFigures = [...result.figures]

    for (let i = 0; i < analyzedFigures.length; i++) {
      const fig = analyzedFigures[i]
      if (!fig.image_path || !existsSync(fig.image_path)) continue

      // Skip if no captions (probably not a meaningful figure)
      if (!fig.captions || fig.captions.length === 0) continue

      // Check if captions suggest a chart/plot/diagram that needs vision
      const captionText = fig.captions.join(' ').toLowerCase()
      const needsVision =
        /\b(plot|graph|chart|curve|histogram|scatter|bar|heatmap|diagram|architecture|workflow|convergence|comparison|results|performance|accuracy|error|loss)\b/.test(
          captionText,
        )

      if (!needsVision) {
        // Caption is descriptive enough — use it directly
        analyzedFigures[i] = {
          ...fig,
          description: `Figure showing: ${fig.captions.join('; ')}`,
          chart_type: 'other',
        }
        continue
      }

      try {
        const imageBytes = readFileSync(fig.image_path)
        const base64 = imageBytes.toString('base64')
        const mediaType = 'image/png' as const

        const response = await client.messages.create({
          model,
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: base64,
                  },
                },
                {
                  type: 'text',
                  text: `This is a figure from an academic paper. Caption: "${fig.captions.join('; ')}"

Analyze this figure and respond with JSON only:
{"chart_type": "line|bar|scatter|heatmap|diagram|table|architecture|other", "description": "2-3 sentence description of what this figure shows, including key trends and data points", "key_data_points": ["point1", "point2", "point3"]}`,
                },
              ],
            },
          ],
        })

        const rawText =
          response.content[0].type === 'text' ? response.content[0].text : '{}'
        let parsed: Record<string, any>
        try {
          parsed = JSON.parse(rawText)
        } catch {
          const match = rawText.match(/\{[\s\S]*\}/)
          parsed = match ? JSON.parse(match[0]) : {}
        }

        analyzedFigures[i] = {
          ...fig,
          description:
            typeof parsed.description === 'string'
              ? parsed.description
              : undefined,
          chart_type:
            typeof parsed.chart_type === 'string'
              ? parsed.chart_type
              : undefined,
          key_data_points: Array.isArray(parsed.key_data_points)
            ? parsed.key_data_points
            : undefined,
        }
      } catch {
        // Vision analysis failed for this figure — keep caption as description
        analyzedFigures[i] = {
          ...fig,
          description: `Figure: ${fig.captions.join('; ')}`,
        }
      }
    }

    // Merge figure descriptions into the chunks they belong to
    const enrichedChunks = this.mergeFigureDescriptionsIntoChunks(
      result.chunks,
      analyzedFigures,
    )

    return { ...result, figures: analyzedFigures, chunks: enrichedChunks }
  }

  /**
   * Merge figure descriptions into the section chunks where they appear.
   */
  private mergeFigureDescriptionsIntoChunks(
    chunks: SectionChunk[],
    figures: PDFExtractResult['figures'],
  ): SectionChunk[] {
    return chunks.map(chunk => {
      const figDescs: string[] = []
      for (const fig of figures) {
        if (
          fig.description &&
          fig.page >= chunk.page_start &&
          fig.page <= chunk.page_end
        ) {
          const desc = fig.key_data_points
            ? `${fig.description} Key data: ${fig.key_data_points.join('; ')}`
            : fig.description
          figDescs.push(desc)
        }
      }
      if (figDescs.length > 0) {
        return { ...chunk, figure_descriptions: figDescs }
      }
      return chunk
    })
  }

  /**
   * Build enriched Markdown text with figure descriptions inserted
   * at the correct section positions. Used for PaperQA2 indexing.
   */
  buildEnrichedText(result: PDFExtractResult): string {
    let text = result.text.markdown

    // Insert figure descriptions after their captions
    for (const fig of result.figures) {
      if (!fig.description || !fig.captions || fig.captions.length === 0)
        continue

      // Find the first caption in the text
      for (const caption of fig.captions) {
        const insertPoint = text.indexOf(caption)
        if (insertPoint > -1) {
          const enrichment = `\n\n> **[FIGURE ANALYSIS]**: ${fig.description}${fig.key_data_points ? ' | Key data: ' + fig.key_data_points.join('; ') : ''}\n`
          text =
            text.slice(0, insertPoint + caption.length) +
            enrichment +
            text.slice(insertPoint + caption.length)
          break // Only insert once per figure
        }
      }
    }

    return text
  }

  /**
   * Write enriched text and chunks to disk for indexing.
   */
  async writeIndexableOutput(
    result: PDFExtractResult,
    outputDir: string,
  ): Promise<{ enrichedPath: string; chunksPath: string }> {
    mkdirSync(outputDir, { recursive: true })

    const enrichedText = this.buildEnrichedText(result)
    const enrichedPath = join(outputDir, 'enriched.md')
    writeFileSync(enrichedPath, enrichedText, 'utf-8')

    const chunksPath = join(outputDir, 'chunks.json')
    writeFileSync(chunksPath, JSON.stringify(result.chunks, null, 2), 'utf-8')

    return { enrichedPath, chunksPath }
  }

  /**
   * Check if pymupdf4llm (preferred) or at least PyMuPDF is available.
   * Checks system python first, then managed venv.
   */
  async isAvailable(projectDir?: string): Promise<boolean> {
    // Check system python first
    try {
      const proc = Bun.spawn(['python3', '-c', 'import fitz'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if ((await proc.exited) === 0) return true
    } catch {
      // not on system python
    }

    // Try managed venv
    if (projectDir) {
      const env = new PythonEnv(projectDir)
      return env.ensurePackage('pymupdf')
    }

    return false
  }

  /**
   * Check if pymupdf4llm specifically is available (for better extraction).
   */
  async isPymupdf4llmAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(['python3', '-c', 'import pymupdf4llm'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const code = await proc.exited
      return code === 0
    } catch {
      return false
    }
  }
}

export const pdfExtractor = new PDFExtractor()
