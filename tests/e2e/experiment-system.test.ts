import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ExperimentLogManager,
  ExperimentResultsReader,
  CreateExperiment,
  ExperimentAuditor,
  ExperimentPromoter,
  ExperimentNotebook,
  ResearchJournal,
} from '../../src/paper/experiments/index'
import type { CommandRunner } from '../../src/paper/experiments/auditor'
import type {
  MetricsJson,
  NoteData,
  CycleEntry,
} from '../../src/paper/experiments/types'

// ── Shared state across sequential tests ────────────────────────

let projectDir: string
let logManager: ExperimentLogManager
let resultsReader: ExperimentResultsReader
let creator: CreateExperiment
let auditor: ExperimentAuditor
let promoter: ExperimentPromoter
let notebook: ExperimentNotebook
let journal: ResearchJournal

let probeId: string
let probeDir: string
let runId: string
let runDir: string
let promotedRunId: string
let promotedRunDir: string

const successRunner: CommandRunner = async () => ({
  exitCode: 0,
  output: 'OK',
})

describe('Experiment System E2E', () => {
  // ── Step 1: Initialization ──────────────────────────────────────

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'exp-e2e-'))
    logManager = new ExperimentLogManager(projectDir)
    resultsReader = new ExperimentResultsReader(projectDir, logManager)
    creator = new CreateExperiment(projectDir)
    auditor = new ExperimentAuditor(projectDir, successRunner)
    promoter = new ExperimentPromoter(projectDir)
    notebook = new ExperimentNotebook(projectDir)
    journal = new ResearchJournal(projectDir)
  })

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  // ── Step 2: Create Probe (Tier 1) ──────────────────────────────

  test('create tier-1 probe', async () => {
    const result = await creator.execute({
      name: 'GARCH Sanity',
      tier: 1,
      purpose: 'test',
      targets_claim: 'c-001',
    })

    probeId = result.id
    probeDir = result.dir

    expect(probeId).toBe('probe-001-garch-sanity')
    expect(existsSync(probeDir)).toBe(true)

    // meta.json exists with correct fields
    const meta = JSON.parse(readFileSync(join(probeDir, 'meta.json'), 'utf-8'))
    expect(meta.id).toBe(probeId)
    expect(meta.tier).toBe(1)
    expect(meta.purpose).toBe('test')
    expect(meta.targets_claim).toBe('c-001')
    expect(meta.status).toBe('created')
    expect(meta.seed).toBe(42)

    // experiment-log.json has entry
    const entry = logManager.getExperiment(probeId)
    expect(entry).not.toBeNull()
    expect(entry!.tier).toBe(1)
    expect(entry!.status).toBe('created')

    // results/ directory exists for tier 1
    expect(existsSync(join(probeDir, 'results'))).toBe(true)
  })

  // ── Step 3: Simulate Probe Completion ──────────────────────────

  test('simulate probe completion and read metrics', async () => {
    const metrics: MetricsJson = {
      experiment_id: probeId,
      timestamp: new Date().toISOString(),
      seed: 42,
      models: {
        GARCH: {
          out_of_sample: { rmse: 0.0234, mae: 0.0189 },
          parameters: { p: 1, q: 1 },
          convergence: true,
        },
        EGARCH: {
          out_of_sample: { rmse: 0.0198, mae: 0.0165 },
          parameters: { p: 1, q: 1, leverage: true },
          convergence: true,
        },
      },
      statistical_tests: {
        dm_test: {
          statistic: 2.34,
          p_value: 0.019,
          significant_5pct: true,
          significant_1pct: false,
          direction: 'EGARCH better',
        },
      },
    }

    // Write metrics.json
    mkdirSync(join(probeDir, 'results'), { recursive: true })
    writeFileSync(
      join(probeDir, 'results', 'metrics.json'),
      JSON.stringify(metrics, null, 2),
    )

    // Update log entry to completed
    await logManager.updateStatus(probeId, {
      status: 'completed',
      key_result: 'alpha+beta=0.99',
    })

    // Verify metrics readable
    const readBack = resultsReader.readMetrics(probeId)
    expect(readBack).not.toBeNull()
    expect(readBack!.models.GARCH.out_of_sample.rmse).toBe(0.0234)
    expect(readBack!.models.EGARCH.out_of_sample.rmse).toBe(0.0198)

    // Verify summary includes this probe
    const summaries = resultsReader.getSummary()
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    expect(summaries.some(s => s.id === probeId)).toBe(true)
    expect(summaries.find(s => s.id === probeId)!.key_result).toBe(
      'alpha+beta=0.99',
    )
  })

  // ── Step 4: Create Tier 2 Run ──────────────────────────────────

  test('create tier-2 run', async () => {
    const result = await creator.execute({
      name: 'Full Compare',
      tier: 2,
      purpose: 'full comparison',
      targets_claim: 'c-002',
    })

    runId = result.id
    runDir = result.dir

    expect(runId).toBe('run-001-full-compare')
    expect(existsSync(runDir)).toBe(true)

    // Tier 2 has src/, tests/, scripts/, configs/ dirs
    expect(existsSync(join(runDir, 'src'))).toBe(true)
    expect(existsSync(join(runDir, 'tests'))).toBe(true)
    expect(existsSync(join(runDir, 'scripts'))).toBe(true)
    expect(existsSync(join(runDir, 'configs'))).toBe(true)

    // Results subdirs
    expect(existsSync(join(runDir, 'results', 'figures'))).toBe(true)
    expect(existsSync(join(runDir, 'results', 'tables'))).toBe(true)
  })

  // ── Step 5: Audit Tier 2 ───────────────────────────────────────

  test('audit tier-2 run: seed + output pass', async () => {
    // Write source with seed + json output
    writeFileSync(
      join(runDir, 'src', 'main.py'),
      [
        'import numpy as np',
        'import json',
        '',
        'np.random.seed(42)',
        '',
        'results = {"rmse": 0.02}',
        'with open("results/metrics.json", "w") as f:',
        '    json.dump(results, f)',
      ].join('\n'),
    )

    const result = await auditor.staticAudit(runDir)
    const seedCheck = result.checks.find(c => c.name === 'reproducibility_seed')
    const outputCheck = result.checks.find(c => c.name === 'output_format')
    const leakageCheck = result.checks.find(c => c.name === 'data_leakage')

    expect(seedCheck!.passed).toBe(true)
    expect(outputCheck!.passed).toBe(true)
    expect(leakageCheck!.passed).toBe(true)
  })

  test('audit tier-2 run: data leakage detected', async () => {
    // Append leakage pattern
    const existing = readFileSync(join(runDir, 'src', 'main.py'), 'utf-8')
    writeFileSync(
      join(runDir, 'src', 'main.py'),
      existing + '\nscaler.fit(full_data)\n',
    )

    const result = await auditor.staticAudit(runDir)
    const leakageCheck = result.checks.find(c => c.name === 'data_leakage')

    expect(leakageCheck!.passed).toBe(false)
    expect(leakageCheck!.details).toContain('scaler.fit(full_data)')
  })

  // ── Step 6: Probe -> Run Promotion ─────────────────────────────

  test('promote probe to run', async () => {
    // Write probe.py so promoter can copy it
    writeFileSync(
      join(probeDir, 'probe.py'),
      ['import numpy as np', 'np.random.seed(42)', 'print("GARCH probe")'].join(
        '\n',
      ),
    )

    const result = await promoter.promoteToRun(probeId)
    promotedRunId = result.runId
    promotedRunDir = result.runDir

    expect(promotedRunId).toMatch(/^run-\d+-garch-sanity$/)
    expect(existsSync(promotedRunDir)).toBe(true)

    // Probe code copied to scripts/run.py (probe.py -> run.py rename)
    const runPy = readFileSync(
      join(promotedRunDir, 'scripts', 'run.py'),
      'utf-8',
    )
    expect(runPy).toContain('GARCH probe')

    // Probe meta.json updated with promoted_to_run
    const probeMeta = JSON.parse(
      readFileSync(join(probeDir, 'meta.json'), 'utf-8'),
    )
    expect(probeMeta.promoted_to_run).toBe(promotedRunId)

    // Run registered in experiment log
    const entry = logManager.getExperiment(promotedRunId)
    expect(entry).not.toBeNull()
    expect(entry!.tier).toBe(2)
    expect(entry!.status).toBe('created')
  })

  // ── Step 7: Cross-Experiment Comparison ────────────────────────

  test('compare metrics across experiments', async () => {
    // Write different metrics for the promoted run
    mkdirSync(join(promotedRunDir, 'results'), { recursive: true })
    const runMetrics: MetricsJson = {
      experiment_id: promotedRunId,
      timestamp: new Date().toISOString(),
      seed: 42,
      models: {
        GARCH: {
          out_of_sample: { rmse: 0.0215, mae: 0.0175 },
          convergence: true,
        },
        EGARCH: {
          out_of_sample: { rmse: 0.0182, mae: 0.0148 },
          convergence: true,
        },
      },
    }
    writeFileSync(
      join(promotedRunDir, 'results', 'metrics.json'),
      JSON.stringify(runMetrics, null, 2),
    )

    // Update promoted run status to completed
    await logManager.updateStatus(promotedRunId, {
      status: 'completed',
      key_result: 'EGARCH RMSE improved',
    })

    // Compare out_of_sample.rmse across probe and promoted run
    const comparison = resultsReader.compareMetric(
      [probeId, promotedRunId],
      'out_of_sample.rmse',
    )

    expect(comparison.length).toBe(4) // 2 models x 2 experiments
    // Results sorted ascending by value
    for (let i = 1; i < comparison.length; i++) {
      expect(comparison[i].value).toBeGreaterThanOrEqual(
        comparison[i - 1].value,
      )
    }
    // Lowest RMSE should be the promoted run's EGARCH
    expect(comparison[0].model).toBe('EGARCH')
    expect(comparison[0].experiment_id).toBe(promotedRunId)
    expect(comparison[0].value).toBe(0.0182)
  })

  // ── Step 8: Journal Linkage ────────────────────────────────────

  test('generate experiment note', async () => {
    const noteData: NoteData = {
      arbiterDecision: {
        reasoning:
          'EGARCH shows statistically significant improvement over GARCH',
        action: {
          type: 'run_experiment',
          delegate_to: 'experiment-runner',
          targets_claim: 'c-001',
        },
      },
      builderNarrative:
        'Proposed EGARCH as leverage-aware alternative to standard GARCH.',
      skepticChallenge:
        'Sample size may be insufficient for reliable DM test conclusions.',
      executionResult: {
        success: true,
        summary: 'EGARCH outperforms GARCH by 15% RMSE on out-of-sample data.',
        agent: 'experiment-runner',
        artifacts_produced: ['results/metrics.json'],
        cost_usd: 0.042,
      },
      metricsJson: resultsReader.readMetrics(probeId),
      auditResult: null,
      claimImpacts: [
        {
          claim_id: 'c-001',
          action: 'increase_confidence',
          new_confidence: 0.75,
          reason: 'Experiment confirms EGARCH superiority',
        },
      ],
    }

    await notebook.generateNote(probeId, noteData)

    const notePath = join(probeDir, 'NOTE.md')
    expect(existsSync(notePath)).toBe(true)

    const noteContent = readFileSync(notePath, 'utf-8')
    expect(noteContent).toContain(`Experiment Note: ${probeId}`)
    expect(noteContent).toContain('SUCCESS')
    expect(noteContent).toContain('experiment-runner')
    expect(noteContent).toContain('c-001')
    expect(noteContent).toContain('EGARCH')
  })

  test('append journal cycle entry', async () => {
    const cycleEntry: CycleEntry = {
      cycle: 1,
      timestamp: new Date().toISOString(),
      action: 'run_experiment',
      builder_summary: 'Proposed volatility model comparison experiment.',
      skeptic_summary: 'Questioned statistical power of DM test.',
      arbiter_decision: 'Approved experiment with larger sample size.',
      result_summary: 'EGARCH outperformed GARCH by 15% RMSE.',
      claim_delta: {
        added: 2,
        admitted: 1,
        demoted: 0,
        rejected: 0,
        total_claims: 5,
        total_admitted: 3,
        convergence_score: 0.65,
      },
      experiment_notes: [
        {
          id: probeId,
          purpose: 'test',
          targets_claim: 'c-001',
          success: true,
          key_metrics: ['rmse: 0.0198', 'mae: 0.0165'],
          audit_status: 'none',
          arbiter_action: 'run_experiment',
          one_liner: 'EGARCH beats GARCH',
        },
      ],
      is_turning_point: false,
    }

    await journal.appendCycleEntry(cycleEntry)

    const journalPath = join(projectDir, 'experiments', 'JOURNAL.md')
    expect(existsSync(journalPath)).toBe(true)

    const journalContent = readFileSync(journalPath, 'utf-8')
    expect(journalContent).toContain('Cycle 1')
    expect(journalContent).toContain('run_experiment')
    expect(journalContent).toContain('Proposed volatility model comparison')
    expect(journalContent).toContain('0.650')
  })

  // ── Step 9: Verify Full State Integrity ────────────────────────

  test('experiment log has all expected entries', () => {
    const log = logManager.load()
    const ids = log.experiments.map(e => e.id)

    expect(ids).toContain(probeId)
    expect(ids).toContain(runId)
    expect(ids).toContain(promotedRunId)
    expect(log.experiments.length).toBe(3)
  })
})
