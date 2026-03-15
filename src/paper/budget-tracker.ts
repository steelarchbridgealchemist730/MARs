// Budget tracker with per-category breakdown, warning thresholds, and enforcement.
// Integrates with ResearchState.budget for orchestrator decision-making.

export type BudgetCategory =
  | 'orchestrator'
  | 'deep_research'
  | 'experiment'
  | 'proof'
  | 'review'
  | 'writing'
  | 'investigation'
  | 'failed'
  | 'other'

interface UsageEntry {
  timestamp: string
  category: BudgetCategory
  model: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
}

interface BudgetBreakdown {
  category: BudgetCategory
  spent_usd: number
  call_count: number
}

export class BudgetTracker {
  private totalCost = 0
  private limitUSD?: number
  private warnAtPercent: number
  private entries: UsageEntry[] = []
  private breakdownMap = new Map<
    BudgetCategory,
    { spent: number; calls: number }
  >()
  private warningEmitted = false
  private onWarning?: (message: string) => void

  constructor(options?: {
    limitUSD?: number
    warnAtPercent?: number
    onWarning?: (message: string) => void
  }) {
    this.limitUSD = options?.limitUSD
    this.warnAtPercent = options?.warnAtPercent ?? 20
    this.onWarning = options?.onWarning
  }

  // Model pricing (approximate, as of 2025)
  private static readonly RATES: Record<
    string,
    { input: number; output: number }
  > = {
    opus: { input: 15, output: 75 },
    sonnet: { input: 3, output: 15 },
    haiku: { input: 0.8, output: 4 },
    'gpt-5': { input: 10, output: 30 },
    'gpt-4': { input: 10, output: 30 },
    o3: { input: 10, output: 30 },
    default: { input: 3, output: 15 },
  }

  private getRates(model: string): { input: number; output: number } {
    const lower = model.toLowerCase()
    if (lower.includes('opus')) return BudgetTracker.RATES.opus!
    if (lower.includes('haiku')) return BudgetTracker.RATES.haiku!
    if (lower.includes('sonnet')) return BudgetTracker.RATES.sonnet!
    if (lower.includes('gpt-5') || lower.includes('gpt-4'))
      return BudgetTracker.RATES['gpt-5']!
    if (lower.includes('o3')) return BudgetTracker.RATES.o3!
    return BudgetTracker.RATES.default!
  }

  trackUsage(
    inputTokens: number,
    outputTokens: number,
    model: string,
    category: BudgetCategory = 'other',
  ): number {
    const rates = this.getRates(model)
    const cost =
      (inputTokens / 1_000_000) * rates.input +
      (outputTokens / 1_000_000) * rates.output

    this.totalCost += cost

    // Record entry
    this.entries.push({
      timestamp: new Date().toISOString(),
      category,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
    })

    // Update breakdown
    const existing = this.breakdownMap.get(category) ?? { spent: 0, calls: 0 }
    this.breakdownMap.set(category, {
      spent: existing.spent + cost,
      calls: existing.calls + 1,
    })

    // Check warning threshold
    this.checkWarning()

    return cost
  }

  /** Record a known cost without token details (e.g., from a SubAgent) */
  recordCost(cost_usd: number, category: BudgetCategory = 'other'): void {
    this.totalCost += cost_usd

    this.entries.push({
      timestamp: new Date().toISOString(),
      category,
      model: 'external',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd,
    })

    const existing = this.breakdownMap.get(category) ?? { spent: 0, calls: 0 }
    this.breakdownMap.set(category, {
      spent: existing.spent + cost_usd,
      calls: existing.calls + 1,
    })

    this.checkWarning()
  }

  private checkWarning(): void {
    if (!this.limitUSD || this.warningEmitted) return

    const pctRemaining =
      ((this.limitUSD - this.totalCost) / this.limitUSD) * 100

    if (pctRemaining <= this.warnAtPercent) {
      this.warningEmitted = true
      const msg = `Budget warning: $${this.totalCost.toFixed(2)} spent of $${this.limitUSD} limit (${pctRemaining.toFixed(1)}% remaining)`
      this.onWarning?.(msg)
    }
  }

  isOverBudget(): boolean {
    return this.limitUSD !== undefined && this.totalCost > this.limitUSD
  }

  /** Check if a proposed cost would exceed the budget */
  wouldExceedBudget(proposedCostUsd: number): boolean {
    if (this.limitUSD === undefined) return false
    return this.totalCost + proposedCostUsd > this.limitUSD
  }

  /** Get remaining budget in USD. Returns Infinity if no limit set. */
  getRemaining(): number {
    if (this.limitUSD === undefined) return Infinity
    return Math.max(0, this.limitUSD - this.totalCost)
  }

  /** Get percentage of budget remaining (0-100). Returns 100 if no limit. */
  getRemainingPercent(): number {
    if (this.limitUSD === undefined) return 100
    return Math.max(0, ((this.limitUSD - this.totalCost) / this.limitUSD) * 100)
  }

  getTotal(): number {
    return this.totalCost
  }

  getLimit(): number | undefined {
    return this.limitUSD
  }

  getBreakdown(): BudgetBreakdown[] {
    const result: BudgetBreakdown[] = []
    for (const [category, data] of this.breakdownMap) {
      result.push({
        category,
        spent_usd: data.spent,
        call_count: data.calls,
      })
    }
    // Sort by spend descending
    result.sort((a, b) => b.spent_usd - a.spent_usd)
    return result
  }

  /** Get total token usage across all entries */
  getTotalTokens(): { input: number; output: number } {
    let input = 0
    let output = 0
    for (const e of this.entries) {
      input += e.input_tokens
      output += e.output_tokens
    }
    return { input, output }
  }

  /** Export breakdown in the format expected by ResearchState.budget */
  toStateBudget(): {
    total_usd: number
    spent_usd: number
    remaining_usd: number
    warn_at_percent: number
    breakdown: { category: string; spent_usd: number }[]
  } {
    return {
      total_usd: this.limitUSD ?? 0,
      spent_usd: this.totalCost,
      remaining_usd: this.getRemaining() === Infinity ? 0 : this.getRemaining(),
      warn_at_percent: this.warnAtPercent,
      breakdown: this.getBreakdown().map(b => ({
        category: b.category,
        spent_usd: b.spent_usd,
      })),
    }
  }

  formatSummary(): string {
    const lines: string[] = []
    const tokens = this.getTotalTokens()

    if (this.limitUSD) {
      const pct = this.getRemainingPercent()
      lines.push(
        `Budget: $${this.totalCost.toFixed(2)} / $${this.limitUSD} (${pct.toFixed(1)}% remaining)`,
      )
    } else {
      lines.push(`API Cost: $${this.totalCost.toFixed(2)}`)
    }

    lines.push(
      `Tokens: ${(tokens.input / 1000).toFixed(1)}K input, ${(tokens.output / 1000).toFixed(1)}K output`,
    )

    const breakdown = this.getBreakdown()
    if (breakdown.length > 0) {
      lines.push('Breakdown:')
      for (const b of breakdown) {
        lines.push(
          `  ${b.category}: $${b.spent_usd.toFixed(2)} (${b.call_count} calls)`,
        )
      }
    }

    return lines.join('\n')
  }
}
