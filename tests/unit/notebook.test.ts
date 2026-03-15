import { describe, test, expect } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExperimentNotebook } from '../../src/paper/experiments/notebook'
import type {
  NoteData,
  ExperimentLogEntry,
  ExperimentMeta,
  MetricsJson,
  FullAuditResult,
} from '../../src/paper/experiments/types'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'notebook-test-'))
}

function setupProject(): {
  projectDir: string
  experimentId: string
  experimentDir: string
} {
  const projectDir = makeTmpDir()
  const experimentId = 'probe-001-test'
  const experimentDir = join(projectDir, 'experiments', 'probes', experimentId)
  mkdirSync(join(experimentDir, 'results'), { recursive: true })

  // Write experiment-log.json
  const logEntry: ExperimentLogEntry = {
    id: experimentId,
    tier: 1,
    status: 'completed',
    purpose: 'Test sanity check',
    targets_claim: 'claim-001',
    key_result: 'RMSE 0.042 on test set',
    created_at: '2026-03-14T10:00:00Z',
    duration_seconds: 45,
    path: `experiments/probes/${experimentId}`,
  }
  mkdirSync(join(projectDir, 'experiments'), { recursive: true })
  writeFileSync(
    join(projectDir, 'experiments', 'experiment-log.json'),
    JSON.stringify({ experiments: [logEntry] }),
  )

  // Write meta.json
  const meta: ExperimentMeta = {
    id: experimentId,
    tier: 1,
    purpose: 'Test sanity check',
    targets_claim: 'claim-001',
    created_at: '2026-03-14T10:00:00Z',
    created_by: 'orchestrator',
    status: 'completed',
    seed: 42,
  }
  writeFileSync(join(experimentDir, 'meta.json'), JSON.stringify(meta))

  return { projectDir, experimentId, experimentDir }
}

function makeNoteData(overrides?: Partial<NoteData>): NoteData {
  return {
    arbiterDecision: {
      reasoning: 'Results look promising, confidence raised.',
      action: {
        type: 'admit',
        delegate_to: 'experiment-runner',
        targets_claim: 'claim-001',
      },
    },
    builderNarrative:
      'We ran a baseline sanity check to validate the data pipeline.',
    skepticChallenge: 'Small sample size may not generalize.',
    executionResult: {
      success: true,
      summary: 'Experiment completed. RMSE=0.042 on test set.',
      agent: 'experiment-runner',
      artifacts_produced: ['results/metrics.json', 'results/plots/loss.png'],
      cost_usd: 0.0123,
    },
    metricsJson: {
      experiment_id: 'probe-001-test',
      timestamp: '2026-03-14T10:00:30Z',
      seed: 42,
      models: {
        baseline: {
          out_of_sample: { RMSE: 0.042, MAE: 0.031 },
          in_sample: { RMSE: 0.038 },
        },
      },
      statistical_tests: {
        DM_test: {
          statistic: 2.45,
          p_value: 0.008,
          significant_5pct: true,
          significant_1pct: true,
          direction: 'baseline < neural_op',
        },
      },
    },
    auditResult: {
      experiment_id: 'probe-001-test',
      audit_timestamp: '2026-03-14T10:01:00Z',
      static_audit: {
        passed: true,
        checks: [
          { name: 'seed_set', passed: true, details: 'Seed 42 found' },
          { name: 'no_test_in_train', passed: true, details: 'Clean split' },
        ],
        timestamp: '2026-03-14T10:01:00Z',
      },
    },
    claimImpacts: [
      {
        claim_id: 'claim-001',
        action: 'admit',
        new_confidence: 0.85,
        reason: 'RMSE improvement',
      },
    ],
    ...overrides,
  }
}

// ── generateNote ──────────────────────────────────────────

