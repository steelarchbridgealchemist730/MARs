import { z } from 'zod'
import type { Tool } from '@tool'

const inputSchema = z.strictObject({
  query: z.string().describe('Search query for Semantic Scholar'),
  limit: z.number().optional().default(20).describe('Maximum results'),
  year_range: z
    .string()
    .optional()
    .describe('Year range filter, e.g. "2020-2025"'),
  fields_of_study: z
    .array(z.string())
    .optional()
    .describe('Fields to filter by, e.g. ["Computer Science", "Economics"]'),
  open_access_only: z
    .boolean()
    .optional()
    .default(false)
    .describe('Only return open access papers'),
  citation_count_min: z
    .number()
    .optional()
    .describe('Minimum citation count filter'),
  action: z
    .enum(['search', 'citations', 'references'])
    .optional()
    .default('search')
    .describe(
      'Action: "search" for keyword search, "citations" for forward citations of a paper, "references" for backward references',
    ),
  paper_id: z
    .string()
    .optional()
    .describe(
      'Paper ID (S2 ID, DOI, or ArXiv ID) for citations/references actions',
    ),
})

type Input = z.infer<typeof inputSchema>

interface S2Paper {
  paperId: string
  title: string
  authors: { name: string; authorId?: string }[]
  year: number | null
  abstract: string | null
  citationCount: number
  referenceCount: number
  fieldsOfStudy: string[] | null
  isOpenAccess: boolean
  openAccessPdf?: { url: string } | null
  externalIds?: { DOI?: string; ArXiv?: string; SSRN?: string } | null
}

type Output = {
  papers: S2Paper[]
  total: number
  query: string
}

const S2_API_BASE = 'https://api.semanticscholar.org/graph/v1'
const S2_FIELDS =
  'paperId,title,authors,year,abstract,citationCount,referenceCount,fieldsOfStudy,isOpenAccess,openAccessPdf,externalIds'

const TOOL_NAME = 'SemanticScholarSearch'

const PROMPT = `Search Semantic Scholar for academic papers and explore citation graphs.
Actions:
- "search": keyword search with filters (default)
- "citations": get papers that cite a given paper (forward citations, requires paper_id)
- "references": get papers referenced by a given paper (backward references, requires paper_id)
Returns papers with citation counts, open access PDF links, and external IDs (DOI, arXiv, SSRN).
Supports filtering by year range, fields of study, open access, and minimum citation count.`

export const SemanticScholarTool = {
  name: TOOL_NAME,
  async description() {
    return 'Search Semantic Scholar for academic papers'
  },
  userFacingName: () => 'Semantic Scholar Search',
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
      return `Searching Semantic Scholar for: "${input.query}" (max ${input.limit ?? 20})`
    }
    return `S2: "${input.query}"`
  },

  renderResultForAssistant(output: Output) {
    if (output.papers.length === 0) {
      return `No papers found for query: "${output.query}"`
    }

    const lines = [
      `Found ${output.papers.length} papers on Semantic Scholar:\n`,
    ]
    for (const p of output.papers) {
      lines.push(`## ${p.title}`)
      lines.push(`- **ID**: ${p.paperId}`)
      lines.push(`- **Authors**: ${p.authors.map(a => a.name).join(', ')}`)
      lines.push(`- **Year**: ${p.year ?? 'N/A'}`)
      lines.push(`- **Citations**: ${p.citationCount}`)
      lines.push(`- **Fields**: ${p.fieldsOfStudy?.join(', ') ?? 'N/A'}`)
      if (p.openAccessPdf?.url) {
        lines.push(`- **PDF**: ${p.openAccessPdf.url}`)
      }
      if (p.externalIds?.ArXiv) {
        lines.push(`- **arXiv**: ${p.externalIds.ArXiv}`)
      }
      if (p.externalIds?.SSRN) {
        lines.push(`- **SSRN**: ${p.externalIds.SSRN}`)
      }
      if (p.abstract) {
        lines.push(`- **Abstract**: ${p.abstract.slice(0, 300)}...`)
      }
      lines.push('')
    }
    return lines.join('\n')
  },

  renderToolResultMessage(output: Output) {
    return `Found ${output.papers.length} papers on Semantic Scholar`
  },

  async *call(input: Input) {
    const action = input.action ?? 'search'

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    const apiKey = process.env.S2_API_KEY
    if (apiKey) {
      headers['x-api-key'] = apiKey
    }

    // Citation graph traversal (forward citations or backward references)
    if ((action === 'citations' || action === 'references') && input.paper_id) {
      yield {
        type: 'progress' as const,
        content: `Fetching ${action} for paper "${input.paper_id}"...`,
      }

      const endpoint = action === 'citations' ? 'citations' : 'references'
      const limit = input.limit ?? 20
      const url = `${S2_API_BASE}/paper/${encodeURIComponent(input.paper_id)}/${endpoint}?fields=${S2_FIELDS}&limit=${limit}`

      const response = await fetch(url, { headers })

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error(
            'Semantic Scholar rate limit exceeded. Set S2_API_KEY for higher limits.',
          )
        }
        throw new Error(
          `Semantic Scholar API error: ${response.status} ${response.statusText}`,
        )
      }

      const data = (await response.json()) as {
        data: Array<{
          citingPaper?: S2Paper
          citedPaper?: S2Paper
        }>
      }

      let papers: S2Paper[] = (data.data ?? [])
        .map(d => (action === 'citations' ? d.citingPaper : d.citedPaper))
        .filter((p): p is S2Paper => p != null && p.paperId != null)

      if (input.citation_count_min) {
        papers = papers.filter(
          p => p.citationCount >= input.citation_count_min!,
        )
      }

      const output: Output = {
        papers,
        total: papers.length,
        query: `${action} of ${input.paper_id}`,
      }

      yield { type: 'result' as const, data: output }
      return
    }

    // Standard keyword search
    yield {
      type: 'progress' as const,
      content: `Searching Semantic Scholar for "${input.query}"...`,
    }

    const params = new URLSearchParams({
      query: input.query,
      limit: String(input.limit ?? 20),
      fields: S2_FIELDS,
    })

    if (input.year_range) {
      params.set('year', input.year_range)
    }
    if (input.fields_of_study && input.fields_of_study.length > 0) {
      params.set('fieldsOfStudy', input.fields_of_study.join(','))
    }
    if (input.open_access_only) {
      params.set('openAccessPdf', '')
    }

    const url = `${S2_API_BASE}/paper/search?${params.toString()}`
    const response = await fetch(url, { headers })

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error(
          'Semantic Scholar rate limit exceeded. Set S2_API_KEY for higher limits.',
        )
      }
      throw new Error(
        `Semantic Scholar API error: ${response.status} ${response.statusText}`,
      )
    }

    const data = (await response.json()) as { data: S2Paper[]; total: number }
    let papers = data.data ?? []

    // Apply citation count filter
    if (input.citation_count_min) {
      papers = papers.filter(p => p.citationCount >= input.citation_count_min!)
    }

    const output: Output = {
      papers,
      total: data.total ?? papers.length,
      query: input.query,
    }

    yield { type: 'result' as const, data: output }
  },
} satisfies Tool<typeof inputSchema, Output>
