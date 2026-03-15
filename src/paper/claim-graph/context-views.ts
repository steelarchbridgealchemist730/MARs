import type { ClaimGraph } from './index'
import type { Claim } from './types'
import type { EvidencePoolManager } from '../evidence-pool'
import type { StabilityMetrics } from '../research-state'
import { estimateTokens, truncate } from './token-utils'

/**
 * L0: Statistical bird's-eye view. ~300 tokens. Always included.
 */
export function buildL0(
  graph: ClaimGraph,
  pool: EvidencePoolManager,
  stability: StabilityMetrics,
): string {
  const stats = graph.getStatistics()
  const s = pool.summary()
  return `## Claim Graph Overview
Claims: ${stats.total} (admitted:${stats.admitted} proposed:${stats.proposed} investigating:${stats.investigating} demoted:${stats.demoted} reform:${stats.reformulated})
Layers: obs:${stats.observations} expl:${stats.explanations} expt:${stats.exploitations} just:${stats.justifications}
Edges: ${stats.totalEdges} (depends:${stats.dependsOn} supports:${stats.supports} contradicts:${stats.contradicts})
Evidence: ${s.total_grounded} grounded, ${s.total_derived} derived | Coverage: ${(stability.evidenceCoverage * 100).toFixed(0)}%
Convergence: ${stability.convergenceScore.toFixed(2)} | Readiness: ${stability.paperReadiness}
Weakest bridge: ${stability.weakestBridge?.claimId ?? 'none'} (vuln: ${stability.weakestBridge?.vulnerability.toFixed(2) ?? 'n/a'})`
}

/**
 * L1: Key claims. ~1500 tokens. Always included.
 * Shows admitted claims, top-3 weakest bridges, recently changed, contradictions.
 */
export function buildL1(graph: ClaimGraph): string {
  const sections: string[] = ['## Key Claims']

  // Admitted (paper backbone)
  const admitted = graph.getClaimsByPhase('admitted')
  if (admitted.length > 0) {
    sections.push('\n### Admitted (paper backbone)')
    for (const c of admitted) {
      const tag = c.is_main ? ' [MAIN]' : ''
      sections.push(
        `- [${c.epistemicLayer}/${c.type}]${tag} "${truncate(c.statement, 80)}" conf:${c.strength.confidence.toFixed(2)} [${c.id}]`,
      )
    }
  }

  // Top-3 weakest bridges
  const bridges = graph.findWeakestBridges().slice(0, 3)
  if (bridges.length > 0) {
    sections.push('\n### Weakest Bridges')
    for (const b of bridges) {
      sections.push(
        `- "${truncate(b.claim.statement, 60)}" vuln:${b.vulnerability.toFixed(2)} cascade:${b.cascadeSize} [${b.claim.id}]`,
      )
    }
  }

  // Recently changed (last 2 hours)
  const recent = graph.getRecentlyChanged(2)
  if (recent.length > 0) {
    sections.push('\n### Recently Changed')
    for (const r of recent) {
      sections.push(
        `- ${r.change}: "${truncate(r.claim.statement, 60)}" [${r.claim.id}]`,
      )
    }
  }

  // Reformulated claims (superseded with successor links)
  const reformulated = graph.getClaimsByPhase('reformulated')
  if (reformulated.length > 0) {
    sections.push('\n### Reformulated')
    for (const c of reformulated) {
      const successorNote = c.reformulated_into
        ? ` -> successor: [${c.reformulated_into}]`
        : ''
      sections.push(
        `- "${truncate(c.statement, 60)}" [${c.id}]${successorNote}`,
      )
    }
  }

  // Contradictions
  const contradictions = graph.findContradictions()
  if (contradictions.length > 0) {
    sections.push('\n### Contradictions')
    for (const c of contradictions) {
      sections.push(
        `- "${truncate(c.claim.statement, 40)}" has conflicting evidence`,
      )
    }
  }

  return sections.join('\n')
}

/**
 * L2: Focus subgraph with full detail. Dynamic token budget.
 * Shows selected claims sorted by vulnerability, with evidence counts and edges.
 */
export function buildL2(
  graph: ClaimGraph,
  focusClaimIds: string[],
  pool: EvidencePoolManager,
  tokenBudget: number,
): string {
  const sections: string[] = ['## Focus: Detailed Claims']
  let tokensUsed = estimateTokens(sections[0])

  // Sort focus claims by vulnerability descending
  const sorted = [...focusClaimIds].sort((a, b) => {
    const ca = graph.getClaim(a)
    const cb = graph.getClaim(b)
    return (
      (cb?.strength.vulnerabilityScore ?? 0) -
      (ca?.strength.vulnerabilityScore ?? 0)
    )
  })

  for (const id of sorted) {
    const claim = graph.getClaim(id)
    if (!claim) continue

    const block = renderFullClaim(claim, pool)
    const blockTokens = estimateTokens(block)

    if (tokensUsed + blockTokens > tokenBudget) {
      const remaining = sorted.slice(sorted.indexOf(id))
      sections.push(
        `\n(${remaining.length} more in focus, truncated. IDs: ${remaining.join(', ')})`,
      )
      break
    }

    sections.push(block)
    tokensUsed += blockTokens
  }

  // Edges within focus set
  const edges = graph.getEdgesWithin(sorted)
  if (edges.length > 0) {
    sections.push('\n### Edges')
    for (const e of edges) {
      sections.push(`- ${e.source} —[${e.relation}]→ ${e.target}`)
    }
  }

  return sections.join('\n')
}

function renderFullClaim(claim: Claim, pool: EvidencePoolManager): string {
  const ev = pool.evidenceFor(claim.id)
  const mainTag = claim.is_main
    ? ' [MAIN]'
    : claim.depth != null
      ? ` [d:${claim.depth}]`
      : ''
  return `\n### [${claim.id}] ${claim.type} (${claim.epistemicLayer})${mainTag}
Phase: ${claim.phase} | Conf: ${claim.strength.confidence.toFixed(2)} | Evidence: ${claim.strength.evidenceType} | Vuln: ${claim.strength.vulnerabilityScore.toFixed(2)}
Statement: ${claim.statement}
Grounded: ${ev.grounded.length} | Derived: ${ev.derived.length}`
}