describe('ExperimentNotebook.generateNote', () => {
  test('writes NOTE.md with correct sections', async () => {
    const { projectDir, experimentId, experimentDir } = setupProject()
    const notebook = new ExperimentNotebook(projectDir)

    await notebook.generateNote(experimentId, makeNoteData())

    const notePath = join(experimentDir, 'NOTE.md')
    expect(existsSync(notePath)).toBe(true)

    const content = readFileSync(notePath, 'utf-8')

    // Check header
    expect(content).toContain(`# Experiment Note: ${experimentId}`)
    expect(content).toContain('| **Tier** | 1 |')
    expect(content).toContain('| **Seed** | 42 |')

    // Check purpose
    expect(content).toContain('## Purpose')
    expect(content).toContain('Test sanity check')
    expect(content).toContain('**Target claim:** claim-001')

    // Check execution
    expect(content).toContain('**Status:** SUCCESS')
    expect(content).toContain('**Agent:** experiment-runner')
    expect(content).toContain('$0.0123')

    // Check metrics table
    expect(content).toContain('## Metrics')
    expect(content).toContain('| baseline | RMSE |')
    expect(content).toContain('| baseline | MAE |')

    // Check statistical tests
    expect(content).toContain('## Statistical Tests')
    expect(content).toContain('DM_test')
    expect(content).toContain('2.4500')
    expect(content).toContain('0.0080')

    // Check audit
    expect(content).toContain('## Audit')
    expect(content).toContain('seed_set')
    expect(content).toContain('PASS')

    // Check builder/skeptic
    expect(content).toContain('## Builder Narrative')
    expect(content).toContain('baseline sanity check')
    expect(content).toContain('## Skeptic Challenge')
    expect(content).toContain('Small sample size')

    // Check arbiter
    expect(content).toContain('## Arbiter Decision')
    expect(content).toContain('**Action:** admit')

    // Check claim impacts
    expect(content).toContain('## Claim Impacts')
    expect(content).toContain('| claim-001 | admit | 0.85 | RMSE improvement |')
  })

  test('handles null metricsJson gracefully', async () => {
    const { projectDir, experimentId, experimentDir } = setupProject()
    const notebook = new ExperimentNotebook(projectDir)

    await notebook.generateNote(
      experimentId,
      makeNoteData({ metricsJson: null }),
    )

    const content = readFileSync(join(experimentDir, 'NOTE.md'), 'utf-8')
    expect(content).toContain('No metrics.json found.')
    expect(content).toContain('None.') // statistical tests
  })

  test('handles null auditResult gracefully', async () => {
    const { projectDir, experimentId, experimentDir } = setupProject()
    const notebook = new ExperimentNotebook(projectDir)

    await notebook.generateNote(
      experimentId,
      makeNoteData({ auditResult: null }),
    )

    const content = readFileSync(join(experimentDir, 'NOTE.md'), 'utf-8')
    expect(content).toContain('No audit performed.')
  })

  test('handles empty claimImpacts', async () => {
    const { projectDir, experimentId, experimentDir } = setupProject()
    const notebook = new ExperimentNotebook(projectDir)

    await notebook.generateNote(
      experimentId,
      makeNoteData({ claimImpacts: [] }),
    )

    const content = readFileSync(join(experimentDir, 'NOTE.md'), 'utf-8')
    expect(content).toContain('No claim updates.')
  })

  test('handles missing experiment directory without throwing', async () => {
    const projectDir = makeTmpDir()
    mkdirSync(join(projectDir, 'experiments'), { recursive: true })
    writeFileSync(
      join(projectDir, 'experiments', 'experiment-log.json'),
      JSON.stringify({
        experiments: [
          {
            id: 'nonexistent',
            tier: 1,
            status: 'completed',
            purpose: 'test',
            targets_claim: 'c1',
            key_result: null,
            created_at: '2026-01-01',
            duration_seconds: null,
            path: 'experiments/probes/nonexistent',
          },
        ],
      }),
    )

    const notebook = new ExperimentNotebook(projectDir)
    // Should not throw
    await notebook.generateNote('nonexistent', makeNoteData())
  })

  test('handles unknown experiment ID without throwing', async () => {
    const projectDir = makeTmpDir()
    const notebook = new ExperimentNotebook(projectDir)
    // Should not throw — returns silently
    await notebook.generateNote('totally-unknown', makeNoteData())
  })
})

