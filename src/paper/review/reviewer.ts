import type {
  ReviewConfig,
  ReviewDimensions,
  ReviewReport,
  ReviewScore,
  Rubric,
  RubricAssessment,
  RubricReviewResult,
  RubricVerdict,
} from './types'
import { chatCompletion } from '../llm-client'

interface ArxivEntry {
  title: string
  authors: string
  summary: string
  published: string
}

const MAX_PAPER_CHARS = 60000

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n... (truncated)'
}

function computeWeightedScore(dimensions: ReviewDimensions): number {
  return (
    dimensions.originality * 0.15 +
    dimensions.significance * 0.15 +
    dimensions.soundness * 0.25 +
    dimensions.clarity * 0.1 +
    dimensions.reproducibility * 0.1 +
    dimensions.prior_work * 0.1 +
    dimensions.contribution * 0.15
  )
}

function scoreToDecision(score: number): ReviewReport['decision'] {
  if (score >= 8) return 'accept'
  if (score >= 6) return 'minor_revision'
  if (score >= 4) return 'major_revision'
  return 'reject'
}

function clampScore(value: unknown): ReviewScore {
  const n = typeof value === 'number' ? Math.round(value) : 5
  return Math.max(1, Math.min(10, n)) as ReviewScore
}

export class PaperReviewer {
  private modelSpec: string // "provider:model" format
  private reviewerId: string

  constructor(modelName: string, reviewerId: string) {
    // Accept both bare model names and "provider:model" specs
    this.modelSpec = modelName.includes(':') ? modelName : modelName
    this.reviewerId = reviewerId
  }

  private async extractSearchQueries(paperText: string): Promise<string[]> {
    const snippet = paperText.slice(0, 3000)
    const response = await chatCompletion({
      modelSpec: this.modelSpec,
      max_tokens: 512,
      system:
        'Extract 3 to 5 concise academic search queries that capture the key topics, methods, and contributions of this paper. Return ONLY a JSON array of strings, no markdown fences or extra text.',
      messages: [
        {
          role: 'user',
          content: snippet,
        },
      ],
    })

    const text = response.text || '[]'
    try {
      const queries = JSON.parse(text) as string[]
      return Array.isArray(queries) ? queries.slice(0, 5) : []
    } catch {
      const match = text.match(/\[[\s\S]*\]/)
      if (match) {
        try {
          const queries = JSON.parse(match[0]) as string[]
          return Array.isArray(queries) ? queries.slice(0, 5) : []
        } catch {
          return []
        }
      }
      return []
    }
  }

  private async fetchArxivResults(query: string): Promise<ArxivEntry[]> {
    const encoded = encodeURIComponent(query)
    const url = `http://export.arxiv.org/api/query?search_query=all:${encoded}&max_results=3&sortBy=submittedDate&sortOrder=descending`
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) return []
      const xml = await response.text()

