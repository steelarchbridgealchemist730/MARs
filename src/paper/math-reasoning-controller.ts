import { randomUUID } from 'crypto'
import type { ProofBudgetDecision, TheoremSpec } from './proof-budget'
import type { AssumptionGap, ProofRecord } from './research-state'
import { chatCompletion } from './llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from './types'
import { extractModelId } from './agent-dispatch'

// ── Types ────────────────────────────────────────────────

export interface ProofContext {
  experiment_description: string
  data_characteristics: string[]
  existing_lemmas: { statement: string; id: string }[]
  known_results: { statement: string; source: string }[]
}

export interface ProofResult {
  proof: string // LaTeX proof text
  fragment_path: string | null
  assumptions: string[]
  gaps: AssumptionGap[]
  rounds_used: number
  rigor_achieved: ProofRecord['proof_status']
  record: ProofRecord
}

interface DeepeningEvaluation {
  yes: boolean
  instruction?: string
  reason: string
}

// ── MathReasoningController ──────────────────────────────

/**
 * Manages multi-turn interaction with a reasoning model for mathematical proofs.
 * Controls depth based on ProofBudgetDecision and experimental reality.
 */
export class MathReasoningController {
  private modelName: string
  private deepModelName: string

  constructor(modelName?: string, deepModelName?: string) {
    this.modelName =
      modelName ?? extractModelId(DEFAULT_MODEL_ASSIGNMENTS.reasoning)
    this.deepModelName =
      deepModelName ?? extractModelId(DEFAULT_MODEL_ASSIGNMENTS.reasoning_deep)
  }

  /**
   * Select the reasoning model based on proof complexity.
   * Uses reasoning_deep (gpt-5.4-pro) only for formal proofs with >= 4 rounds.
   * All other tasks use the standard reasoning model (gpt-5.4).
   */
  private selectModel(budget: ProofBudgetDecision): string {
    if (budget.target_rigor === 'formal' && budget.max_depth_rounds >= 4) {
      return this.deepModelName
    }
    return this.modelName
  }

  async prove(
    theorem: TheoremSpec,
    budget: ProofBudgetDecision,
    context: ProofContext,
  ): Promise<ProofResult> {
    const messages: { role: 'user' | 'assistant'; content: string }[] = []
    let round = 0

    // Build initial prompt with experimental reality context
    const initialPrompt = this.buildInitialPrompt(theorem, budget, context)
    messages.push({ role: 'user', content: initialPrompt })

    // Select model based on proof complexity — uses deep model for formal proofs
    const selectedModel = this.selectModel(budget)

    // Build the model spec — reasoning role may route to OpenAI
    const modelSpec = selectedModel.includes(':')
      ? selectedModel
      : selectedModel.includes('gpt') ||
          selectedModel.includes('o3') ||
          selectedModel.includes('o4')
        ? `openai:${selectedModel}`
        : `anthropic:${selectedModel}`

    let lastResponse = ''

    while (round < budget.max_depth_rounds) {
      // Call reasoning model via unified API
      const response = await chatCompletion({
        modelSpec,
        max_tokens: 16384,
        messages: messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      })

      lastResponse = response.text

      // Check if model is asking to go deeper
      const deepenRequest = this.detectDeepenRequest(lastResponse)

      if (!deepenRequest) break // model considers proof complete

      // Evaluate whether we should deepen
      const shouldDeepen = this.evaluateDeepening(deepenRequest, budget, round)

      if (shouldDeepen.yes && shouldDeepen.instruction) {
        messages.push({ role: 'assistant', content: lastResponse })
        messages.push({ role: 'user', content: shouldDeepen.instruction })
        round++
      } else {
        break
      }
    }

    // Extract proof, assumptions, and assess gaps
    const assumptions = this.extractAssumptions(lastResponse)
    const gaps = await this.assessAssumptionGaps(assumptions, context)
    const rigorAchieved = this.assessRigor(lastResponse, budget.target_rigor)

    const record: ProofRecord = {
      id: randomUUID(),
      theorem_statement: theorem.statement,
      proof_status: rigorAchieved,
      assumptions,
      rigor_level:
        rigorAchieved === 'rigorous' || rigorAchieved === 'verified'
          ? 'formal'
          : rigorAchieved === 'draft'
            ? 'semi_formal'
            : 'informal',
      fragment_path: null,
      assumption_reality_gaps: gaps,
    }

    return {
      proof: lastResponse,
      fragment_path: null,
      assumptions,
      gaps,
      rounds_used: round + 1,
      rigor_achieved: rigorAchieved,
      record,
    }
  }

