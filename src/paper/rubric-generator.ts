import { chatCompletion } from './llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from './types'
import type { ResearchState } from './research-state'
import { ClaimGraph } from './claim-graph/index'
import type {
  Rubric,
  RubricItem,
  RubricCategory,
  RubricAssignee,
} from './review/types'

const VALID_CATEGORIES: RubricCategory[] = [
  'claim_support',
  'methodology',
  'reproducibility',
  'novelty',
  'clarity',
  'completeness',
  'consistency',
  'rigor',
]

const VALID_ASSIGNEES: RubricAssignee[] = [
  'math-reasoner',
  'experiment-runner',
  'writer',
  'any',
]

/** Pattern for proper-name "and" (e.g. "Johnson and Williams"). */
const NAME_AND_PATTERN = /[A-Z]\w+ and [A-Z]\w+/

/** Conjunction patterns that make a statement non-atomic. */
const CONJUNCTION_PATTERN = /\b(both|as well as|along with)\b/i

const BARE_AND_PATTERN = /\band\b/i

export class RubricGenerator {
  private modelSpec: string

  constructor(modelSpec?: string) {
    this.modelSpec = modelSpec ?? DEFAULT_MODEL_ASSIGNMENTS.research
  }

  /**
   * LLM generates 15-25 atomic rubric items from the research state.
   */
  async generate(state: ResearchState): Promise<Rubric> {
    const context = this.buildContext(state)

    const systemPrompt = `You are a rubric designer for academic peer review. Generate 15-25 atomic rubric items for reviewing a research paper.

RULES:
- Each item tests EXACTLY ONE thing. No "and", "both", "as well as", "along with".
- Each item is a yes/no verifiable statement about the paper.
- Weights must be positive numbers. More important items get higher weight.
- For each item, specify the category and which agent would fix it if it fails.
- Reference specific claims where possible using their IDs.
- For theoretical papers: more rigor/proof items. For empirical: more reproducibility/methodology.

Categories: claim_support, methodology, reproducibility, novelty, clarity, completeness, consistency, rigor
Assignees: math-reasoner (proofs, theorems, derivations), experiment-runner (experiments, code, data), writer (text, structure, clarity), any (general)

Return ONLY a JSON array of objects with fields: statement, category, weight, claim_id (optional), assignee
Example: [{"statement": "Theorem 1 has a complete proof", "category": "rigor", "weight": 0.06, "claim_id": "c-abc123", "assignee": "math-reasoner"}]`

    const response = await chatCompletion({
      modelSpec: this.modelSpec,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: context }],
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

    // Clamp to 15-25 items
    if (parsed.length > 25) parsed = parsed.slice(0, 25)

    // Build items with IDs
    const items: RubricItem[] = parsed.map((raw, i) => ({
      id: `R${String(i + 1).padStart(2, '0')}`,
      statement: typeof raw.statement === 'string' ? raw.statement : '',
      category: VALID_CATEGORIES.includes(raw.category as RubricCategory)
        ? (raw.category as RubricCategory)
        : 'completeness',
      weight: typeof raw.weight === 'number' && raw.weight > 0 ? raw.weight : 1,
      claim_id: typeof raw.claim_id === 'string' ? raw.claim_id : undefined,
      assignee: VALID_ASSIGNEES.includes(raw.assignee as RubricAssignee)
        ? (raw.assignee as RubricAssignee)
        : 'any',
    }))

    // Pad to 15 if too few
    while (items.length < 15) {
      const idx = items.length
      items.push({
        id: `R${String(idx + 1).padStart(2, '0')}`,
        statement: this.genericRubricStatement(idx),
        category: VALID_CATEGORIES[idx % VALID_CATEGORIES.length],
        weight: 1,
        assignee: 'any',
      })
    }

    // Normalize weights to sum to 1.0
    const weightSum = items.reduce((sum, item) => sum + item.weight, 0)
    if (weightSum > 0) {
      for (const item of items) {
        item.weight = item.weight / weightSum
      }
    }

    return {
      items,
      generated_at: new Date().toISOString(),
      paper_type: state.paper_type ?? 'mixed',
      proposal_title: state.proposal?.title ?? 'Unknown',
    }
  }