// ── extractSummary ──────────────────────────────────────────

describe('ExperimentNotebook.extractSummary', () => {
  test('returns correct fields from meta.json + metrics.json + audit.json', async () => {
    const { projectDir, experimentId, experimentDir } = setupProject()
    const notebook = new ExperimentNotebook(projectDir)

    // Write metrics.json
    const metrics: MetricsJson = {
      experiment_id: experimentId,
      timestamp: '2026-03-14T10:00:30Z',
      seed: 42,
      models: {
        baseline: {
          out_of_sample: { RMSE: 0.042, MAE: 0.031, R2: 0.95 },
        },
        neural_op: {
          out_of_sample: { RMSE: 0.028, MAE: 0.019, R2: 0.97 },
        },
      },
    }
    writeFileSync(
      join(experimentDir, 'results', 'metrics.json'),
      JSON.stringify(metrics),
    )

    // Write audit.json
    const audit: FullAuditResult = {
      experiment_id: experimentId,
      audit_timestamp: '2026-03-14T10:01:00Z',
      static_audit: {
        passed: true,
        checks: [{ name: 'seed_set', passed: true, details: '' }],
        timestamp: '2026-03-14T10:01:00Z',
      },
    }
    writeFileSync(join(experimentDir, 'audit.json'), JSON.stringify(audit))

    // Write NOTE.md (so arbiter_action can be extracted)
    await notebook.generateNote(experimentId, makeNoteData())

    const summary = notebook.extractSummary(experimentId)

    expect(summary.id).toBe(experimentId)
    expect(summary.purpose).toBe('Test sanity check')
    expect(summary.targets_claim).toBe('claim-001')
    expect(summary.success).toBe(true)
    expect(summary.key_metrics.length).toBeLessThanOrEqual(3)
    expect(summary.key_metrics[0]).toContain('RMSE')
    expect(summary.audit_status).toBe('passed')
    expect(summary.arbiter_action).toBe('admit')
    expect(summary.one_liner).toBe('RMSE 0.042 on test set')
  })

  test('works when NOTE.md is missing (falls back to meta.json)', () => {
    const { projectDir, experimentId } = setupProject()
    const notebook = new ExperimentNotebook(projectDir)

    const summary = notebook.extractSummary(experimentId)

    expect(summary.id).toBe(experimentId)
    expect(summary.purpose).toBe('Test sanity check')
    expect(summary.arbiter_action).toBe('unknown')
    expect(summary.audit_status).toBe('none')
  })

  test('returns fallback for unknown experiment', () => {
    const projectDir = makeTmpDir()
    const notebook = new ExperimentNotebook(projectDir)

    const summary = notebook.extractSummary('totally-unknown')

    expect(summary.id).toBe('totally-unknown')
    expect(summary.purpose).toBe('unknown')
    expect(summary.success).toBe(false)
    expect(summary.key_metrics).toEqual([])
  })

  test('handles failed audit', () => {
    const { projectDir, experimentId, experimentDir } = setupProject()

    // Write a failed audit
    const audit: FullAuditResult = {
      experiment_id: experimentId,
      audit_timestamp: '2026-03-14T10:01:00Z',
      static_audit: {
        passed: false,
        checks: [{ name: 'seed_set', passed: false, details: 'No seed' }],
        timestamp: '2026-03-14T10:01:00Z',
      },
    }
    writeFileSync(join(experimentDir, 'audit.json'), JSON.stringify(audit))

    const notebook = new ExperimentNotebook(projectDir)
    const summary = notebook.extractSummary(experimentId)

    expect(summary.audit_status).toBe('failed')
  })
})
