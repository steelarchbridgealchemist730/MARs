import { readFileSync } from 'fs'
import { join } from 'path'
import type { Proposal, ProposalGenerationOptions } from './types'
import { chatCompletion } from '../llm-client'

const MAX_CONTENT_CHARS = 40000

function proposalScore(p: Proposal): number {
  return (
    p.novelty_score * 0.3 + p.feasibility.score * 0.5 + p.impact_score * 0.2
  )
}

function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n... (truncated)'
}

export class ProposalGenerator {
  private modelName: string

  constructor(modelName: string) {
    this.modelName = modelName
  }

  async generate(options: ProposalGenerationOptions): Promise<Proposal[]> {
    const count = options.count ?? 3
    const researchDir = options.research_dir ?? ''

    let gapsContent = ''
    let surveyContent = ''

    if (researchDir) {
      const litDir = join(researchDir, 'literature')
      gapsContent = readFileSafe(join(litDir, 'gaps.md'))
      surveyContent = readFileSafe(join(litDir, 'survey.md'))
    }

    const combinedContent = truncate(
      [
        surveyContent ? `## Literature Survey\n\n${surveyContent}` : '',
        gapsContent ? `## Research Gaps\n\n${gapsContent}` : '',
      ]
        .filter(Boolean)
        .join('\n\n---\n\n'),
      MAX_CONTENT_CHARS,
    )

    const focusClause = options.focus
      ? ` Focus specifically on the direction: "${options.focus}".`
      : ''

    const feasibilityClause =
      options.include_feasibility !== false
        ? ' Include detailed feasibility assessments with data requirements, compute estimates, and timeline.'
        : ''

    const riskClause =
      options.include_risk !== false
        ? ' Include risk assessments for each proposal.'
        : ''

    const systemPrompt = `You are an expert research proposal generator. Generate ${count} distinct, novel research proposals based on the provided literature review. Each proposal must be highly specific, technically sound, and address a real research gap.${focusClause}${feasibilityClause}${riskClause} Return a JSON array of proposal objects with exactly this structure:
[
  {
    "title": "string",
    "abstract": "string",
    "innovation": ["string", ...],
    "methodology": "string",
    "feasibility": {
      "data_required": "string",
      "compute_estimate": "string",
      "timeline_weeks": number,
      "score": number (0-1)
    },
    "risk": {
      "level": "low" | "medium" | "high",
      "description": "string"
    },
    "novelty_score": number (0-1),
    "impact_score": number (0-1),
    "references": ["string", ...]
  }
]
Return ONLY the JSON array, no markdown fences or extra text.`

    const userContent = combinedContent
      ? `Generate ${count} research proposals based on the following literature review and research gaps:\n\n${combinedContent}`
      : `Generate ${count} novel research proposals in a scientifically rigorous domain. Since no literature review is available, choose a well-defined research area and identify real gaps to address.`

    const response = await chatCompletion({
      modelSpec: this.modelName,
      max_tokens: 8096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    })

    const rawText = response.text || '[]'

    let parsed: Partial<Proposal>[]
    try {
      parsed = JSON.parse(rawText) as Partial<Proposal>[]
    } catch {
      // Attempt to extract JSON array from text if LLM added surrounding prose
      const match = rawText.match(/\[[\s\S]*\]/)
      if (match) {
        parsed = JSON.parse(match[0]) as Partial<Proposal>[]
      } else {
        parsed = []
      }
    }

    const now = new Date().toISOString()

    const proposals: Proposal[] = parsed.map((raw, index) => ({
      id: `${Date.now()}-${index}`,
      title: raw.title ?? `Proposal ${index + 1}`,
      abstract: raw.abstract ?? '',
      innovation: raw.innovation ?? [],
      methodology: raw.methodology ?? '',
      feasibility: {
        data_required: raw.feasibility?.data_required ?? '',
        compute_estimate: raw.feasibility?.compute_estimate ?? '',
        timeline_weeks: raw.feasibility?.timeline_weeks ?? 12,
        score: raw.feasibility?.score ?? 0.5,
      },
      risk: {
        level: raw.risk?.level ?? 'medium',
        description: raw.risk?.description ?? '',
      },
      novelty_score: raw.novelty_score ?? 0.5,
      impact_score: raw.impact_score ?? 0.5,
      references: raw.references ?? [],
      created_at: now,
    }))

    return proposals.sort((a, b) => proposalScore(b) - proposalScore(a))
  }
}