  /**
   * Validate a rubric: 15-25 items, weights sum to ~1.0, all atomic, valid categories/assignees.
   * Throws if invalid.
   */
  static validate(rubric: Rubric): Rubric {
    if (rubric.items.length < 15) {
      throw new Error(`Rubric has ${rubric.items.length} items, minimum is 15`)
    }
    if (rubric.items.length > 25) {
      throw new Error(`Rubric has ${rubric.items.length} items, maximum is 25`)
    }

    const weightSum = rubric.items.reduce((sum, item) => sum + item.weight, 0)
    if (Math.abs(weightSum - 1.0) > 0.01) {
      throw new Error(
        `Rubric weights sum to ${weightSum.toFixed(4)}, expected ~1.0`,
      )
    }

    for (const item of rubric.items) {
      if (!VALID_CATEGORIES.includes(item.category)) {
        throw new Error(
          `Invalid rubric category "${item.category}" on item ${item.id}`,
        )
      }
      if (!VALID_ASSIGNEES.includes(item.assignee)) {
        throw new Error(
          `Invalid rubric assignee "${item.assignee}" on item ${item.id}`,
        )
      }
    }

    return rubric
  }

  /**
   * Check if a statement is atomic (no conjunctions like 'and', 'both', 'as well as').
   * Allows "and" between capitalized words (proper-name pattern).
   */
  static isAtomic(statement: string): boolean {
    // Check for "both", "as well as", "along with" — always non-atomic
    if (CONJUNCTION_PATTERN.test(statement)) return false

    // Check for "and" — non-atomic unless it's a proper-name pattern
    if (BARE_AND_PATTERN.test(statement)) {
      // If all occurrences of "and" are in proper-name contexts, it's still atomic
      const withoutNames = statement.replace(NAME_AND_PATTERN, '')
      if (BARE_AND_PATTERN.test(withoutNames)) return false
    }

    return true
  }

  private buildContext(state: ResearchState): string {
    const parts: string[] = []

    if (state.proposal) {
      parts.push(
        `## Proposal\nTitle: ${state.proposal.title}\nAbstract: ${state.proposal.abstract ?? 'N/A'}\nMethodology: ${state.proposal.methodology ?? 'N/A'}`,
      )
      if (
        state.proposal.innovation &&
        Array.isArray(state.proposal.innovation)
      ) {
        parts.push(
          'Innovations:\n' +
            state.proposal.innovation
              .map((inn: string) => `- ${inn}`)
              .join('\n'),
        )
      }
    }

    parts.push(`Paper type: ${state.paper_type ?? 'mixed'}`)

    // Claims from graph
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const admitted = graph.getClaimsByPhase('admitted')
    const proposed = graph.getClaimsByPhase('proposed')
    const investigating = graph.getClaimsByPhase('under_investigation')

    if (admitted.length > 0) {
      parts.push(
        '## Admitted Claims (paper backbone)\n' +
          admitted
            .slice(0, 15)
            .map(
              c =>
                `- [${c.id}] (${c.type}/${c.epistemicLayer}) ${c.statement} [conf:${c.strength.confidence.toFixed(2)}]`,
            )
            .join('\n'),
      )
    }

    if (proposed.length > 0 || investigating.length > 0) {
      const open = [...proposed, ...investigating]
      parts.push(
        '## Open Claims\n' +
          open
            .slice(0, 10)
            .map(c => `- [${c.id}] (${c.type}) ${c.statement}`)
            .join('\n'),
      )
    }

    // Evidence summary
    const pool = state.evidencePool
    const groundedCount = pool.grounded?.length ?? 0
    const derivedCount = pool.derived?.length ?? 0
    parts.push(
      `## Evidence\nGrounded: ${groundedCount}, Derived: ${derivedCount}`,
    )

    // Theory state
    if (state.theory?.proofs?.length > 0) {
      parts.push(
        '## Proofs\n' +
          state.theory.proofs
            .slice(0, 10)
            .map(p => `- ${p.theorem_statement}: ${p.proof_status}`)
            .join('\n'),
      )
    }

    return parts.join('\n\n')
  }

  private genericRubricStatement(index: number): string {
    const generics = [
      'The paper states its contributions clearly',
      'The abstract accurately summarizes the paper content',
      'The methodology section describes all steps',
      'All figures have descriptive captions',
      'All tables include units where applicable',
      'The related work section covers key prior art',
      'The conclusion follows from the presented evidence',
      'Mathematical notation is defined before use',
      'Experimental setup is described in sufficient detail',
      'Limitations of the approach are discussed',
      'The paper is written in clear academic English',
      'References are complete with publication venues',
      'The introduction motivates the research question',
      'Key assumptions are explicitly stated',
      'Results are compared against appropriate baselines',
    ]
    return generics[index % generics.length]
  }
}
