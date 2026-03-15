import type { ClaimGraph } from './index'
import type { BuilderOutput, SkepticOutput } from './triple-role-types'

export class FocusSelector {
  /** Builder focus: frontier (proposed + under_investigation) + 1-hop neighbors. */
  selectForBuilder(graph: ClaimGraph): string[] {
    const frontier = [
      ...graph.getClaimsByPhase('proposed'),
      ...graph.getClaimsByPhase('under_investigation'),
    ]
    const neighborIds = new Set<string>()
    for (const c of frontier) {
      for (const e of graph.getEdgesOf(c.id)) {
        neighborIds.add(e.source === c.id ? e.target : e.source)
      }
    }
    return [...new Set([...frontier.map(c => c.id), ...neighborIds])]
  }

  /** Skeptic focus: top-5 weak bridges + Builder new claims + contradictions + cascade expansion. */
  selectForSkeptic(graph: ClaimGraph, builderOutput: BuilderOutput): string[] {
    const ids = new Set<string>()

    // Weak bridges
    for (const b of graph.findWeakestBridges().slice(0, 5)) {
      ids.add(b.claim.id)
    }

    // Builder's new claims
    for (const c of builderOutput.new_claims_proposed ?? []) {
      if (c.id) ids.add(c.id)
    }

    // Contradictions
    for (const c of graph.findContradictions()) {
      ids.add(c.claim.id)
    }

    // Cascade expansion
    const expanded = new Set<string>()
    for (const id of ids) {
      for (const affected of graph.cascadeAnalysis(id)) {
        expanded.add(affected)
      }
    }

    return [...new Set([...ids, ...expanded])]
  }

  /** Arbiter focus: claims disputed by Skeptic + Builder new claims. No cascade. */
  selectForArbiter(
    graph: ClaimGraph,
    builderOutput: BuilderOutput,
    skepticOutput: SkepticOutput,
  ): string[] {
    const ids = new Set<string>()

    // Skeptic-mentioned claim IDs
    for (const g of skepticOutput.bridge_gaps ?? []) {
      if (g.from_claim) ids.add(g.from_claim)
      if (g.to_claim) ids.add(g.to_claim)
    }
    for (const e of skepticOutput.evidence_inflation ?? []) {
      if (e.claim_id) ids.add(e.claim_id)
    }
    for (const c of skepticOutput.top3_collapse_points ?? []) {
      if (c.claim_id) ids.add(c.claim_id)
    }
    for (const a of skepticOutput.admission_denials ?? []) {
      if (a.claim_id) ids.add(a.claim_id)
    }

    // Builder's new claims
    for (const c of builderOutput.new_claims_proposed ?? []) {
      if (c.id) ids.add(c.id)
    }

    return [...ids]
  }
}
