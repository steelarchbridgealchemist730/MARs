import type { ResearchPlan, DeepResearchOptions } from './types'
import { chatCompletion } from '../llm-client'

const SYSTEM_PROMPT = `You are an expert research planner. Decompose the given research topic into 3-5 research dimensions, each with precise queries (specific technical terms), broad queries (domain-level), and cross-domain queries (interdisciplinary). Also identify 3-5 key authors and venues in this field.

You must respond with ONLY a valid JSON object matching this structure:
{
  "dimensions": [
    {
      "name": "string",
      "queries": {
        "precise": ["string"],
        "broad": ["string"],
        "cross_domain": ["string"]
      }
    }
  ],
  "key_authors": ["string"],
  "key_venues": ["string"],
  "completion_criteria": "string"
}`

export class ResearchPlanner {
  private modelName: string

  constructor(modelName: string) {
    this.modelName = modelName
  }

  async plan(
    topic: string,
    options: DeepResearchOptions,
  ): Promise<ResearchPlan> {
    const sinceYear = options.since_year ?? 2019
    const userMessage = `Research topic: ${topic}. Since year: ${sinceYear}.`

    const response = await chatCompletion({
      modelSpec: this.modelName,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })

    const rawText = response.text

    // Extract JSON from the response (handle markdown code blocks)
    let jsonStr = rawText.trim()
    const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonBlockMatch) {
      jsonStr = jsonBlockMatch[1].trim()
    } else {
      // Try to find first { ... } block
      const firstBrace = jsonStr.indexOf('{')
      const lastBrace = jsonStr.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace !== -1) {
        jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
      }
    }

    let parsed: Omit<ResearchPlan, 'topic' | 'created_at'>
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      throw new Error(
        `Failed to parse research plan JSON: ${jsonStr.slice(0, 200)}`,
      )
    }

    const plan: ResearchPlan = {
      topic,
      dimensions: parsed.dimensions ?? [],
      key_authors: parsed.key_authors ?? [],
      key_venues: parsed.key_venues ?? [],
      completion_criteria: parsed.completion_criteria ?? '',
      created_at: new Date().toISOString(),
    }

    return plan
  }
}
