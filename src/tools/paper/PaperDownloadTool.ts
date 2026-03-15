import { z } from 'zod'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import type { Tool } from '@tool'

const inputSchema = z.strictObject({
  url: z.string().describe('PDF download URL'),
  paper_id: z.string().describe('Identifier for file naming'),
  source: z
    .enum(['arxiv', 's2', 'ssrn', 'other'])
    .describe('Source database of the paper'),
  save_dir: z
    .string()
    .optional()
    .default('literature/papers')
    .describe('Directory to save the PDF'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  success: boolean
  file_path: string | null
  file_size: number | null
  error?: string
}

function isValidPdf(buffer: Buffer): boolean {
  // Check for PDF magic bytes
  return buffer.length > 4 && buffer.subarray(0, 5).toString() === '%PDF-'
}

const TOOL_NAME = 'PaperDownload'

const PROMPT = `Download an academic paper PDF from a given URL.
Supports arXiv, Semantic Scholar open access PDFs, and SSRN downloads.
The paper is saved to the literature/papers/ directory with a standardized filename.
Validates that the downloaded file is a valid PDF.`

export const PaperDownloadTool = {
  name: TOOL_NAME,
  async description() {
    return 'Download a paper PDF from URL'
  },
  userFacingName: () => 'Paper Download',
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
      return `Downloading paper ${input.paper_id} from ${input.source}: ${input.url}`
    }
    return `Download: ${input.paper_id} (${input.source})`
  },

  renderResultForAssistant(output: Output) {
    if (output.success) {
      return `Downloaded paper to ${output.file_path} (${output.file_size} bytes)`
    }
    return `Download failed: ${output.error}`
  },

  renderToolResultMessage(output: Output) {
    if (output.success) {
      return `Downloaded to ${output.file_path}`
    }
    return `Failed: ${output.error}`
  },

  async *call(input: Input) {
    yield {
      type: 'progress' as const,
      content: `Downloading paper ${input.paper_id} from ${input.source}...`,
    }

    const saveDir = input.save_dir ?? 'literature/papers'
    mkdirSync(saveDir, { recursive: true })

    // Build filename
    const sanitizedId = input.paper_id.replace(/[^a-zA-Z0-9._-]/g, '_')
    const filename = `${input.source}_${sanitizedId}.pdf`
    const filepath = join(saveDir, filename)

    // Skip if already downloaded
    if (existsSync(filepath)) {
      const existing = readFileSync(filepath)
      if (isValidPdf(existing)) {
        const output: Output = {
          success: true,
          file_path: filepath,
          file_size: existing.length,
        }
        yield { type: 'result' as const, data: output }
        return
      }
    }

    try {
      const response = await fetch(input.url, {
        headers: {
          'User-Agent':
            'Claude-Paper/1.0 (Academic Research Tool; mailto:research@example.com)',
        },
        redirect: 'follow',
      })

      if (!response.ok) {
        const output: Output = {
          success: false,
          file_path: null,
          file_size: null,
          error: `HTTP ${response.status}: ${response.statusText}`,
        }
        yield { type: 'result' as const, data: output }
        return
      }

      const buffer = Buffer.from(await response.arrayBuffer())

      if (!isValidPdf(buffer)) {
        const output: Output = {
          success: false,
          file_path: null,
          file_size: null,
          error:
            'Downloaded file is not a valid PDF. The paper may require login to access.',
        }
        yield { type: 'result' as const, data: output }
        return
      }

      writeFileSync(filepath, buffer)

      const output: Output = {
        success: true,
        file_path: filepath,
        file_size: buffer.length,
      }
      yield { type: 'result' as const, data: output }
    } catch (err: any) {
      const output: Output = {
        success: false,
        file_path: null,
        file_size: null,
        error: err.message ?? String(err),
      }
      yield { type: 'result' as const, data: output }
    }
  },
} satisfies Tool<typeof inputSchema, Output>