  private buildInitialPrompt(
    theorem: TheoremSpec,
    budget: ProofBudgetDecision,
    context: ProofContext,
  ): string {
    const toleranceGuide = {
      strict:
        'Assumptions must closely match the experimental setup. No idealized assumptions.',
      reasonable:
        'Standard assumptions are fine, but note any significant gaps with reality.',
      pragmatic:
        'Use whatever assumptions make the proof tractable. We will note gaps separately.',
    }

    return `You are a mathematical proof assistant. Prove the following theorem.

## Theorem
${theorem.statement}

## Target Rigor: ${budget.target_rigor}
${budget.target_rigor === 'sketch' ? 'Provide a proof sketch with key steps outlined.' : ''}
${budget.target_rigor === 'semi_formal' ? 'Provide a semi-formal proof with all key arguments.' : ''}
${budget.target_rigor === 'formal' ? 'Provide a rigorous formal proof with all details.' : ''}

## Experimental Reality
Our experiments use: ${context.experiment_description}
Key data characteristics: ${context.data_characteristics.join(', ')}

## Assumption Guidance
${toleranceGuide[budget.assumption_tolerance]}

## Available Results
${context.existing_lemmas.length > 0 ? 'Existing lemmas you may cite:\n' + context.existing_lemmas.map(l => `- ${l.statement}`).join('\n') : 'No existing lemmas.'}

${context.known_results.length > 0 ? 'Known results from literature:\n' + context.known_results.map(r => `- ${r.statement} (${r.source})`).join('\n') : ''}

## Instructions
1. State all assumptions explicitly
2. Output LaTeX-formatted proof (theorem + proof environments)
3. If you need to go deeper on any step, say "DEEPEN: [aspect]" and I will decide
4. Mark any step where you use a non-trivial assumption with [ASSUMPTION: ...]`
  }

  private detectDeepenRequest(response: string): string | null {
    const match = response.match(/DEEPEN:\s*(.+?)(?:\n|$)/)
    return match ? match[1].trim() : null
  }

  private evaluateDeepening(
    request: string,
    budget: ProofBudgetDecision,
    round: number,
  ): DeepeningEvaluation {
    // Already at max rounds
    if (round >= budget.max_depth_rounds - 1) {
      return {
        yes: false,
        reason: `Max depth rounds (${budget.max_depth_rounds}) reached`,
      }
    }

    // Target rigor is sketch — don't deepen
    if (budget.target_rigor === 'sketch') {
      return {
        yes: false,
        reason: 'Target rigor is sketch — sufficient detail reached',
      }
    }

    // Cost check (spec §9.2): if next round would exceed total budget, stop
    // Estimate ~4K input + 4K output tokens per reasoning round
    // gpt-5.4-pro: $10/M in + $30/M out = ~$0.16/round
    // claude-opus: $15/M in + $75/M out = ~$0.36/round
    // Use conservative upper bound of $0.50 per round to avoid underestimation
    const cost_per_round = 0.5
    const cost_so_far = (round + 1) * cost_per_round
    if (cost_so_far + cost_per_round > budget.estimated_cost_usd) {
      return {
        yes: false,
        reason: `Cost limit reached: next round would cost ~$${(cost_so_far + cost_per_round).toFixed(2)}, exceeding budget of $${budget.estimated_cost_usd.toFixed(2)}`,
      }
    }

    // Semi-formal rigor check (spec §9.2): past round 2 is enough for semi_formal
    if (budget.target_rigor === 'semi_formal' && round >= 2) {
      return {
        yes: false,
        reason:
          'Target rigor is semi_formal and round 2+ reached — sufficient depth',
      }
    }

    // Budget allows, continue
    return {
      yes: true,
      instruction: `Please elaborate on: ${request}\n\nRemember to maintain the ${budget.assumption_tolerance} assumption tolerance level.`,
      reason: `Deepening requested and budget allows (round ${round + 1}/${budget.max_depth_rounds})`,
    }
  }