      const entries: ArxivEntry[] = []
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
      let entryMatch: RegExpExecArray | null
      while ((entryMatch = entryRegex.exec(xml)) !== null) {
        const block = entryMatch[1]
        const title =
          block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? ''
        const summary =
          block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? ''
        const published =
          block.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() ?? ''

        const authorNames: string[] = []
        const authorRegex = /<author>\s*<name>([\s\S]*?)<\/name>/g
        let authorMatch: RegExpExecArray | null
        while ((authorMatch = authorRegex.exec(block)) !== null) {
          authorNames.push(authorMatch[1].trim())
        }

        if (title) {
          entries.push({
            title: title.replace(/\s+/g, ' '),
            authors: authorNames.slice(0, 3).join(', '),
            summary: summary.replace(/\s+/g, ' ').slice(0, 200),
            published: published.slice(0, 10),
          })
        }
      }
      return entries
    } catch {
      return []
    }
  }

  private async searchRecentLiterature(paperText: string): Promise<string> {
    const queries = await this.extractSearchQueries(paperText)
    if (queries.length === 0) return ''

    const allEntries: ArxivEntry[] = []
    const seen = new Set<string>()

    for (const query of queries) {
      const results = await this.fetchArxivResults(query)
      for (const entry of results) {
        const key = entry.title.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          allEntries.push(entry)
        }
      }
    }

    if (allEntries.length === 0) return ''

    const lines = allEntries.slice(0, 10).map((e, i) => {
      const authorStr = e.authors ? ` by ${e.authors}` : ''
      const dateStr = e.published ? ` (${e.published})` : ''
      return `${i + 1}. "${e.title}"${authorStr}${dateStr}\n   ${e.summary}`
    })

    return `\n\n--- Recent Related Papers (for grounding the review in current state of the art) ---\n${lines.join('\n\n')}\n--- End of Related Papers ---\n`
  }

  async review(paperText: string, config: ReviewConfig): Promise<ReviewReport> {
    const strengthClause = config.strength
      ? ` Review strength: ${config.strength}.`
      : ''

    let groundedContext = ''
    if (config.grounded) {
      groundedContext = await this.searchRecentLiterature(paperText)
    }

    const systemPrompt = `You are an expert academic reviewer for top-tier ML/AI/Finance conferences. Review this paper thoroughly across 7 dimensions: originality, significance, soundness, clarity, reproducibility, prior_work, contribution. Score each 1-10. Be critical but constructive.${strengthClause}${groundedContext ? ' Use the provided recent related papers to assess novelty and situate the work in current literature, but review the paper on its own merits.' : ''} Return a structured JSON review with exactly this structure:
{
  "dimensions": {
    "originality": <1-10>,
    "significance": <1-10>,
    "soundness": <1-10>,
    "clarity": <1-10>,
    "reproducibility": <1-10>,
    "prior_work": <1-10>,
    "contribution": <1-10>
  },
  "confidence": <1-5>,
  "summary": "string",
  "strengths": [{"aspect": "string", "detail": "string", "location": "string (optional)"}],
  "weaknesses": [{"aspect": "string", "detail": "string", "location": "string (optional)"}],
  "questions": ["string"],
  "missing_references": ["string"],
  "minor_issues": ["string"],
  "actionable_suggestions": ["string"]
}
Return ONLY the JSON object, no markdown fences or extra text.`

    const paperContent = truncate(paperText, MAX_PAPER_CHARS)

    const response = await chatCompletion({
      modelSpec: this.modelSpec,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Please review the following academic paper:\n\n${paperContent}${groundedContext}`,
        },
      ],
    })

    const rawText = response.text || '{}'

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>
    } catch {
      const match = rawText.match(/\{[\s\S]*\}/)
      if (match) {
        parsed = JSON.parse(match[0]) as Record<string, unknown>
      } else {
        parsed = {}
      }
    }

    const rawDims = (parsed.dimensions ?? {}) as Record<string, unknown>
    const dimensions: ReviewDimensions = {
      originality: clampScore(rawDims.originality),
      significance: clampScore(rawDims.significance),
      soundness: clampScore(rawDims.soundness),
      clarity: clampScore(rawDims.clarity),
      reproducibility: clampScore(rawDims.reproducibility),
      prior_work: clampScore(rawDims.prior_work),
      contribution: clampScore(rawDims.contribution),
    }

    const overall_score = computeWeightedScore(dimensions)
    const decision = scoreToDecision(overall_score)

    const rawConfidence = parsed.confidence
    const confidence = (
      typeof rawConfidence === 'number'
        ? Math.max(1, Math.min(5, Math.round(rawConfidence)))
        : 3
    ) as ReviewReport['confidence']

    return {
      reviewer_id: this.reviewerId,
      model_used: this.modelSpec,
      dimensions,
      overall_score: Math.round(overall_score * 100) / 100,
      decision,
      confidence,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      strengths: Array.isArray(parsed.strengths)
        ? (parsed.strengths as {
            aspect: string
            detail: string
            location?: string
          }[])
        : [],
      weaknesses: Array.isArray(parsed.weaknesses)
        ? (parsed.weaknesses as {
            aspect: string
            detail: string
            location?: string
          }[])
        : [],
      questions: Array.isArray(parsed.questions)
        ? (parsed.questions as string[])
        : [],
      missing_references: Array.isArray(parsed.missing_references)
        ? (parsed.missing_references as string[])
        : [],
      minor_issues: Array.isArray(parsed.minor_issues)
        ? (parsed.minor_issues as string[])
        : [],
      actionable_suggestions: Array.isArray(parsed.actionable_suggestions)
        ? (parsed.actionable_suggestions as string[])
        : [],
    }
  }

  /**
   * Two-stage review: rubric assessment + standard 7-dimension scoring.
   */
  async reviewWithRubric(
    paperText: string,
    rubric: Rubric,
    config: ReviewConfig,
  ): Promise<ReviewReport> {
    // Stage 1: Rubric assessment (separate LLM call)
    const rubricResult = await this.assessRubric(paperText, rubric)
    // Stage 2: Standard 7-dim review (existing)
    const report = await this.review(paperText, config)
    report.rubric_result = rubricResult
    return report
  }

  /**
   * Assess each rubric item against the paper as pass/partial/fail.
   */
  async assessRubric(
    paperText: string,
    rubric: Rubric,
  ): Promise<RubricReviewResult> {
    const itemsList = rubric.items
      .map(item => `${item.id}: ${item.statement}`)
      .join('\n')

    const systemPrompt = `You are an expert academic reviewer. Assess each rubric item against the paper. For each item, determine if the paper satisfies it:
- "pass": The paper fully satisfies this criterion
- "partial": The paper partially satisfies this criterion
- "fail": The paper does not satisfy this criterion

Return ONLY a JSON array of objects with fields: rubric_id, verdict ("pass"|"partial"|"fail"), justification (1-2 sentences), location (optional, e.g. "Section 3")
Example: [{"rubric_id": "R01", "verdict": "pass", "justification": "Theorem 1 includes a complete proof in Section 4.", "location": "Section 4"}]`

    const paperContent = truncate(paperText, MAX_PAPER_CHARS)

    const response = await chatCompletion({
      modelSpec: this.modelSpec,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `## Rubric Items\n${itemsList}\n\n## Paper\n${paperContent}`,
        },
      ],
    })

    const rawText = response.text || '[]'
    let parsed: Array<Record<string, unknown>>
    try {
      parsed = JSON.parse(rawText) as Array<Record<string, unknown>>
    } catch {
      const match = rawText.match(/\[[\s\S]*\]/)
      if (match) {
        parsed = JSON.parse(match[0]) as Array<Record<string, unknown>>
      } else {
        parsed = []
      }
    }

    if (!Array.isArray(parsed)) parsed = []

    const validVerdicts: RubricVerdict[] = ['pass', 'partial', 'fail']
    const assessments: RubricAssessment[] = parsed.map(raw => ({
      rubric_id: typeof raw.rubric_id === 'string' ? raw.rubric_id : '',
      verdict: validVerdicts.includes(raw.verdict as RubricVerdict)
        ? (raw.verdict as RubricVerdict)
        : 'partial',
      justification:
        typeof raw.justification === 'string' ? raw.justification : '',
      location: typeof raw.location === 'string' ? raw.location : undefined,
    }))

    // Ensure we have an assessment for each rubric item
    const assessedIds = new Set(assessments.map(a => a.rubric_id))
    for (const item of rubric.items) {
      if (!assessedIds.has(item.id)) {
        assessments.push({
          rubric_id: item.id,
          verdict: 'partial',
          justification: 'No assessment provided by reviewer.',
        })
      }
    }

    // Compute metrics
    const itemMap = new Map(rubric.items.map(item => [item.id, item]))
    let weightedScore = 0
    let totalWeight = 0
    let passCount = 0
    let partialCount = 0
    let failCount = 0

    for (const assessment of assessments) {
      const item = itemMap.get(assessment.rubric_id)
      const weight = item?.weight ?? 0
      totalWeight += weight

      if (assessment.verdict === 'pass') {
        weightedScore += weight
        passCount++
      } else if (assessment.verdict === 'partial') {
        weightedScore += weight * 0.5
        partialCount++
      } else {
        failCount++
      }
    }

    return {
      assessments,
      weighted_pass_rate: totalWeight > 0 ? weightedScore / totalWeight : 0,
      fail_count: failCount,
      partial_count: partialCount,
      pass_count: passCount,
    }
  }
}
