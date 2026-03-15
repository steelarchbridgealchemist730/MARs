import { z } from 'zod'
import type { Tool } from '@tool'

const inputSchema = z.strictObject({
  query: z.string().describe('Search keywords for arXiv'),
  categories: z
    .array(z.string())
    .optional()
    .describe('arXiv category filters, e.g. ["q-fin.ST", "stat.ML"]'),
  max_results: z
    .number()
    .optional()
    .default(20)
    .describe('Maximum number of results to return'),
  sort_by: z
    .enum(['relevance', 'lastUpdatedDate', 'submittedDate'])
    .optional()
    .default('relevance')
    .describe('Sort order for results'),
  date_from: z
    .string()
    .optional()
    .describe('Start date filter in YYYY-MM-DD format'),
})

type Input = z.infer<typeof inputSchema>

interface ArxivPaper {
  arxiv_id: string
  title: string
  authors: string[]
  abstract: string
  categories: string[]
  published: string
  updated: string
  pdf_url: string
  comment?: string
}

type Output = {
  papers: ArxivPaper[]
  total_results: number
  query: string
}

function parseAtomXml(xml: string): ArxivPaper[] {
  const papers: ArxivPaper[] = []
  const entries = xml.split('<entry>').slice(1)

  for (const entry of entries) {
    const get = (tag: string): string => {
      const match = entry.match(
        new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`),
      )
      return match ? match[1].trim() : ''
    }

    const id = get('id').replace('http://arxiv.org/abs/', '')
    const title = get('title').replace(/\s+/g, ' ')
    const abstract = get('summary').replace(/\s+/g, ' ')
    const published = get('published')
    const updated = get('updated')
    const comment = get('arxiv:comment') || undefined

    // Parse authors
    const authorMatches = entry.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)
    const authors = [...authorMatches].map(m => m[1].trim())

    // Parse categories
    const catMatches = entry.matchAll(/category[^>]*term="([^"]+)"/g)
    const categories = [...catMatches].map(m => m[1])

    // Parse PDF link
    const pdfMatch = entry.match(/link[^>]*title="pdf"[^>]*href="([^"]+)"/)
    const pdf_url = pdfMatch ? pdfMatch[1] : `https://arxiv.org/pdf/${id}.pdf`

    papers.push({
      arxiv_id: id,
      title,
      authors,
      abstract,
      categories,
      published,
      updated,
      pdf_url,
      comment,
    })
  }

  return papers
}

function buildArxivQuery(input: Input): string {
  let query = input.query

  if (input.categories && input.categories.length > 0) {
    const catQuery = input.categories.map(c => `cat:${c}`).join('+OR+')
    query = `(${encodeURIComponent(query)})+AND+(${catQuery})`
  } else {
    query = encodeURIComponent(query)
  }

  return query
}

const TOOL_NAME = 'ArxivSearch'

const PROMPT = `Search arXiv for academic papers.
Returns papers matching the query with title, authors, abstract, categories, and PDF URL.
Supports filtering by arXiv categories (e.g. q-fin.ST, stat.ML, cs.LG) and date range.
Use this tool for finding preprints and published papers in physics, mathematics, computer science, and quantitative finance.`

export const ArxivSearchTool = {
  name: TOOL_NAME,
  async description() {
    return 'Search arXiv for academic papers'
  },
  userFacingName: () => 'arXiv Search',
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
      return `Searching arXiv for: "${input.query}" (max ${input.max_results ?? 20} results)`
    }
    return `arXiv: "${input.query}"`
  },

  renderResultForAssistant(output: Output) {
    if (output.papers.length === 0) {
      return `No papers found for query: "${output.query}"`
    }

    const lines = [`Found ${output.papers.length} papers on arXiv:\n`]
    for (const p of output.papers) {
      lines.push(`## ${p.title}`)
      lines.push(`- **ID**: ${p.arxiv_id}`)
      lines.push(`- **Authors**: ${p.authors.join(', ')}`)
      lines.push(`- **Categories**: ${p.categories.join(', ')}`)
      lines.push(`- **Published**: ${p.published}`)
      lines.push(`- **PDF**: ${p.pdf_url}`)
      lines.push(`- **Abstract**: ${p.abstract.slice(0, 300)}...`)
      lines.push('')
    }
    return lines.join('\n')
  },

  renderToolResultMessage(output: Output) {
    return `Found ${output.papers.length} papers on arXiv for "${output.query}"`
  },

  async *call(input: Input) {
    const query = buildArxivQuery(input)
    const maxResults = input.max_results ?? 20
    const sortBy = input.sort_by ?? 'relevance'

    const sortMap: Record<string, string> = {
      relevance: 'relevance',
      lastUpdatedDate: 'lastUpdatedDate',
      submittedDate: 'submittedDate',
    }

    let url = `http://export.arxiv.org/api/query?search_query=all:${query}&start=0&max_results=${maxResults}&sortBy=${sortMap[sortBy]}&sortOrder=descending`

    yield {
      type: 'progress' as const,
      content: `Searching arXiv for "${input.query}"...`,
    }

    // Throttle: arXiv has ~1 req/3s limit
    await new Promise(resolve => setTimeout(resolve, 3000))

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `arXiv API error: ${response.status} ${response.statusText}`,
      )
    }

    const xml = await response.text()
    let papers = parseAtomXml(xml)

    // Filter by date if provided
    if (input.date_from) {
      const fromDate = new Date(input.date_from)
      papers = papers.filter(p => new Date(p.published) >= fromDate)
    }

    const output: Output = {
      papers,
      total_results: papers.length,
      query: input.query,
    }

    yield { type: 'result' as const, data: output }
  },
} satisfies Tool<typeof inputSchema, Output>
