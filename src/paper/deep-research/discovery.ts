import { ArxivSearchTool } from '../../tools/paper/ArxivSearchTool'
import { SemanticScholarTool } from '../../tools/paper/SemanticScholarTool'
import { SSRNSearchTool } from '../../tools/paper/SSRNSearchTool'
import { CitationGraphTraversal } from './citation-graph'
import { chatCompletion } from '../llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import { extractModelId } from '../agent-dispatch'
import type {
  ResearchPlan,
  DiscoveredPaper,
  DeepResearchOptions,
} from './types'

async function collectResult<T>(gen: AsyncGenerator<any>): Promise<T | null> {
  let last: any = null
  try {
    for await (const item of gen) {
      if (item.type === 'result') {
        last = item.data
      }
    }
  } catch {
    // ignore search errors gracefully
  }
  return last as T | null
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim()
}

function scoreRelevance(
  paper: { title: string; citation_count: number; year: number },
  topicKeywords: string[],
  sinceYear: number,
  currentYear: number,
): number {
  // Title match score (0.4 weight)
  const normalizedTitle = paper.title.toLowerCase()
  const matchedKeywords = topicKeywords.filter(kw =>
    normalizedTitle.includes(kw.toLowerCase()),
  )
  const titleScore =
    topicKeywords.length > 0 ? matchedKeywords.length / topicKeywords.length : 0

  // Citation count score, normalized with log scale (0.3 weight)
  const citationScore =
    paper.citation_count > 0
      ? Math.min(Math.log10(paper.citation_count + 1) / Math.log10(1001), 1)
      : 0

  // Year recency score (0.3 weight)
  const yearRange = Math.max(currentYear - sinceYear, 1)
  const yearScore = Math.min(
    Math.max((paper.year - sinceYear) / yearRange, 0),
    1,
  )

  return titleScore * 0.4 + citationScore * 0.3 + yearScore * 0.3
}

export class PaperDiscovery {
  private options: DeepResearchOptions

  constructor(options: DeepResearchOptions) {
    this.options = options
  }

  async discover(plan: ResearchPlan): Promise<DiscoveredPaper[]> {
    const sinceYear = this.options.since_year ?? 2019
    const maxPapers = this.options.max_papers ?? 100
    const currentYear = new Date().getFullYear()

    // Collect all queries across all dimensions and types
    const allQueries: string[] = []
    for (const dim of plan.dimensions) {
      allQueries.push(...dim.queries.precise)
      allQueries.push(...dim.queries.broad)
      allQueries.push(...dim.queries.cross_domain)
    }

    // Deduplicate queries
    const uniqueQueries = [...new Set(allQueries)]

    // Run all searches in parallel (batched to avoid overwhelming APIs)
    const BATCH_SIZE = 4
    const allDiscovered: DiscoveredPaper[] = []

    for (let i = 0; i < uniqueQueries.length; i += BATCH_SIZE) {
      const batch = uniqueQueries.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(
        batch.flatMap(query => [
          this.searchArxiv(query, sinceYear),
          this.searchSemanticScholar(query, sinceYear),
          this.searchSSRN(query, sinceYear),
        ]),
      )
      for (const papers of batchResults) {
        allDiscovered.push(...papers)
      }
    }

    // Deduplicate by normalized title
    const seen = new Map<string, DiscoveredPaper>()
    for (const paper of allDiscovered) {
      const key = normalizeTitle(paper.title)
      if (!seen.has(key)) {
        seen.set(key, paper)
      } else {
        // Keep the one with higher citation count
        const existing = seen.get(key)!
        if (paper.citation_count > existing.citation_count) {
          seen.set(key, paper)
        }
      }
    }

    // Extract topic keywords for scoring
    const topicKeywords = plan.topic
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3)

    // Score and filter
    let papers = Array.from(seen.values())

    // Filter by year
    papers = papers.filter(p => p.year >= sinceYear)

    // Score relevance
    papers = papers.map(p => ({
      ...p,
      relevance_score: scoreRelevance(p, topicKeywords, sinceYear, currentYear),
    }))

    // Sort by relevance descending
    papers.sort((a, b) => b.relevance_score - a.relevance_score)

