import { z } from 'zod'
import type { Tool } from '@tool'
import { join } from 'path'
import {
  BibTeXManager,
  formatBibTeX,
  type BibTeXEntry,
} from '../../paper/writing/bibtex-manager'

const PROMPT = `Manage the bibliography (bibliography.bib) for the research paper.
Actions: add_arxiv (from arXiv ID), add_s2 (from Semantic Scholar ID), add_manual, get (by key), list, search, has_key, find_closest, scan_cites, sync_literature.`

const inputSchema = z.strictObject({
  action: z
    .enum([
      'add_arxiv',
      'add_s2',
      'add_manual',
      'get',
      'list',
      'search',
      'has_key',
      'find_closest',
      'scan_cites',
      'sync_literature',
    ])
    .describe('Action to perform'),
  arxiv_id: z.string().optional().describe('arXiv paper ID (for add_arxiv)'),
  s2_paper_id: z
    .string()
    .optional()
    .describe('Semantic Scholar paper ID (for add_s2)'),
  key: z
    .string()
    .optional()
    .describe('Citation key (for get, has_key, find_closest)'),
  query: z
    .string()
    .optional()
    .describe('Search query for bibliography (for search)'),
  entry: z
    .object({
      key: z.string(),
      type: z.enum(['article', 'inproceedings', 'misc', 'techreport']),
      title: z.string(),
      authors: z.array(z.string()),
      year: z.number(),
      journal: z.string().optional(),
      booktitle: z.string().optional(),
      url: z.string().optional(),
      doi: z.string().optional(),
      arxiv_id: z.string().optional(),
    })
    .optional()
    .describe('Manual BibTeX entry (for add_manual)'),
  bib_path: z
    .string()
    .optional()
    .describe(
      'Path to bibliography.bib file (defaults to paper/bibliography.bib)',
    ),
  paper_dir: z
    .string()
    .optional()
    .describe(
      'Path to paper directory containing .tex files (for scan_cites, sync_literature)',
    ),
  literature_bib_path: z
    .string()
    .optional()
    .describe('Path to literature bibliography.bib (for sync_literature)'),
})

type Input = z.infer<typeof inputSchema>
type Output = { success?: boolean; error?: string; [key: string]: unknown }

