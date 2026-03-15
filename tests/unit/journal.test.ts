import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ResearchJournal } from '../../src/paper/experiments/journal'
import type {
  CycleEntry,
  DashboardData,
  ClaimDelta,
} from '../../src/paper/experiments/types'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'journal-test-'))
}

function makeCycleEntry(overrides?: Partial<CycleEntry>): CycleEntry {
  return {
    cycle: 1,
    timestamp: '2026-03-14T10:00:00Z',
    action: 'run_experiment',
    builder_summary: 'Proposed baseline experiment.',
    skeptic_summary: 'No challenges.',
    arbiter_decision: 'Approved experiment dispatch.',
    result_summary: 'Experiment completed with RMSE 0.042.',
    claim_delta: {
      added: 2,
      admitted: 1,
      demoted: 0,
      rejected: 0,
      total_claims: 5,
      total_admitted: 3,
      convergence_score: 0.45,
    },
    experiment_notes: [],
    is_turning_point: false,
    ...overrides,
  }
}

function makeDashboard(overrides?: Partial<DashboardData>): DashboardData {
  return {
    total_cycles: 5,
    total_experiments: 3,
    experiments_succeeded: 2,
    experiments_failed: 1,
    claims_total: 10,
    claims_admitted: 6,
    convergence_score: 0.72,
    paper_readiness: 'nearly_ready',
    budget_spent_usd: 1.23,
    budget_remaining_usd: 8.77,
    turning_points: 1,
    last_updated: '2026-03-14T12:00:00Z',
    ...overrides,
  }
}

// ── appendCycleEntry ──────────────────────────────────────────

describe('ResearchJournal.appendCycleEntry', () => {
  test('creates JOURNAL.md when it does not exist', async () => {
    const projectDir = makeTmpDir()
    const journal = new ResearchJournal(projectDir)

    await journal.appendCycleEntry(makeCycleEntry())

    const journalPath = join(projectDir, 'experiments', 'JOURNAL.md')
    expect(existsSync(journalPath)).toBe(true)

    const content = readFileSync(journalPath, 'utf-8')
    expect(content).toContain('## Cycle 1')
    expect(content).toContain('run_experiment')
    expect(content).toContain('Proposed baseline experiment.')
  })

  test('multiple entries appended in chronological order', async () => {
    const projectDir = makeTmpDir()
    const journal = new ResearchJournal(projectDir)

    await journal.appendCycleEntry(makeCycleEntry({ cycle: 1 }))
    await journal.appendCycleEntry(
      makeCycleEntry({ cycle: 2, action: 'search_literature' }),
    )
    await journal.appendCycleEntry(
      makeCycleEntry({ cycle: 3, action: 'write_proof' }),
    )

    const content = readFileSync(
      join(projectDir, 'experiments', 'JOURNAL.md'),
      'utf-8',
    )

    const cycle1Pos = content.indexOf('## Cycle 1')
    const cycle2Pos = content.indexOf('## Cycle 2')
    const cycle3Pos = content.indexOf('## Cycle 3')

    expect(cycle1Pos).toBeGreaterThan(-1)
    expect(cycle2Pos).toBeGreaterThan(cycle1Pos)
    expect(cycle3Pos).toBeGreaterThan(cycle2Pos)

    expect(content).toContain('search_literature')
    expect(content).toContain('write_proof')
  })

  test('turning points are marked with [TURNING POINT]', async () => {
    const projectDir = makeTmpDir()
    const journal = new ResearchJournal(projectDir)

    await journal.appendCycleEntry(
      makeCycleEntry({ cycle: 1, is_turning_point: true }),
    )

    const content = readFileSync(
      join(projectDir, 'experiments', 'JOURNAL.md'),
      'utf-8',
    )
    expect(content).toContain('## Cycle 1 [TURNING POINT]')
    expect(content).toContain(
      '> **TURNING POINT**: Claims were demoted, rejected, contracted, or retracted in this cycle.',
    )
  })

  test('non-turning-point cycles have no [TURNING POINT] label', async () => {
    const projectDir = makeTmpDir()
    const journal = new ResearchJournal(projectDir)

    await journal.appendCycleEntry(
      makeCycleEntry({ cycle: 1, is_turning_point: false }),
    )

    const content = readFileSync(
      join(projectDir, 'experiments', 'JOURNAL.md'),
      'utf-8',
    )
    expect(content).toContain('## Cycle 1')
    expect(content).not.toContain('[TURNING POINT]')
  })

  test('experiment notes included as bullet list', async () => {
    const projectDir = makeTmpDir()
    const journal = new ResearchJournal(projectDir)

    await journal.appendCycleEntry(
      makeCycleEntry({
        experiment_notes: [
          {
            id: 'probe-001-test',
            purpose: 'Sanity check',
            targets_claim: 'claim-001',
            success: true,
            key_metrics: ['RMSE: 0.042'],
            audit_status: 'passed',
            arbiter_action: 'admit',
            one_liner: 'RMSE 0.042 on test set',
          },
          {
            id: 'run-002-neural',
            purpose: 'Neural operator training',
            targets_claim: 'claim-002',
            success: true,
            key_metrics: ['RMSE: 0.028'],
            audit_status: 'passed',
            arbiter_action: 'admit',
            one_liner: 'Neural op beats baseline by 33%',
          },
        ],
      }),
    )

    const content = readFileSync(
      join(projectDir, 'experiments', 'JOURNAL.md'),
      'utf-8',
    )
    expect(content).toContain('### Experiments')
    expect(content).toContain(
      '- **probe-001-test**: RMSE 0.042 on test set (audit: passed)',
    )
    expect(content).toContain(
      '- **run-002-neural**: Neural op beats baseline by 33% (audit: passed)',
    )
  })

  test('claim graph delta table is included', async () => {
    const projectDir = makeTmpDir()
    const journal = new ResearchJournal(projectDir)

    await journal.appendCycleEntry(
      makeCycleEntry({
        claim_delta: {
          added: 3,
          admitted: 2,
          demoted: 1,
          rejected: 0,
          total_claims: 8,
          total_admitted: 5,
          convergence_score: 0.65,
        },
      }),
    )

    const content = readFileSync(
      join(projectDir, 'experiments', 'JOURNAL.md'),
      'utf-8',
    )
    expect(content).toContain('### Claim Graph Delta')
    expect(content).toContain('| Added | 3 |')
    expect(content).toContain('| Admitted | 2 |')
    expect(content).toContain('| Demoted | 1 |')
    expect(content).toContain('| Convergence | 0.650 |')
  })
})

