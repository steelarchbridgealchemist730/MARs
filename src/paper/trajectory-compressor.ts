import type { TrajectoryEntry } from './research-state'
import { estimateTokens, truncate } from './claim-graph/token-utils'

export class TrajectoryCompressor {
  /**
   * Compress trajectory: last 3 entries full + earlier milestones only.
   * Works with current TrajectoryEntry shape (forward-compatible with Step 6).
   */
  compress(trajectory: TrajectoryEntry[], budgetTokens: number = 700): string {
    if (trajectory.length === 0) return '## Trajectory\nNo actions taken yet.'

    const parts: string[] = ['## Recent Actions']

    // Last 3 entries in full
    const recentCount = Math.min(3, trajectory.length)
    for (const t of trajectory.slice(-recentCount)) {
      let line: string
      if (t.builder_output_summary) {
        // Triple-role format
        line = `Cycle ${t.cycle ?? '?'}: ${truncate(t.builder_output_summary, 40)}`
        if (t.skeptic_challenges_summary) {
          line += `\n  Skeptic: ${truncate(t.skeptic_challenges_summary, 50)}`
        }
        if (t.outcome) {
          line += `\n  Result: ${truncate(t.outcome, 60)}`
        }
      } else {
        // Legacy format
        line = `[${t.agent}] ${t.action_type}: ${truncate(t.description, 60)}`
        if (t.outcome) {
          line += `\n  Result: ${truncate(t.outcome, 60)}`
        }
      }
      if (t.claim_graph_delta) {
        const d = t.claim_graph_delta
        line += `\n  Delta: +${d.claims_added} adm:${d.claims_admitted} dem:${d.claims_demoted} rej:${d.claims_rejected}`
      }
      parts.push(line)
    }

    // Earlier milestones
    const older = trajectory.slice(0, -recentCount)
    if (older.length > 0) {
      const milestones = older.filter(
        t =>
          (t.claim_graph_delta?.claims_admitted ?? 0) > 0 ||
          (t.claim_graph_delta?.claims_rejected ?? 0) > 0 ||
          t.action_type.toLowerCase().includes('experiment') ||
          t.action_type.toLowerCase().includes('proof') ||
          t.action_type === 'redesign_failure',
      )
      if (milestones.length > 0) {
        parts.push('\n### Earlier Milestones')
        let used = estimateTokens(parts.join('\n'))
        for (const m of milestones.slice(-5)) {
          const line = `  [${m.agent}] ${truncate(m.action_type, 30)} -> ${truncate(m.outcome ?? '', 40)}`
          if (used + estimateTokens(line) > budgetTokens * 0.9) break
          parts.push(line)
          used += estimateTokens(line)
        }
      }
      parts.push(
        `  (${older.length} earlier cycles; /view trajectory for full)`,
      )
    }

    return parts.join('\n')
  }
}
