import type { EvidencePoolManager } from './evidence-pool'
import { estimateTokens, truncate } from './claim-graph/token-utils'

export class EvidencePoolCompressor {
  /**
   * Compress evidence pool: stats + contradictions + focus-relevant evidence.
   */
  compress(
    pool: EvidencePoolManager,
    focusClaimIds: string[],
    budgetTokens: number = 800,
  ): string {
    const parts: string[] = []
    let used = 0

    // Stats (always)
    const s = pool.summary()
    const statsLine = `Evidence: ${s.total_grounded}G(${s.verified_grounded} verified) ${s.total_derived}D(${s.reproducible_derived} reproducible)`
    parts.push(statsLine)
    used += estimateTokens(statsLine)

    // Contradictions (always, up to 3)
    const allEvidence = [...pool.pool.grounded, ...pool.pool.derived]
    const contradicting = allEvidence.filter(
      e => e.contradicts_claims.length > 0,
    )
    if (contradicting.length > 0) {
      parts.push('Contradictory:')
      for (const e of contradicting.slice(0, 3)) {
        const line = `  "${truncate(e.claim, 50)}" contradicts [${e.contradicts_claims.join(',')}]`
        parts.push(line)
        used += estimateTokens(line)
      }
    }

    // Focus-relevant evidence
    parts.push('Relevant evidence:')
    for (const claimId of focusClaimIds) {
      if (used > budgetTokens * 0.8) {
        parts.push('  (truncated; more evidence available in state)')
        break
      }
      const ev = pool.evidenceFor(claimId)
      const samples = [...ev.grounded.slice(0, 1), ...ev.derived.slice(0, 1)]
      for (const e of samples) {
        const type = 'source_type' in e ? 'G' : 'D'
        const line = `  [${type}] "${truncate(e.claim, 45)}" -> [${claimId}]`
        parts.push(line)
        used += estimateTokens(line)
      }
    }

    return parts.join('\n')
  }
}
