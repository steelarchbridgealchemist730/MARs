import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CycleEntry, DashboardData } from './types'

const DASHBOARD_MARKER = '<!-- DASHBOARD_END -->'

/**
 * Maintains a chronological JOURNAL.md of orchestrator cycles.
 * Pure template rendering — no LLM calls.
 */
export class ResearchJournal {
  private journalPath: string

  constructor(projectDir: string) {
    this.journalPath = join(projectDir, 'experiments', 'JOURNAL.md')
  }

  /**
   * Append a cycle entry to the journal.
   * Creates the file if it doesn't exist.
   */
  async appendCycleEntry(entry: CycleEntry): Promise<void> {
    mkdirSync(dirname(this.journalPath), { recursive: true })

    let existing = ''
    if (existsSync(this.journalPath)) {
      existing = readFileSync(this.journalPath, 'utf-8')
    }

    // Initialize with dashboard marker if empty
    if (!existing.trim()) {
      existing = `# Research Journal\n\n${DASHBOARD_MARKER}\n`
    }

    const block = this.renderCycleEntry(entry)
    const content = existing.trimEnd() + '\n\n' + block + '\n'

    await Bun.write(this.journalPath, content)
  }

  /**
   * Update the dashboard section at the top of JOURNAL.md.
   * Replaces everything above <!-- DASHBOARD_END --> (inclusive),
   * preserving cycle entries below.
   */
  async updateDashboard(dashboard: DashboardData): Promise<void> {
    mkdirSync(dirname(this.journalPath), { recursive: true })

    let existing = ''
    if (existsSync(this.journalPath)) {
      existing = readFileSync(this.journalPath, 'utf-8')
    }

    const dashboardSection = this.renderDashboard(dashboard)

    const markerIdx = existing.indexOf(DASHBOARD_MARKER)
    if (markerIdx >= 0) {
      // Replace everything up to and including the marker
      const afterMarker = existing.slice(markerIdx + DASHBOARD_MARKER.length)
      await Bun.write(
        this.journalPath,
        dashboardSection + DASHBOARD_MARKER + afterMarker,
      )
    } else {
      // No marker found — prepend dashboard + marker, keep existing content
      const content = dashboardSection + DASHBOARD_MARKER + '\n\n' + existing
      await Bun.write(this.journalPath, content)
    }
  }

  private renderCycleEntry(entry: CycleEntry): string {
    const lines: string[] = []

    const turningLabel = entry.is_turning_point ? ' [TURNING POINT]' : ''
    lines.push(`---`)
    lines.push(`## Cycle ${entry.cycle}${turningLabel}`)
    lines.push('')
    lines.push(`**${entry.timestamp}** | Action: \`${entry.action}\``)
    lines.push('')

    lines.push(`### Builder`)
    lines.push('')
    lines.push(entry.builder_summary || 'No narrative.')
    lines.push('')

    lines.push(`### Skeptic`)
    lines.push('')
    lines.push(entry.skeptic_summary || 'No challenges.')
    lines.push('')

    lines.push(`### Arbiter Decision`)
    lines.push('')
    lines.push(entry.arbiter_decision || 'No assessment.')
    lines.push('')

    lines.push(`### Result`)
    lines.push('')
    lines.push(entry.result_summary || 'No result.')
    lines.push('')

    lines.push(`### Claim Graph Delta`)
    lines.push('')
    const d = entry.claim_delta
    lines.push(
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Added | ${d.added} |`,
      `| Admitted | ${d.admitted} |`,
      `| Demoted | ${d.demoted} |`,
      `| Rejected | ${d.rejected} |`,
      `| Total Claims | ${d.total_claims} |`,
      `| Total Admitted | ${d.total_admitted} |`,
      `| Convergence | ${d.convergence_score.toFixed(3)} |`,
    )

    if (entry.experiment_notes.length > 0) {
      lines.push('')
      lines.push(`### Experiments`)
      lines.push('')
      for (const note of entry.experiment_notes) {
        lines.push(
          `- **${note.id}**: ${note.one_liner} (audit: ${note.audit_status})`,
        )
      }
    }

    if (entry.is_turning_point) {
      lines.push('')
      lines.push(
        `> **TURNING POINT**: Claims were demoted, rejected, contracted, or retracted in this cycle.`,
      )
    }

    return lines.join('\n')
  }

  private renderDashboard(data: DashboardData): string {
    const lines: string[] = []

    lines.push(`# Research Journal`)
    lines.push('')
    lines.push(`> Last updated: ${data.last_updated}`)
    lines.push('')
    lines.push(`| Metric | Value |`)
    lines.push(`|--------|-------|`)
    lines.push(`| Total Cycles | ${data.total_cycles} |`)
    lines.push(`| Total Experiments | ${data.total_experiments} |`)
    lines.push(`| Experiments Succeeded | ${data.experiments_succeeded} |`)
    lines.push(`| Experiments Failed | ${data.experiments_failed} |`)
    lines.push(`| Claims Total | ${data.claims_total} |`)
    lines.push(`| Claims Admitted | ${data.claims_admitted} |`)
    lines.push(`| Convergence | ${data.convergence_score.toFixed(3)} |`)
    lines.push(`| Paper Readiness | ${data.paper_readiness} |`)
    lines.push(`| Budget Spent | $${data.budget_spent_usd.toFixed(2)} |`)
    lines.push(
      `| Budget Remaining | $${data.budget_remaining_usd.toFixed(2)} |`,
    )
    lines.push(`| Turning Points | ${data.turning_points} |`)
    lines.push('')

    return lines.join('\n')
  }
}