export const BibTeXTool = {
  name: 'BibTeXTool',
  userFacingName: () => 'BibTeX Manager',
  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  async isEnabled() {
    return true
  },
  needsPermissions() {
    return false
  },
  async prompt() {
    return PROMPT
  },
  renderToolUseMessage(input: Input, { verbose }: { verbose: boolean }) {
    if (verbose) {
      return `BibTeX ${input.action}${input.arxiv_id ? ` (${input.arxiv_id})` : ''}${input.key ? ` (${input.key})` : ''}`
    }
    return `bibtex: ${input.action}`
  },
  renderResultForAssistant(output: Output) {
    if (output.error) return `BibTeX error: ${output.error}`
    return JSON.stringify(output, null, 2)
  },
  renderToolResultMessage(output: Output) {
    if (output.error) return `BibTeX error: ${output.error}`
    if (output.message) return String(output.message)
    return `BibTeX: ${output.success ? 'success' : 'done'}`
  },

  async *call(input: Input) {
    const bibPath =
      input.bib_path ??
      join(process.cwd(), '.claude-paper-research', 'paper', 'bibliography.bib')

    const manager = new BibTeXManager(bibPath)

    try {
      switch (input.action) {
        case 'add_arxiv': {
          if (!input.arxiv_id) {
            yield {
              type: 'result' as const,
              data: { error: 'arxiv_id is required for add_arxiv' },
            }
            return
          }
          yield {
            type: 'progress' as const,
            content: `Fetching arXiv metadata for ${input.arxiv_id}...`,
          }
          const key = await manager.addFromArxiv(input.arxiv_id)
          yield {
            type: 'result' as const,
            data: {
              success: true,
              key,
              message: `Added arXiv paper ${input.arxiv_id} as \\cite{${key}}`,
            },
          }
          return
        }
        case 'add_s2': {
          if (!input.s2_paper_id) {
            yield {
              type: 'result' as const,
              data: { error: 's2_paper_id is required for add_s2' },
            }
            return
          }
          yield {
            type: 'progress' as const,
            content: `Fetching S2 metadata for ${input.s2_paper_id}...`,
          }
          const key = await manager.addFromS2(input.s2_paper_id)
          yield {
            type: 'result' as const,
            data: {
              success: true,
              key,
              message: `Added S2 paper ${input.s2_paper_id} as \\cite{${key}}`,
            },
          }
          return
        }
        case 'add_manual': {
          if (!input.entry) {
            yield {
              type: 'result' as const,
              data: { error: 'entry is required for add_manual' },
            }
            return
          }
          const key = await manager.addEntry(input.entry as BibTeXEntry)
          yield {
            type: 'result' as const,
            data: {
              success: true,
              key,
              message: `Added manual entry as \\cite{${key}}`,
              bibtex: formatBibTeX(input.entry as BibTeXEntry),
            },
          }
          return
        }
        case 'get': {
          if (!input.key) {
            yield {
              type: 'result' as const,
              data: { error: 'key is required for get' },
            }
            return
          }
          const bibtex = manager.getBibTeX(input.key)
          yield {
            type: 'result' as const,
            data: bibtex
              ? { found: true, bibtex }
              : { found: false, message: `Key "${input.key}" not found` },
          }
          return
        }
        case 'list': {
          const keys = await manager.getAllKeys()
          yield {
            type: 'result' as const,
            data: { count: keys.length, keys },
          }
          return
        }
        case 'search': {
          const query = input.query?.toLowerCase() ?? ''
          const keys = await manager.getAllKeys()
          const matching = keys.filter(k => k.toLowerCase().includes(query))
          yield {
            type: 'result' as const,
            data: {
              query: input.query,
              matches: matching,
              count: matching.length,
            },
          }
          return
        }
        case 'has_key': {
          if (!input.key) {
            yield {
              type: 'result' as const,
              data: { error: 'key is required for has_key' },
            }
            return
          }
          const exists = manager.hasKey(input.key)
          yield {
            type: 'result' as const,
            data: { key: input.key, exists },
          }
          return
        }
        case 'find_closest': {
          if (!input.key) {
            yield {
              type: 'result' as const,
              data: { error: 'key is required for find_closest' },
            }
            return
          }
          const closest = await manager.findClosestKey(input.key)
          yield {
            type: 'result' as const,
            data: closest
              ? { found: true, closest_key: closest, original_key: input.key }
              : { found: false, message: `No close match for "${input.key}"` },
          }
          return
        }
        case 'scan_cites': {
          if (!input.paper_dir) {
            yield {
              type: 'result' as const,
              data: { error: 'paper_dir is required for scan_cites' },
            }
            return
          }
          const citeKeys = await manager.scanAllCiteKeys(input.paper_dir)
          yield {
            type: 'result' as const,
            data: { count: citeKeys.length, keys: citeKeys },
          }
          return
        }
        case 'sync_literature': {
          if (!input.literature_bib_path || !input.paper_dir) {
            yield {
              type: 'result' as const,
              data: {
                error:
                  'literature_bib_path and paper_dir are required for sync_literature',
              },
            }
            return
          }
          yield {
            type: 'progress' as const,
            content: 'Syncing bibliography from literature...',
          }
          const syncResult = await manager.syncFromLiterature(
            input.literature_bib_path,
            input.paper_dir,
          )
          yield {
            type: 'result' as const,
            data: {
              success: true,
              ...syncResult,
              message: `Synced ${syncResult.synced} entries, ${syncResult.missing} missing, ${syncResult.fixed.length} auto-fixed`,
            },
          }
          return
        }
      }
    } catch (error: any) {
      yield { type: 'result' as const, data: { error: error.message } }
    }
  },
} satisfies Tool<typeof inputSchema, Output>
