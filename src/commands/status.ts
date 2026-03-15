import type { Command } from '@commands'
import {
  loadResearchState,
  isBudgetLow,
  getUnresolvedClaims,
  getAdmittedClaims,
} from '../paper/research-state'
import { join } from 'path'

function formatStatus(projectDir: string): string {
  const state = loadResearchState(projectDir)
  if (!state) {
    return 'No research state found. Run /propose first to select a proposal, then /run to start.'
  }

  const lines: string[] = []

  lines.push(`Research: ${state.proposal.title}`)
  lines.push(
    `Type: ${state.paper_type} | Cycle: ${state.orchestrator_cycle_count}`,
  )
  lines.push('')

  // Budget
  const budgetPct = (
    (state.budget.remaining_usd / state.budget.total_usd) *
    100
  ).toFixed(0)
  const budgetWarn = isBudgetLow(state) ? ' [LOW]' : ''
  lines.push(
    `Budget: $${state.budget.spent_usd.toFixed(2)} / $${state.budget.total_usd} (${budgetPct}% remaining)${budgetWarn}`,
  )

  // Claim graph summary
  const claims = state.claimGraph.claims
  const admitted = getAdmittedClaims(state)
  const proposed = claims.filter(c => c.phase === 'proposed')
  const investigating = claims.filter(c => c.phase === 'under_investigation')
  lines.push(
    `Claims: ${claims.length} total (${admitted.length} admitted, ${proposed.length} proposed, ${investigating.length} investigating)`,
  )

  // Stability
  const s = state.stability
  lines.push(
    `Convergence: ${(s.convergenceScore * 100).toFixed(0)}% | Readiness: ${s.paperReadiness}`,
  )

  // Evidence
  lines.push(
    `Evidence: ${state.evidencePool.grounded.length} grounded, ${state.evidencePool.derived.length} derived`,
  )

  // Weakest bridge
  if (s.weakestBridge) {
    const weakClaim = claims.find(c => c.id === s.weakestBridge?.claimId)
    if (weakClaim) {
      lines.push(
        `Weakest bridge: "${weakClaim.statement.slice(0, 60)}..." (vuln=${s.weakestBridge.vulnerability.toFixed(2)})`,
      )
    }
  }

  // Artifacts
  lines.push(`Artifacts: ${state.artifacts.entries.length}`)
  lines.push(`Trajectory: ${state.trajectory.length} actions`)

  // Literature
  lines.push(
    `Literature: ${state.literature_awareness.deeply_read.length} deeply read, ${state.literature_awareness.known_results.length} known results`,
  )

  // Proofs
  if (state.theory.proofs.length > 0) {
    const completed = state.theory.proofs.filter(
      p => p.proof_status === 'rigorous' || p.proof_status === 'verified',
    ).length
    lines.push(`Proofs: ${completed}/${state.theory.proofs.length} complete`)
  }

  return lines.join('\n')
}

const status: Command = {
  type: 'local',
  name: 'status',
  userFacingName() {
    return 'status'
  },
  description: 'Show research project cognitive state summary',
  isEnabled: true,
  isHidden: false,
  argumentHint: undefined,
  aliases: [],

  async call(_args: string): Promise<string> {
    const projectDir = join(process.cwd(), '.claude-paper-research')
    return formatStatus(projectDir)
  },
}

export default status
