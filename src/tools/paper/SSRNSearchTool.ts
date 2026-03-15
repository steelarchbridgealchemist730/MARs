import { z } from 'zod'
import type { Tool } from '@tool'

const inputSchema = z.strictObject({
  query: z.string().describe('Search query for SSRN papers'),
  max_results: z.number().optional().default(20).describe('Maximum results'),
})

type Input = z.infer<typeof inputSchema>

interface SSRNPaper {
  paperId: string
  title: string
  authors: { name: string }[]
  year: number | null
  abstract: string | null
  citationCount: number
  ssrnId: string
  ssrnUrl: string
  openAccessPdf?: { url: string } | null
}

type Output = {
  papers: SSRNPaper[]
  total: number
  query: string
}

const S2_API_BASE = 'https://api.semanticscholar.org/graph/v1'
const S2_FIELDS =
  'paperId,title,authors,year,abstract,citationCount,isOpenAccess,openAccessPdf,externalIds'

const TOOL_NAME = 'SSRNSearch'

const PROMPT = `Search for SSRN (Social Science Research Network) papers via Semantic Scholar.
Returns financial economics and social science working papers.
SSRN papers are identified by their SSRN ID and include download URLs when available.
Useful for finding working papers in finance, economics, accounting, and law.`

export const SSRNSearchTool = {
  name: TOOL_NAME,
  async description() {
    return 'Search SSRN papers via Semantic Scholar'
  },
  userFacingName: () => 'SSRN Search',
  inputSchema,
  isReadOnly: () => true,
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
      return `Searching SSRN for: "${input.query}" (max ${input.max_results ?? 20})`
    }
    return `SSRN: "${input.query}"`
  },

  renderResultForAssistant(output: Output) {
    if (output.papers.length === 0) {
      return `No SSRN papers found for query: "${output.query}"`
    }

    const lines = [`Found ${output.papers.length} SSRN papers:\n`]
    for (const p of output.papers) {
      lines.push(`## ${p.title}`)
      lines.push(`- **Authors**: ${p.authors.map(a => a.name).join(', ')}`)
      lines.push(`- **Year**: ${p.year ?? 'N/A'}`)
      lines.push(`- **Citations**: ${p.citationCount}`)
      lines.push(`- **SSRN ID**: ${p.ssrnId}`)
      lines.push(`- **SSRN URL**: ${p.ssrnUrl}`)
      if (p.openAccessPdf?.url) {
        lines.push(`- **PDF**: ${p.openAccessPdf.url}`)
      }
      if (p.abstract) {
        lines.push(`- **Abstract**: ${p.abstract.slice(0, 300)}...`)
      }
      lines.push('')
    }
    return lines.join('\n')
  },

  renderToolResultMessage(output: Output) {
    return `Found ${output.papers.length} SSRN papers`
  },

  async *call(input: Input) {
    yield {
      type: 'progress' as const,
      content: `Searching SSRN via Semantic Scholar for "${input.query}"...`,
    }

    // Search Semantic Scholar and filter for papers with SSRN IDs
    const limit = Math.min((input.max_results ?? 20) * 3, 100) // Request more to compensate for filtering
    const params = new URLSearchParams({
      query: input.query,
      limit: String(limit),
      fields: S2_FIELDS,
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    const apiKey = process.env.S2_API_KEY
    if (apiKey) {
      headers['x-api-key'] = apiKey
    }

    const url = `${S2_API_BASE}/paper/search?${params.toString()}`
    const response = await fetch(url, { headers })

    if (!response.ok) {
      throw new Error(
        `Semantic Scholar API error: ${response.status} ${response.statusText}`,
      )
    }

    const data = (await response.json()) as {
      data: Array<{
        paperId: string
        title: string
        authors: { name: string }[]
        year: number | null
        abstract: string | null
        citationCount: number
        openAccessPdf?: { url: string } | null
        externalIds?: { SSRN?: string } | null
      }>
    }

    // Filter for papers with SSRN IDs
    const ssrnPapers: SSRNPaper[] = (data.data ?? [])
      .filter(p => p.externalIds?.SSRN)
      .slice(0, input.max_results ?? 20)
      .map(p => ({
        paperId: p.paperId,
        title: p.title,
        authors: p.authors,
        year: p.year,
        abstract: p.abstract,
        citationCount: p.citationCount,
        ssrnId: p.externalIds!.SSRN!,
        ssrnUrl: `https://papers.ssrn.com/sol3/papers.cfm?abstract_id=${p.externalIds!.SSRN}`,
        openAccessPdf: p.openAccessPdf,
      }))

    const output: Output = {
      papers: ssrnPapers,
      total: ssrnPapers.length,
      query: input.query,
    }

    yield { type: 'result' as const, data: output }
  },
} satisfies Tool<typeof inputSchema, Output>
