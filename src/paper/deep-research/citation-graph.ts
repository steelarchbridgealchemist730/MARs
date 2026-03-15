import type { DiscoveredPaper } from './types'

interface CitationLink {
  from_id: string
  to_id: string
  direction: 'forward' | 'backward'
}

export class CitationGraphTraversal {
  private maxDepth: number
  private visited = new Set<string>()
  private batchDelay = 1200 // ms between S2 requests to respect rate limits

  constructor(maxDepth = 2) {
    this.maxDepth = maxDepth
  }

  async traverse(
    seedPapers: DiscoveredPaper[],
    onProgress?: (msg: string) => void,
  ): Promise<DiscoveredPaper[]> {
    const allPapers = new Map<string, DiscoveredPaper>()

    // Index seed papers
    for (const p of seedPapers) {
      const key = this.paperKey(p)
      allPapers.set(key, p)
      this.visited.add(key)
    }

    // Get S2 paper IDs for traversal
    const s2Papers = seedPapers.filter(p => p.s2_paper_id)

    // Only traverse top papers by relevance (limit to 20 to stay within rate limits)
    const topPapers = s2Papers
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, 20)

    for (let depth = 1; depth <= this.maxDepth; depth++) {
      onProgress?.(
        `  Citation traversal depth ${depth}/${this.maxDepth} (${topPapers.length} seed papers)...`,
      )

      const newPapers: DiscoveredPaper[] = []

      for (const paper of topPapers) {
        if (!paper.s2_paper_id) continue

        // Forward citations (papers that cite this one)
        const citing = await this.fetchCitations(paper.s2_paper_id, 'citations')
        for (const p of citing) {
          const key = this.paperKey(p)
          if (!this.visited.has(key)) {
            this.visited.add(key)
            allPapers.set(key, p)
            newPapers.push(p)
          }
        }

        // Backward citations (papers this one references)
        const referenced = await this.fetchCitations(
          paper.s2_paper_id,
          'references',
        )
        for (const p of referenced) {
          const key = this.paperKey(p)
          if (!this.visited.has(key)) {
            this.visited.add(key)
            allPapers.set(key, p)
            newPapers.push(p)
          }
        }

        // Rate limit
        await this.delay(this.batchDelay)
      }

      onProgress?.(
        `  Depth ${depth}: found ${newPapers.length} new papers via citation graph`,
      )

      // Use newly found papers as seeds for next depth (only top by citations)
      if (depth < this.maxDepth) {
        topPapers.length = 0
        const sorted = newPapers
          .filter(p => p.s2_paper_id)
          .sort((a, b) => b.citation_count - a.citation_count)
          .slice(0, 10)
        topPapers.push(...sorted)
      }
    }

    return Array.from(allPapers.values())
  }

  private async fetchCitations(
    s2PaperId: string,
    direction: 'citations' | 'references',
  ): Promise<DiscoveredPaper[]> {
    const url = `https://api.semanticscholar.org/graph/v1/paper/${s2PaperId}/${direction}?fields=paperId,title,authors,year,abstract,citationCount,externalIds,isOpenAccess,openAccessPdf&limit=20`

    try {
      const headers: Record<string, string> = {}
      if (process.env.S2_API_KEY) {
        headers['x-api-key'] = process.env.S2_API_KEY
      }

      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return []

      const data = (await response.json()) as {
        data?: Array<{
          citingPaper?: Record<string, any>
          citedPaper?: Record<string, any>
        }>
      }

      if (!data.data) return []

      return data.data
        .map(item => {
          const paper =
            direction === 'citations' ? item.citingPaper : item.citedPaper
          if (!paper || !paper.title) return null

          const authors = Array.isArray(paper.authors)
            ? paper.authors.map((a: { name: string }) => a.name)
            : []

          return {
            title: paper.title,
            authors,
            year: paper.year ?? 0,
            abstract: paper.abstract ?? '',
            source: 'semantic_scholar' as const,
            source_id: paper.paperId ?? '',
            s2_paper_id: paper.paperId ?? undefined,
            arxiv_id: paper.externalIds?.ArXiv ?? undefined,
            doi: paper.externalIds?.DOI ?? undefined,
            pdf_url: paper.openAccessPdf?.url ?? undefined,
            url: paper.paperId
              ? `https://www.semanticscholar.org/paper/${paper.paperId}`
              : undefined,
            citation_count: paper.citationCount ?? 0,
            relevance_score: 0,
          } as DiscoveredPaper
        })
        .filter((p): p is DiscoveredPaper => p !== null)
    } catch (err: any) {
      // API/network failure — skip this paper's citations but log it
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(
          `[citation-graph] Failed to fetch citations: ${err.message ?? err}\n`,
        )
      }
      return []
    }
  }

  private paperKey(paper: DiscoveredPaper): string {
    return paper.title.toLowerCase().replace(/\s+/g, ' ').trim()
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
