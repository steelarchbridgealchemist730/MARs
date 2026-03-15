import { z } from 'zod'
import { existsSync } from 'fs'
import { join, dirname, resolve } from 'path'
import type { Tool } from '@tool'
import { ChunkSearchIndex } from '../../paper/chunk-index'
import { PythonEnv } from '../../paper/python-env'

const inputSchema = z.strictObject({
  action: z
    .enum(['index', 'ask', 'search'])
    .describe(
      'Action: "index" to build index from PDFs, "ask" to query with citations, "search" for full-text search',
    ),
  query: z
    .string()
    .optional()
    .describe('Question or search query (required for ask/search)'),
  paper_dir: z
    .string()
    .optional()
    .default('literature/papers')
    .describe('Directory containing PDF files'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  action: string
  success: boolean
  result: string
  error?: string
}

const TOOL_NAME = 'PaperQA'

const PROMPT = `Interact with PaperQA2 for paper-based question answering.
Actions:
- "index": Build or update the search index from PDFs in the paper directory
- "ask": Ask a question and get an answer with citations from the indexed papers
- "search": Full-text search across indexed papers
Auto-installs paper-qa into a project-local venv on first use.`

async function getPqaPath(paperDir: string): Promise<string | null> {
  // Derive project dir from paper_dir (literature/papers -> project root)
  const projectDir = resolve(paperDir, '..', '..')
  const env = new PythonEnv(projectDir)
  const ok = await env.ensurePackage('paper-qa')
  if (!ok) return null
  return env.binPath('pqa')
}

export const PaperQATool = {
  name: TOOL_NAME,
  async description() {
    return 'Query papers using PaperQA2'
  },
  userFacingName: () => 'PaperQA',
  inputSchema,
  isReadOnly: (input?: Input) => input?.action !== 'index',
  isConcurrencySafe: () => false,
  async isEnabled() {
    return true
  },
  needsPermissions() {
    return true
  },
  async prompt() {
    return PROMPT
  },

  async validateInput(input: Input) {
    if ((input.action === 'ask' || input.action === 'search') && !input.query) {
      return {
        result: false as const,
        message: 'query is required for ask and search actions',
      }
    }
    return { result: true as const }
  },

  renderToolUseMessage(input: Input, { verbose }: { verbose: boolean }) {
    if (verbose) {
      return `PaperQA ${input.action}: ${input.query ?? '(indexing)'}`
    }
    return `PaperQA: ${input.action}`
  },

  renderResultForAssistant(output: Output) {
    if (output.success) {
      return output.result
    }
    return `PaperQA error: ${output.error}`
  },

  renderToolResultMessage(output: Output) {
    if (output.success) {
      return `PaperQA ${output.action} completed`
    }
    return `PaperQA failed: ${output.error}`
  },

  async *call(input: Input) {
    const paperDir = input.paper_dir ?? 'literature/papers'

    // Try to get pqa binary (auto-installs into project venv)
    const pqaBin = await getPqaPath(paperDir)

    if (!pqaBin) {
      // pqa unavailable — fall back to chunk index for search/ask
      if (input.action === 'search' || input.action === 'ask') {
        const litDir = dirname(paperDir)
        const chunkIndexPath = join(litDir, 'chunk-index.json')
        if (existsSync(chunkIndexPath)) {
          const chunkIndex = new ChunkSearchIndex(litDir)
          const results = chunkIndex.search(input.query!, 10)
          if (results.length > 0) {
            const formatted = results
              .map(
                (r, i) =>
                  `[${i + 1}] (score: ${r.score.toFixed(3)}) ${r.section_title}\n${r.content.slice(0, 500)}${r.content.length > 500 ? '...' : ''}`,
              )
              .join('\n\n')
            const output: Output = {
              action: input.action,
              success: true,
              result: `Results from local chunk index (paper-qa auto-install failed):\n\n${formatted}`,
            }
            yield { type: 'result' as const, data: output }
            return
          }
        }
      }
      const output: Output = {
        action: input.action,
        success: false,
        result: '',
        error:
          'paper-qa auto-install failed. Ensure python3 is available, or install manually: pip install paper-qa',
      }
      yield { type: 'result' as const, data: output }
      return
    }

    yield {
      type: 'progress' as const,
      content: `Running PaperQA ${input.action}...`,
    }

    try {
      const indexDir = join(dirname(paperDir), 'index')
      const args: string[] = [pqaBin]

      switch (input.action) {
        case 'index':
          args.push(
            'index',
            '--directory',
            paperDir,
            '--index-directory',
            indexDir,
          )
          break
        case 'ask': {
          const q = input.query!
          args.push(
            'ask',
            q,
            '--directory',
            paperDir,
            '--index-directory',
            indexDir,
          )
          break
        }
        case 'search': {
          const q = input.query!
          args.push(
            'search',
            q,
            '--directory',
            paperDir,
            '--index-directory',
            indexDir,
          )
          break
        }
      }

      const proc = Bun.spawn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: resolve(paperDir, '..', '..'),
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited

      if (exitCode !== 0) {
        throw new Error(stderr || `pqa exited with code ${exitCode}`)
      }

      const output: Output = {
        action: input.action,
        success: true,
        result: stdout.trim(),
      }
      yield { type: 'result' as const, data: output }
    } catch (err: any) {
      const output: Output = {
        action: input.action,
        success: false,
        result: '',
        error: err.stderr ?? err.message ?? String(err),
      }
      yield { type: 'result' as const, data: output }
    }
  },
} satisfies Tool<typeof inputSchema, Output>
