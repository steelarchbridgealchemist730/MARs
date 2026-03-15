import { chatCompletion } from '../llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import { repairTruncatedJSON } from '../json-repair'
import type {
  DKPBuildConfig,
  PaperSourceConfig,
  ExtraSearchConfig,
} from './types'

// ── Types ───────────────────────────────────────────────

export interface DKPBuildPlan {
  domain: string
  description: string
  sub_directions: string[]
  recommended_textbooks: RecommendedTextbook[]
  recommended_papers: RecommendedPaper[]
  search_queries: ExtraSearchConfig[]
}

export interface RecommendedTextbook {
  id: string
  title: string
  authors: string[]
  year: number
  reason: string
}

export interface RecommendedPaper {
  id: string
  title: string
  authors: string[]
  year: number
  arxiv_id?: string
  reason: string
}

// ── Planner ─────────────────────────────────────────────

export class DKPPlanner {
  /**
   * Given a domain name and optional description, use LLM to plan
   * what textbooks, papers, and searches to include in a knowledge pack.
   */
  async plan(domain: string, description?: string): Promise<DKPBuildPlan> {
    const prompt = `You are planning the construction of a domain knowledge pack for academic research.

Domain: "${domain}"
${description ? `Description: ${description}` : ''}

Your job is to recommend the most important sources for a researcher entering this field.

Output a JSON object with:
{
  "description": "A 1-2 sentence description of this domain",
  "sub_directions": ["3-7 key sub-areas within this domain"],
  "recommended_textbooks": [
    {
      "id": "authorYYYY",
      "title": "Full Book Title",
      "authors": ["Last1", "Last2"],
      "year": 2020,
      "reason": "Why this textbook is essential"
    }
  ],
  "recommended_papers": [
    {
      "id": "authorYYYY",
      "title": "Full Paper Title",
      "authors": ["Last1", "Last2"],
      "year": 2020,
      "arxiv_id": "2301.12345 (if available, else omit)",
      "reason": "Why this paper is important"
    }
  ],
  "search_queries": [
    {
      "query": "search query for finding more papers",
      "max_results": 10,
      "year_from": 2020
    }
  ]
}

Guidelines:
- Recommend 2-5 foundational textbooks (the ones every PhD student reads)
- Recommend 5-15 seminal/influential papers (mix of classics and recent)
- Include 2-4 search queries to find additional relevant work
- Prefer papers with arXiv versions (include arxiv_id if known)
- Focus on quality over quantity

Output ONLY valid JSON. No markdown fences.`

    const result = await chatCompletion({
      modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
      messages: [{ role: 'user', content: prompt }],
      system: 'You are an expert academic advisor. Output only valid JSON.',
      max_tokens: 4096,
      temperature: 0.3,
    })

    return this.parsePlanResponse(result.text, domain, description)
  }

  /**
   * Convert a build plan into a DKPBuildConfig.
   * Papers get source: "semantic_scholar" since they need to be downloaded.
   * Textbooks are listed but need manual path assignment by the user.
   */
  planToConfig(plan: DKPBuildPlan): DKPBuildConfig {
    const papers: PaperSourceConfig[] = plan.recommended_papers.map(p => ({
      id: p.id,
      source: (p.arxiv_id ? 'arxiv' : 'semantic_scholar') as
        | 'arxiv'
        | 'semantic_scholar',
    }))

    return {
      name: plan.domain,
      description: plan.description,
      // Textbooks require local PDFs — user must provide paths
      // We include them as empty-path entries so the builder knows to skip gracefully
      textbooks: [],
      papers,
      extra_searches: plan.search_queries,
      registries: {
        search_datasets: true,
        search_benchmarks: true,
        search_codebases: true,
      },
    }
  }

  // ── Private ─────────────────────────────────────────────

  private parsePlanResponse(
    text: string,
    domain: string,
    description?: string,
  ): DKPBuildPlan {
    const cleaned = text
      .replace(/```(?:json)?\s*\n?/g, '')
      .replace(/```\s*$/g, '')
      .trim()

    let parsed: Record<string, unknown> | null = null

    try {
      parsed = JSON.parse(cleaned) as Record<string, unknown>
    } catch {
      // Try extracting JSON object
      const match = cleaned.match(/\{[\s\S]*\}/)
      if (match) {
        try {
          parsed = JSON.parse(match[0]) as Record<string, unknown>
        } catch {
          // Try repair
          const repaired = repairTruncatedJSON(cleaned)
          if (
            repaired &&
            typeof repaired === 'object' &&
            !Array.isArray(repaired)
          ) {
            parsed = repaired as Record<string, unknown>
          }
        }
      }
    }

    if (!parsed) {
      // Return minimal plan
      return {
        domain,
        description: description || domain,
        sub_directions: [],
        recommended_textbooks: [],
        recommended_papers: [],
        search_queries: [{ query: domain, max_results: 10 }],
      }
    }

    return {
      domain,
      description:
        typeof parsed.description === 'string'
          ? parsed.description
          : description || domain,
      sub_directions: Array.isArray(parsed.sub_directions)
        ? (parsed.sub_directions as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          )
        : [],
      recommended_textbooks: this.parseTextbooks(parsed.recommended_textbooks),
      recommended_papers: this.parsePapers(parsed.recommended_papers),
      search_queries: this.parseSearchQueries(parsed.search_queries),
    }
  }

  private parseTextbooks(raw: unknown): RecommendedTextbook[] {
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object',
      )
      .map(item => ({
        id: typeof item.id === 'string' ? item.id : 'unknown',
        title: typeof item.title === 'string' ? item.title : 'Unknown',
        authors: Array.isArray(item.authors)
          ? (item.authors as unknown[]).filter(
              (a): a is string => typeof a === 'string',
            )
          : [],
        year: typeof item.year === 'number' ? item.year : 0,
        reason: typeof item.reason === 'string' ? item.reason : '',
      }))
  }

  private parsePapers(raw: unknown): RecommendedPaper[] {
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object',
      )
      .map(item => ({
        id: typeof item.id === 'string' ? item.id : 'unknown',
        title: typeof item.title === 'string' ? item.title : 'Unknown',
        authors: Array.isArray(item.authors)
          ? (item.authors as unknown[]).filter(
              (a): a is string => typeof a === 'string',
            )
          : [],
        year: typeof item.year === 'number' ? item.year : 0,
        arxiv_id: typeof item.arxiv_id === 'string' ? item.arxiv_id : undefined,
        reason: typeof item.reason === 'string' ? item.reason : '',
      }))
  }

  private parseSearchQueries(raw: unknown): ExtraSearchConfig[] {
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object',
      )
      .filter(item => typeof item.query === 'string')
      .map(item => ({
        query: item.query as string,
        max_results:
          typeof item.max_results === 'number' ? item.max_results : 10,
        year_from:
          typeof item.year_from === 'number' ? item.year_from : undefined,
      }))
  }
}