    // Citation graph traversal (forward + backward, depth=2) per spec
    if (this.options.depth !== 'quick' && papers.length > 0) {
      const citationGraph = new CitationGraphTraversal(2)
      const expanded = await citationGraph.traverse(papers)
      // Merge expanded papers, re-score, deduplicate
      const expandedSeen = new Map<string, DiscoveredPaper>()
      for (const p of expanded) {
        const key = normalizeTitle(p.title)
        if (!expandedSeen.has(key)) {
          expandedSeen.set(key, {
            ...p,
            relevance_score:
              p.relevance_score > 0
                ? p.relevance_score
                : scoreRelevance(p, topicKeywords, sinceYear, currentYear),
          })
        } else {
          const existing = expandedSeen.get(key)!
          if (p.citation_count > existing.citation_count) {
            expandedSeen.set(key, {
              ...p,
              relevance_score:
                p.relevance_score > 0
                  ? p.relevance_score
                  : scoreRelevance(p, topicKeywords, sinceYear, currentYear),
            })
          }
        }
      }
      papers = Array.from(expandedSeen.values())
        .filter(p => p.year >= sinceYear)
        .sort((a, b) => b.relevance_score - a.relevance_score)
    }

    // LLM-based relevance scoring for top candidates (per spec §4.2)
    // Apply to top 2x max_papers by heuristic score, then re-rank
    if (this.options.depth !== 'quick' && papers.length > 0) {
      const candidateCount = Math.min(papers.length, maxPapers * 2)
      const candidates = papers.slice(0, candidateCount)
      const llmScored = await this.llmRelevanceScore(
        candidates,
        plan.topic,
        plan.dimensions.map(d => d.name),
      )
      // Merge LLM scores: blend heuristic (0.3) + LLM (0.7)
      for (const paper of llmScored) {
        const heuristicScore = paper.relevance_score
        const llmScore = (paper as any).__llm_score as number | undefined
        if (llmScore !== undefined) {
          paper.relevance_score = heuristicScore * 0.3 + llmScore * 0.7
        }
        delete (paper as any).__llm_score
      }
      // Re-sort after LLM scoring
      llmScored.sort((a, b) => b.relevance_score - a.relevance_score)
      papers = [...llmScored, ...papers.slice(candidateCount)]
    }

