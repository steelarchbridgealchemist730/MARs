import { describe, test, expect } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CreateExperiment,
  ExperimentResultsReader,
  ExperimentLogManager,
  getNestedValue,
} from '../../src/paper/experiments/index'
import type { MetricsJson } from '../../src/paper/experiments/types'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'create-read-test-'))
}

// ── CreateExperiment ────────────────────────────────────────────────

describe('CreateExperiment', () => {
  test('creates a tier-1 probe with correct ID and structure', async () => {
    const proj = makeTmpDir()
    const creator = new CreateExperiment(proj)

    const result = await creator.execute({
      name: 'GARCH Sanity',
      tier: 1,
      purpose: 'quick check',
      targets_claim: 'claim-1',
    })

    expect(result.id).toBe('probe-001-garch-sanity')
    expect(result.dir).toContain('experiments/probes/probe-001-garch-sanity')

    // meta.json exists with correct shape
    const meta = JSON.parse(
      readFileSync(join(result.dir, 'meta.json'), 'utf-8'),
    )
    expect(meta.id).toBe('probe-001-garch-sanity')
    expect(meta.tier).toBe(1)
    expect(meta.status).toBe('created')
    expect(meta.seed).toBe(42)
    expect(meta.created_by).toBe('orchestrator')
    expect(meta.purpose).toBe('quick check')
    expect(meta.targets_claim).toBe('claim-1')
    expect(meta.created_at).toBeTruthy()

    // tier-1 results/ dir exists
    expect(existsSync(join(result.dir, 'results'))).toBe(true)

    // shared dirs created
    expect(existsSync(join(proj, 'experiments', 'shared', 'data'))).toBe(true)
    expect(existsSync(join(proj, 'experiments', 'shared', 'lib'))).toBe(true)
  })

  test('creates a tier-2 run with full directory structure', async () => {
    const proj = makeTmpDir()
    const creator = new CreateExperiment(proj)

    const result = await creator.execute({
      name: 'Baseline Comparison',
      tier: 2,
      purpose: 'full baseline',
      targets_claim: 'claim-2',
    })

    expect(result.id).toBe('run-001-baseline-comparison')

    // tier-2 directories
    for (const dir of ['src', 'tests', 'configs', 'scripts']) {
      expect(existsSync(join(result.dir, dir))).toBe(true)
    }
    for (const sub of ['figures', 'tables', 'logs', 'statistical_tests']) {
      expect(existsSync(join(result.dir, 'results', sub))).toBe(true)
    }
  })

  test('sequential probes get incrementing IDs', async () => {
    const proj = makeTmpDir()
    const creator = new CreateExperiment(proj)

    const r1 = await creator.execute({
      name: 'first',
      tier: 1,
      purpose: 'p1',
      targets_claim: 'c1',
    })
    const r2 = await creator.execute({
      name: 'second',
      tier: 1,
      purpose: 'p2',
      targets_claim: 'c2',
    })

    expect(r1.id).toBe('probe-001-first')
    expect(r2.id).toBe('probe-002-second')

    // Both registered in experiment log
    const log = new ExperimentLogManager(proj)
    const entries = log.load().experiments
    expect(entries).toHaveLength(2)
    expect(entries.map(e => e.id)).toEqual([
      'probe-001-first',
      'probe-002-second',
    ])
  })
})

// ── ExperimentResultsReader ─────────────────────────────────────────

describe('ExperimentResultsReader', () => {
  test('readMetrics parses results/metrics.json', async () => {
    const proj = makeTmpDir()
    const creator = new CreateExperiment(proj)
    const { id, dir } = await creator.execute({
      name: 'metric-test',
      tier: 1,
      purpose: 'test metrics',
      targets_claim: 'c1',
    })

    const metrics: MetricsJson = {
      experiment_id: id,
      timestamp: '2026-03-14T00:00:00Z',
      seed: 42,
      models: {
        garch: {
          out_of_sample: { rmse: 0.05, mae: 0.03 },
        },
      },
    }
    await Bun.write(
      join(dir, 'results', 'metrics.json'),
      JSON.stringify(metrics),
    )

    const logMgr = new ExperimentLogManager(proj)
    const reader = new ExperimentResultsReader(proj, logMgr)
    const read = reader.readMetrics(id)

    expect(read).not.toBeNull()
    expect(read!.experiment_id).toBe(id)
    expect(read!.models.garch.out_of_sample.rmse).toBe(0.05)
  })

  test('compareMetric sorts results ascending by value', async () => {
    const proj = makeTmpDir()
    const creator = new CreateExperiment(proj)

    const r1 = await creator.execute({
      name: 'high-error',
      tier: 1,
      purpose: 'p1',
      targets_claim: 'c1',
    })
    const r2 = await creator.execute({
      name: 'low-error',
      tier: 1,
      purpose: 'p2',
      targets_claim: 'c2',
    })

    // Write metrics with different RMSE values
    const makeMetrics = (expId: string, rmse: number): MetricsJson => ({
      experiment_id: expId,
      timestamp: '2026-03-14T00:00:00Z',
      seed: 42,
      models: {
        modelA: { out_of_sample: { rmse } },
      },
    })

    await Bun.write(
      join(r1.dir, 'results', 'metrics.json'),
      JSON.stringify(makeMetrics(r1.id, 0.9)),
    )
    await Bun.write(
      join(r2.dir, 'results', 'metrics.json'),
      JSON.stringify(makeMetrics(r2.id, 0.1)),
    )

    const logMgr = new ExperimentLogManager(proj)
    const reader = new ExperimentResultsReader(proj, logMgr)
    const compared = reader.compareMetric([r1.id, r2.id], 'out_of_sample.rmse')

    expect(compared).toHaveLength(2)
    // Sorted ascending: low first
    expect(compared[0].experiment_id).toBe(r2.id)
    expect(compared[0].model).toBe('modelA')
    expect(compared[0].value).toBe(0.1)
    expect(compared[1].experiment_id).toBe(r1.id)
    expect(compared[1].value).toBe(0.9)
  })
})

// ── getNestedValue ──────────────────────────────────────────────────

describe('getNestedValue', () => {
  test('retrieves nested value by dot path', () => {
    expect(getNestedValue({ a: { b: 3 } }, 'a.b')).toBe(3)
  })

  test('returns undefined for missing path', () => {
    expect(getNestedValue({ x: 1 }, 'a.b')).toBeUndefined()
  })

  test('returns undefined when intermediate is null', () => {
    expect(getNestedValue({ a: null }, 'a.b')).toBeUndefined()
  })
})
