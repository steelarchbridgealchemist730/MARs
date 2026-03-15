import type {
  MetaReview,
  ReviewConfig,
  ReviewReport,
  Rubric,
  RubricAssignee,
  RubricSummary,
  RubricVerdict,
} from './types'
import { chatCompletion } from '../llm-client'

function computeAverageScore(reviews: ReviewReport[]): number {
  if (reviews.length === 0) return 0
  const sum = reviews.reduce((acc, r) => acc + r.overall_score, 0)
  return Math.round((sum / reviews.length) * 100) / 100
}

function averageToDecision(score: number): MetaReview['decision'] {
  if (score >= 8) return 'accept'
  if (score >= 6) return 'minor_revision'
  if (score >= 4) return 'major_revision'
  return 'reject'
}

function computeConsensus(
  reviews: ReviewReport[],
): MetaReview['consensus_level'] {
  if (reviews.length < 2) return 'high'
  const scores = reviews.map(r => r.overall_score)
  const max = Math.max(...scores)
  const min = Math.min(...scores)
  const spread = max - min
  if (spread <= 1.5) return 'high'
  if (spread <= 3) return 'medium'
  return 'low'
}

/** Verdict severity ordering: fail(2) > partial(1) > pass(0). */
const VERDICT_SEVERITY: Record<RubricVerdict, number> = {
  pass: 0,
  partial: 1,
  fail: 2,
}

function consensusVerdict(verdicts: RubricVerdict[]): RubricVerdict {
  if (verdicts.length === 0) return 'partial'

  const counts: Record<RubricVerdict, number> = { pass: 0, partial: 0, fail: 0 }
  for (const v of verdicts) counts[v]++

  // Majority wins
  const sorted: RubricVerdict[] = ['fail', 'partial', 'pass']
  for (const v of sorted) {
    if (counts[v] > verdicts.length / 2) return v
  }

  // No majority — pick worst (highest severity)
  let worst: RubricVerdict = 'pass'
  for (const v of verdicts) {
    if (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst]) worst = v
  }
  return worst
}

export class MetaReviewer {
  private modelName: string

  constructor(modelName: string) {
    this.modelName = modelName
  }

  async synthesize(
    reviews: ReviewReport[],
    config: ReviewConfig,
    rubric?: Rubric,
  ): Promise<MetaReview> {
    const average_score = computeAverageScore(reviews)
    const decision = averageToDecision(average_score)
    const consensus_level = computeConsensus(reviews)

    const reviewsSummary = reviews
      .map(
        (r, i) =>
          `Reviewer ${i + 1} (${r.reviewer_id}): Score=${r.overall_score}, Decision=${r.decision}\nSummary: ${r.summary}\nKey weaknesses: ${r.weaknesses.map(w => w.aspect).join(', ')}\nActionable suggestions: ${r.actionable_suggestions.join('; ')}`,
      )
      .join('\n\n---\n\n')

    const systemPrompt = `You are a senior area chair at a top ML/AI/Finance conference. Synthesize these reviewer reports into a meta-review. Identify the key issues by priority (critical/major/minor). For each issue, specify the action needed and which agent should handle it (math-reasoner for mathematical proofs/theorems, experiment-runner for experiments/code, writer for writing/clarity/structure, any for general issues). Return a JSON object with exactly this structure:
{
  "key_issues": [
    {
      "priority": "critical" | "major" | "minor",
      "description": "string",
      "action": "string",
      "assignee": "math-reasoner" | "experiment-runner" | "writer" | "any"
    }
  ]
}
Return ONLY the JSON object, no markdown fences or extra text.`

    const userContent = `Average score: ${average_score}\nDecision: ${decision}\nConsensus: ${consensus_level}\n\nReviewer reports:\n\n${reviewsSummary}\n\nPlease synthesize the key issues from these reviews.`

    const response = await chatCompletion({
      modelSpec: this.modelName,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
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

    const rawIssues = Array.isArray(parsed.key_issues) ? parsed.key_issues : []
    const key_issues = (rawIssues as Array<Record<string, unknown>>).map(
      issue => ({
        priority: (['critical', 'major', 'minor'].includes(
          issue.priority as string,
        )
          ? issue.priority
          : 'major') as 'critical' | 'major' | 'minor',
        description:
          typeof issue.description === 'string' ? issue.description : '',
        action: typeof issue.action === 'string' ? issue.action : '',
        assignee: ([
          'math-reasoner',
          'experiment-runner',
          'writer',
          'any',
        ].includes(issue.assignee as string)
          ? issue.assignee
          : 'any') as 'math-reasoner' | 'experiment-runner' | 'writer' | 'any',
      }),
    )

    // Aggregate rubric if provided and reviews have rubric results
    let rubric_summary: RubricSummary | undefined
    if (rubric && reviews.some(r => r.rubric_result)) {
      rubric_summary = this.aggregateRubric(rubric, reviews)
    }

    return {
      average_score,
      decision,
      consensus_level,
      key_issues,
      reviews,
      rubric_summary,
    }
  }

  /**
   * Aggregate rubric assessments across reviewers.
   * For each item: majority-vote consensus, ties break toward worse verdict.
   */
  private aggregateRubric(
    rubric: Rubric,
    reviews: ReviewReport[],
  ): RubricSummary {
    const aggregated: RubricSummary['aggregated'] = []
    const failed_items: RubricSummary['failed_items'] = []

    let passRateSum = 0
    let passRateCount = 0

    for (const review of reviews) {
      if (review.rubric_result) {
        passRateSum += review.rubric_result.weighted_pass_rate
        passRateCount++
      }
    }

    for (const item of rubric.items) {
      const verdicts: RubricVerdict[] = []
      for (const review of reviews) {
        if (!review.rubric_result) continue
        const assessment = review.rubric_result.assessments.find(
          a => a.rubric_id === item.id,
        )
        if (assessment) verdicts.push(assessment.verdict)
      }

      const consensus = consensusVerdict(verdicts)

      aggregated.push({
        rubric_id: item.id,
        statement: item.statement,
        verdicts,
        consensus_verdict: consensus,
        assignee: item.assignee,
        weight: item.weight,
      })

      if (consensus === 'fail') {
        // Collect justifications from reviewers who said fail
        const justifications: string[] = []
        for (const review of reviews) {
          const a = review.rubric_result?.assessments.find(
            x => x.rubric_id === item.id && x.verdict === 'fail',
          )
          if (a?.justification) justifications.push(a.justification)
        }

        failed_items.push({
          rubric_id: item.id,
          statement: item.statement,
          assignee: item.assignee,
          action:
            `Fix: ${item.statement}. ${justifications.length > 0 ? 'Reviewer notes: ' + justifications[0] : ''}`.trim(),
        })
      }
    }

    return {
      items: rubric.items,
      aggregated,
      overall_weighted_pass_rate:
        passRateCount > 0 ? passRateSum / passRateCount : 0,
      failed_items,
    }
  }
}