// ── updateDashboard ──────────────────────────────────────────

describe('ResearchJournal.updateDashboard', () => {
  test('creates dashboard section', async () => {
    const projectDir = makeTmpDir()
    const journal = new ResearchJournal(projectDir)

    await journal.updateDashboard(makeDashboard())

    const content = readFileSync(
      join(projectDir, 'experiments', 'JOURNAL.md'),
      'utf-8',
    )
    expect(content).toContain('# Research Journal')
    expect(content).toContain('<!-- DASHBOARD_END -->')
    expect(content).toContain('| Total Cycles | 5 |')
    expect(content).toContain('| Convergence | 0.720 |')
    expect(content).toContain('| Budget Spent | $1.23 |')
  })

  test('replaces dashboard without affecting cycle entries', async () => {
    const projectDir = makeTmpDir()
    const journal = new ResearchJournal(projectDir)

    // First write some cycle entries
    await journal.appendCycleEntry(makeCycleEntry({ cycle: 1 }))
    await journal.appendCycleEntry(
      makeCycleEntry({ cycle: 2, action: 'lit_search' }),
    )

    // Now update dashboard
    await journal.updateDashboard(makeDashboard({ total_cycles: 2 }))

    const content = readFileSync(
      join(projectDir, 'experiments', 'JOURNAL.md'),
      'utf-8',
    )

    // Dashboard should be present
    expect(content).toContain('| Total Cycles | 2 |')

    // Cycle entries should still be there below the marker
    expect(content).toContain('## Cycle 1')
    expect(content).toContain('## Cycle 2')
    expect(content).toContain('lit_search')

    // Marker should exist
    expect(content).toContain('<!-- DASHBOARD_END -->')
  })

  test('dashboard table values match provided DashboardData', async () => {
    const projectDir = makeTmpDir()
    const journal = new ResearchJournal(projectDir)

    const data = makeDashboard({
      total_cycles: 10,
      total_experiments: 7,
      experiments_succeeded: 5,
      experiments_failed: 2,
      claims_total: 15,
      claims_admitted: 9,
      convergence_score: 0.85,
      paper_readiness: 'ready',
      budget_spent_usd: 4.56,
      budget_remaining_usd: 5.44,
      turning_points: 3,
    })

    await journal.updateDashboard(data)

    const content = readFileSync(
      join(projectDir, 'experiments', 'JOURNAL.md'),
      'utf-8',
    )
    expect(content).toContain('| Total Cycles | 10 |')
    expect(content).toContain('| Total Experiments | 7 |')
    expect(content).toContain('| Experiments Succeeded | 5 |')
    expect(content).toContain('| Experiments Failed | 2 |')
    expect(content).toContain('| Claims Total | 15 |')
    expect(content).toContain('| Claims Admitted | 9 |')
    expect(content).toContain('| Convergence | 0.850 |')
    expect(content).toContain('| Paper Readiness | ready |')
    expect(content).toContain('| Budget Spent | $4.56 |')
    expect(content).toContain('| Budget Remaining | $5.44 |')
    expect(content).toContain('| Turning Points | 3 |')
  })

  test('updating dashboard twice replaces the first dashboard', async () => {
    const projectDir = makeTmpDir()
    const journal = new ResearchJournal(projectDir)

    await journal.appendCycleEntry(makeCycleEntry({ cycle: 1 }))
    await journal.updateDashboard(makeDashboard({ total_cycles: 1 }))
    await journal.updateDashboard(
      makeDashboard({ total_cycles: 2, convergence_score: 0.8 }),
    )

    const content = readFileSync(
      join(projectDir, 'experiments', 'JOURNAL.md'),
      'utf-8',
    )

    // Should have only the latest dashboard values
    expect(content).toContain('| Total Cycles | 2 |')
    expect(content).not.toContain('| Total Cycles | 1 |')
    expect(content).toContain('| Convergence | 0.800 |')

    // Cycle entries still intact
    expect(content).toContain('## Cycle 1')

    // Only one marker
    const markerCount = (content.match(/<!-- DASHBOARD_END -->/g) || []).length
    expect(markerCount).toBe(1)
  })
})
