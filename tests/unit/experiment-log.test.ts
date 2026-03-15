import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExperimentLogManager } from '../../src/paper/experiments/experiment-log'
import type { ExperimentLogEntry } from '../../src/paper/experiments/types'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'exp-log-test-'))
}

function makeEntry(
  overrides: Partial<ExperimentLogEntry> = {},
): ExperimentLogEntry {
  return {
    id: 'probe-001-test',
    tier: 1,
    status: 'completed',
    purpose: 'sanity check',
    targets_claim: 'claim-1',
    key_result: 'looks good',
    created_at: '2026-03-14T00:00:00Z',
    duration_seconds: 10,
    path: 'experiments/probe-001-test',
    audit_status: null,
    tests_passed: null,
    ...overrides,
  }
}

describe('ExperimentLogManager', () => {
  let dir: string
  let mgr: ExperimentLogManager

  beforeEach(() => {
    dir = makeTmpDir()
    mgr = new ExperimentLogManager(dir)
  })

  // -- load --

  describe('load', () => {
    test('returns empty log when file missing', () => {
      const log = mgr.load()
      expect(log).toEqual({ experiments: [] })
    })

    test('returns empty log when directory missing', () => {
      const deepDir = join(dir, 'nonexistent', 'nested')
      const m = new ExperimentLogManager(deepDir)
      expect(m.load()).toEqual({ experiments: [] })
    })
  })

  // -- register + load --

  describe('register', () => {
    test('persists to disk and survives new manager instance', async () => {
      const entry = makeEntry()
      await mgr.register(entry)

      const mgr2 = new ExperimentLogManager(dir)
      const log = mgr2.load()
      expect(log.experiments).toHaveLength(1)
      expect(log.experiments[0].id).toBe('probe-001-test')
    })

    test('overwrites entry with same ID', async () => {
      await mgr.register(makeEntry({ key_result: 'first' }))
      await mgr.register(makeEntry({ key_result: 'second' }))

      const log = mgr.load()
      expect(log.experiments).toHaveLength(1)
      expect(log.experiments[0].key_result).toBe('second')
    })

    test('appends entries with different IDs', async () => {
      await mgr.register(makeEntry({ id: 'probe-001' }))
      await mgr.register(makeEntry({ id: 'probe-002' }))

      const log = mgr.load()
      expect(log.experiments).toHaveLength(2)
    })
  })

  // -- updateStatus --

  describe('updateStatus', () => {
    test('merges partial updates', async () => {
      await mgr.register(makeEntry({ status: 'running', key_result: null }))
      await mgr.updateStatus('probe-001-test', {
        status: 'completed',
        key_result: 'done',
        duration_seconds: 42,
      })

      const entry = mgr.getExperiment('probe-001-test')!
      expect(entry.status).toBe('completed')
      expect(entry.key_result).toBe('done')
      expect(entry.duration_seconds).toBe(42)
      // untouched fields preserved
      expect(entry.purpose).toBe('sanity check')
    })

    test('silently ignores unknown ID', async () => {
      await mgr.register(makeEntry())
      // should not throw
      await mgr.updateStatus('nonexistent-id', { status: 'failed' })
      // original entry untouched
      expect(mgr.getExperiment('probe-001-test')!.status).toBe('completed')
    })
  })

  // -- getExperiment --

  describe('getExperiment', () => {
    test('returns entry by ID', async () => {
      await mgr.register(makeEntry())
      const entry = mgr.getExperiment('probe-001-test')
      expect(entry).not.toBeNull()
      expect(entry!.id).toBe('probe-001-test')
    })

    test('returns null for unknown ID', () => {
      expect(mgr.getExperiment('nope')).toBeNull()
    })
  })

  // -- getSummaries --

  describe('getSummaries', () => {
    test('returns only completed entries', async () => {
      await mgr.register(makeEntry({ id: 'probe-001', status: 'completed' }))
      await mgr.register(makeEntry({ id: 'probe-002', status: 'running' }))
      await mgr.register(makeEntry({ id: 'probe-003', status: 'failed' }))

      const summaries = mgr.getSummaries()
      expect(summaries).toHaveLength(1)
      expect(summaries[0].id).toBe('probe-001')
    })

    test('returns correct shape without extra fields', async () => {
      await mgr.register(makeEntry())
      const summaries = mgr.getSummaries()
      const keys = Object.keys(summaries[0]).sort()
      expect(keys).toEqual(
        [
          'created_at',
          'id',
          'key_result',
          'purpose',
          'targets_claim',
          'tier',
        ].sort(),
      )
    })

    test('returns empty array when none completed', async () => {
      await mgr.register(makeEntry({ id: 'probe-001', status: 'running' }))
      expect(mgr.getSummaries()).toEqual([])
    })
  })

  // -- getNextNumber --

  describe('getNextNumber', () => {
    test('returns 1 when log is empty', () => {
      expect(mgr.getNextNumber('probes')).toBe(1)
      expect(mgr.getNextNumber('runs')).toBe(1)
    })

    test('returns 1 when no matching type exists', async () => {
      await mgr.register(makeEntry({ id: 'run-005-baseline' }))
      expect(mgr.getNextNumber('probes')).toBe(1)
    })

    test('returns max+1 for probes', async () => {
      await mgr.register(makeEntry({ id: 'probe-003-sanity' }))
      await mgr.register(makeEntry({ id: 'probe-007-deep' }))
      expect(mgr.getNextNumber('probes')).toBe(8)
    })

    test('returns max+1 for runs', async () => {
      await mgr.register(makeEntry({ id: 'run-001-baseline' }))
      await mgr.register(makeEntry({ id: 'run-002-ablation' }))
      expect(mgr.getNextNumber('runs')).toBe(3)
    })

    test('handles leading zeros (probe-010 -> 11)', async () => {
      await mgr.register(makeEntry({ id: 'probe-010-padded' }))
      expect(mgr.getNextNumber('probes')).toBe(11)
    })

    test('ignores non-matching IDs', async () => {
      await mgr.register(makeEntry({ id: 'probe-005-test' }))
      await mgr.register(makeEntry({ id: 'custom-id-no-match' }))
      await mgr.register(makeEntry({ id: 'run-003-baseline' }))
      expect(mgr.getNextNumber('probes')).toBe(6)
      expect(mgr.getNextNumber('runs')).toBe(4)
    })
  })
})