    // Limit to max_papers
    return papers.slice(0, maxPapers)
  }

  /**
   * Use LLM to score relevance of papers to the research topic.
   * Scores papers in batches to minimize API calls.
   */
  private async llmRelevanceScore(
    papers: DiscoveredPaper[],
    topic: string,
    dimensions: string[],
  ): Promise<DiscoveredPaper[]> {
    const BATCH_SIZE = 20
    const model = extractModelId(DEFAULT_MODEL_ASSIGNMENTS.quick)
    const result = [...papers]

    for (let i = 0; i < result.length; i += BATCH_SIZE) {
      const batch = result.slice(i, i + BATCH_SIZE)
      const paperList = batch
        .map(
          (p, idx) =>
            `[${idx}] "${p.title}" (${p.year}) - ${p.abstract.slice(0, 150)}`,
        )
        .join('\n')

      try {
        const response = await chatCompletion({
          modelSpec: model,
          max_tokens: 1024,
          temperature: 0,
          system:
            'You are a research relevance scorer. Given a research topic and a list of papers, score each paper 0.0 to 1.0 for relevance. Return ONLY a JSON array of numbers in the same order, e.g. [0.8, 0.3, 0.9]. No markdown fences.',
          messages: [
            {
              role: 'user',
              content: `Research topic: "${topic}"\nDimensions: ${dimensions.join(', ')}\n\nPapers:\n${paperList}`,
            },
          ],
        })

        const text = response.text.trim()
        const jsonMatch = text.match(/\[[\s\S]*?\]/)
        if (jsonMatch) {
          const scores = JSON.parse(jsonMatch[0]) as number[]
          for (let j = 0; j < Math.min(scores.length, batch.length); j++) {
            const score = scores[j]
            if (typeof score === 'number' && score >= 0 && score <= 1) {
              ;(result[i + j] as any).__llm_score = score
            }
          }
        }
      } catch (err: any) {
        // LLM scoring failed for this batch — keep heuristic scores
        if (typeof process !== 'undefined' && process.stderr) {
          process.stderr.write(
            `[discovery] LLM relevance scoring failed for batch ${i}: ${err.message ?? err}\n`,
          )
        }
      }
    }

    return result
  }

  private async searchArxiv(
    query: string,
    sinceYear: number,
  ): Promise<DiscoveredPaper[]> {
    const dateFrom = `${sinceYear}-01-01`
    const gen = ArxivSearchTool.call({
      query,
      max_results: 20,
      sort_by: 'relevance',
      date_from: dateFrom,
    })

    type ArxivOutput = {
      papers: Array<{
        arxiv_id: string
        title: string
        authors: string[]
        abstract: string
        published: string
        pdf_url: string
        categories: string[]
      }>
    }

    const result = await collectResult<ArxivOutput>(gen)
    if (!result) return []

    return result.papers.map(p => {
      const year = p.published
        ? parseInt(p.published.slice(0, 4), 10)
        : sinceYear
      return {
        title: p.title,
        authors: p.authors,
        year,
        abstract: p.abstract ?? '',
        source: 'arxiv' as const,
        source_id: p.arxiv_id,
        arxiv_id: p.arxiv_id,
        pdf_url: p.pdf_url,
        url: `https://arxiv.org/abs/${p.arxiv_id}`,
        citation_count: 0,
        relevance_score: 0,
      }
    })
  }

  private async searchSSRN(
    query: string,
    sinceYear: number,
  ): Promise<DiscoveredPaper[]> {
    const gen = SSRNSearchTool.call({
      query,
      max_results: 15,
    })

    type SSRNOutput = {
      papers: Array<{
        paperId: string
        title: string
        authors: { name: string }[]
        year: number | null
        abstract: string | null
        citationCount: number
        ssrnId: string
        ssrnUrl: string
        openAccessPdf?: { url: string } | null
      }>
    }

    const result = await collectResult<SSRNOutput>(gen)
    if (!result) return []

    return result.papers
      .filter(p => p.title && (p.year ?? sinceYear) >= sinceYear)
      .map(p => ({
        title: p.title,
        authors: p.authors.map(a => a.name),
        year: p.year ?? sinceYear,
        abstract: p.abstract ?? '',
        source: 'ssrn' as const,
        source_id: p.ssrnId,
        s2_paper_id: p.paperId,
        ssrn_id: p.ssrnId,
        pdf_url: p.openAccessPdf?.url ?? undefined,
        url: p.ssrnUrl,
        citation_count: p.citationCount ?? 0,
        relevance_score: 0,
      }))
  }

  private async searchSemanticScholar(
    query: string,
    sinceYear: number,
  ): Promise<DiscoveredPaper[]> {
    const currentYear = new Date().getFullYear()
    const gen = SemanticScholarTool.call({
      query,
      limit: 20,
      year_range: `${sinceYear}-${currentYear}`,
    })

    type S2Output = {
      papers: Array<{
        paperId: string
        title: string
        authors: { name: string }[]
        year: number | null
        abstract: string | null
        citationCount: number
        isOpenAccess: boolean
        openAccessPdf?: { url: string } | null
        externalIds?: { DOI?: string; ArXiv?: string; SSRN?: string } | null
      }>
    }

    const result = await collectResult<S2Output>(gen)
    if (!result) return []

    return result.papers
      .filter(p => p.title)
      .map(p => {
        const arxivId = p.externalIds?.ArXiv ?? undefined
        const ssrnId = p.externalIds?.SSRN ?? undefined
        const doi = p.externalIds?.DOI ?? undefined
        const pdfUrl = p.openAccessPdf?.url ?? undefined

        return {
          title: p.title,
          authors: p.authors.map(a => a.name),
          year: p.year ?? sinceYear,
          abstract: p.abstract ?? '',
          source: 'semantic_scholar' as const,
          source_id: p.paperId,
          s2_paper_id: p.paperId,
          arxiv_id: arxivId,
          ssrn_id: ssrnId,
          doi,
          pdf_url: pdfUrl,
          url: `https://www.semanticscholar.org/paper/${p.paperId}`,
          citation_count: p.citationCount ?? 0,
          relevance_score: 0,
        }
      })
  }
}