  private extractAssumptions(proofText: string): string[] {
    const assumptions: string[] = []

    // Look for explicit [ASSUMPTION: ...] markers
    const matches = proofText.matchAll(/\[ASSUMPTION:\s*(.+?)\]/g)
    for (const match of matches) {
      assumptions.push(match[1].trim())
    }

    // Also look for "assume" or "assumption" in text
    const lines = proofText.split('\n')
    for (const line of lines) {
      if (
        /\\textbf\{Assumption|\\begin\{assumption\}|We\s+assume/i.test(line)
      ) {
        const cleaned = line
          .replace(
            /\\textbf\{|\\begin\{assumption\}|\}|\\end\{assumption\}/g,
            '',
          )
          .trim()
        if (cleaned.length > 10 && !assumptions.includes(cleaned)) {
          assumptions.push(cleaned)
        }
      }
    }

    return assumptions
  }

  async assessAssumptionGaps(
    assumptions: string[],
    context: ProofContext,
  ): Promise<AssumptionGap[]> {
    if (assumptions.length === 0 || context.data_characteristics.length === 0) {
      return []
    }

    const prompt = `You are a mathematical reasoning assistant. Assess gaps between theoretical assumptions and experimental reality.

ASSUMPTIONS made in the proof:
${assumptions.map((a, i) => `${i + 1}. ${a}`).join('\n')}

DATA CHARACTERISTICS observed:
${context.data_characteristics.map((c, i) => `${i + 1}. ${c}`).join('\n')}

For each assumption, determine if the data characteristics contradict or weaken it.
Return a JSON array of gaps found. Each gap object has:
- "assumption": the assumption text (exact match from list above)
- "experimental_reality": which data characteristics conflict and why
- "gap_severity": one of "negligible", "minor", "significant", "critical"

Only include gaps where severity is NOT "negligible". Return [] if no meaningful gaps.
Return ONLY the JSON array, no other text.`

    try {
      const response = await chatCompletion({
        modelSpec: DEFAULT_MODEL_ASSIGNMENTS.quick,
        system:
          'You are a mathematical reasoning assistant. Return only valid JSON.',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0,
      })

      const text = response.text.trim()
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return []

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        assumption: string
        experimental_reality: string
        gap_severity: string
      }>

      const validSeverities = ['negligible', 'minor', 'significant', 'critical']
      return parsed
        .filter(
          g =>
            g.assumption &&
            g.experimental_reality &&
            validSeverities.includes(g.gap_severity) &&
            g.gap_severity !== 'negligible',
        )
        .map(g => ({
          assumption: g.assumption,
          experimental_reality: g.experimental_reality,
          gap_severity: g.gap_severity as AssumptionGap['gap_severity'],
        }))
    } catch (err: any) {
      // Fallback: return empty — no gaps detected is safer than wrong gaps
      // Log for debugging since gap detection failure may mask assumption issues
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(
          `[math-reasoning] Gap assessment failed: ${err.message ?? err}\n`,
        )
      }
      return []
    }
  }

  private assessRigor(
    proofText: string,
    targetRigor: string,
  ): ProofRecord['proof_status'] {
    const hasProofEnv =
      proofText.includes('\\begin{proof}') ||
      proofText.includes('\\begin{theorem}')
    const hasQED =
      proofText.includes('\\qed') ||
      proofText.includes('Q.E.D') ||
      proofText.includes('\\blacksquare')
    const length = proofText.length

    // Structural indicators of rigor beyond just LaTeX environments
    const hasStepwise =
      /(?:step\s*\d|case\s*\d|(?:first|second|third),?\s*(?:we|note|consider))/i.test(
        proofText,
      )
    const hasQuantifiers =
      /(?:\\forall|\\exists|for\s+all|there\s+exists|for\s+every|for\s+any)/i.test(
        proofText,
      )
    const hasCitations =
      /\\cite\{[^}]+\}/.test(proofText) ||
      /(?:by|from)\s+(?:Theorem|Lemma|Proposition|Corollary)\s+\d/i.test(
        proofText,
      )
    const hasAssumptions =
      /(?:\\text\{assume\}|WLOG|without loss of generality|suppose|let\s+\$|assume\s+that)/i.test(
        proofText,
      )
    const hasMathEnvs = /\\begin\{(?:align|equation|gather|cases)\*?\}/.test(
      proofText,
    )

    // Score structural completeness
    const rigorScore =
      (hasProofEnv ? 1 : 0) +
      (hasQED ? 1 : 0) +
      (hasStepwise ? 1 : 0) +
      (hasQuantifiers ? 0.5 : 0) +
      (hasCitations ? 0.5 : 0) +
      (hasAssumptions ? 0.5 : 0) +
      (hasMathEnvs ? 0.5 : 0) +
      (length > 2000 ? 1 : length > 800 ? 0.5 : 0)

    if (targetRigor === 'sketch') {
      return rigorScore >= 2 ? 'draft' : 'sketch'
    }

    if (targetRigor === 'formal') {
      if (rigorScore >= 4.5) return 'rigorous'
      if (rigorScore >= 3) return 'draft'
      return 'sketch'
    }

    // semi_formal
    if (rigorScore >= 3.5) return 'rigorous'
    if (rigorScore >= 2) return 'draft'
    return 'sketch'
  }
}
