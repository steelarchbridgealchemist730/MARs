import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ExperimentAuditor,
  collectPyFiles,
} from '../../src/paper/experiments/index'
import type { CommandRunner } from '../../src/paper/experiments/auditor'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'auditor-test-'))
}

function makeExpDir(): string {
  const tmp = makeTmpDir()
  const expDir = join(tmp, 'run-001-test')
  mkdirSync(join(expDir, 'src'), { recursive: true })
  mkdirSync(join(expDir, 'scripts'), { recursive: true })
  mkdirSync(join(expDir, 'tests'), { recursive: true })
  return expDir
}

function successRunner(): CommandRunner {
  return async () => ({ exitCode: 0, output: 'All good' })
}

function failRunner(): CommandRunner {
  return async () => ({ exitCode: 1, output: 'Some errors found' })
}

// ── collectPyFiles ──────────────────────────────────────────────

describe('collectPyFiles', () => {
  test('finds .py files recursively', () => {
    const expDir = makeExpDir()
    writeFileSync(join(expDir, 'src', 'main.py'), 'print("hello")')
    mkdirSync(join(expDir, 'src', 'sub'), { recursive: true })
    writeFileSync(join(expDir, 'src', 'sub', 'util.py'), 'pass')
    writeFileSync(join(expDir, 'src', 'readme.txt'), 'not python')

    const files = collectPyFiles([join(expDir, 'src')])
    expect(files).toHaveLength(2)
    expect(files.every(f => f.endsWith('.py'))).toBe(true)
  })

  test('returns empty for nonexistent dirs', () => {
    expect(collectPyFiles(['/nonexistent/path'])).toEqual([])
  })

  test('skips non-.py files', () => {
    const expDir = makeExpDir()
    writeFileSync(join(expDir, 'src', 'data.csv'), 'a,b')
    writeFileSync(join(expDir, 'src', 'config.yaml'), 'key: val')

    expect(collectPyFiles([join(expDir, 'src')])).toEqual([])
  })
})

// ── reproducibility_seed ────────────────────────────────────────

describe('reproducibility_seed check', () => {
  test('passes when seed is set (np.random.seed)', async () => {
    const expDir = makeExpDir()
    writeFileSync(
      join(expDir, 'src', 'main.py'),
      'import numpy as np\nnp.random.seed(42)\nprint("ok")',
    )

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'reproducibility_seed')!
    expect(check.passed).toBe(true)
    expect(check.details).toContain('np.random.seed(42)')
  })

  test('passes when seed is set (torch.manual_seed)', async () => {
    const expDir = makeExpDir()
    writeFileSync(
      join(expDir, 'src', 'main.py'),
      'import torch\ntorch.manual_seed(123)',
    )

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'reproducibility_seed')!
    expect(check.passed).toBe(true)
  })

  test('passes when set_seed is used', async () => {
    const expDir = makeExpDir()
    writeFileSync(
      join(expDir, 'src', 'main.py'),
      'from utils import set_seed\nset_seed(42)',
    )

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'reproducibility_seed')!
    expect(check.passed).toBe(true)
  })

  test('fails when no seed setting found', async () => {
    const expDir = makeExpDir()
    writeFileSync(join(expDir, 'src', 'main.py'), 'import numpy\nprint("ok")')

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'reproducibility_seed')!
    expect(check.passed).toBe(false)
    expect(check.details).toBe('No seed setting found')
  })
})

// ── output_format ───────────────────────────────────────────────

describe('output_format check', () => {
  test('passes when json.dump is present', async () => {
    const expDir = makeExpDir()
    writeFileSync(
      join(expDir, 'src', 'main.py'),
      'import json\njson.dump(results, f)',
    )

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'output_format')!
    expect(check.passed).toBe(true)
    expect(check.details).toContain('json.dump')
  })

  test('passes when metrics.json is referenced', async () => {
    const expDir = makeExpDir()
    writeFileSync(
      join(expDir, 'src', 'main.py'),
      'with open("results/metrics.json", "w") as f:',
    )

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'output_format')!
    expect(check.passed).toBe(true)
  })

  test('fails when no structured output found', async () => {
    const expDir = makeExpDir()
    writeFileSync(join(expDir, 'src', 'main.py'), 'print("results: ok")')

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'output_format')!
    expect(check.passed).toBe(false)
    expect(check.details).toBe('No structured output found')
  })
})

// ── data_leakage ────────────────────────────────────────────────

describe('data_leakage check', () => {
  test('fails when scaler.fit on full data detected', async () => {
    const expDir = makeExpDir()
    writeFileSync(
      join(expDir, 'src', 'main.py'),
      'scaler.fit(full_data)\nscaler.transform(test)',
    )

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'data_leakage')!
    expect(check.passed).toBe(false)
    expect(check.details).toContain('scaler.fit(full_data)')
  })

  test('fails when shift(-N) detected', async () => {
    const expDir = makeExpDir()
    writeFileSync(
      join(expDir, 'src', 'main.py'),
      'df["feature"] = df["target"].shift( -1)',
    )

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'data_leakage')!
    expect(check.passed).toBe(false)
  })

  test('passes when no leakage patterns found', async () => {
    const expDir = makeExpDir()
    writeFileSync(
      join(expDir, 'src', 'main.py'),
      'scaler.fit(X_train)\nscaler.transform(X_test)',
    )

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'data_leakage')!
    expect(check.passed).toBe(true)
    expect(check.details).toBe('No data leakage patterns detected')
  })
})

// ── ruff + pytest (via command runner) ──────────────────────────

describe('ruff_lint check', () => {
  test('passes when command runner returns exit 0', async () => {
    const expDir = makeExpDir()
    writeFileSync(join(expDir, 'src', 'main.py'), 'pass')

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'ruff_lint')!
    expect(check.passed).toBe(true)
  })

  test('fails when command runner returns non-zero exit', async () => {
    const expDir = makeExpDir()
    writeFileSync(join(expDir, 'src', 'main.py'), 'pass')

    const auditor = new ExperimentAuditor(expDir, failRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'ruff_lint')!
    expect(check.passed).toBe(false)
  })
})

describe('unit_tests check', () => {
  test('passes when command runner returns exit 0', async () => {
    const expDir = makeExpDir()
    writeFileSync(join(expDir, 'src', 'main.py'), 'pass')

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'unit_tests')!
    expect(check.passed).toBe(true)
  })

  test('fails when command runner returns non-zero exit', async () => {
    const expDir = makeExpDir()
    writeFileSync(join(expDir, 'src', 'main.py'), 'pass')

    const auditor = new ExperimentAuditor(expDir, failRunner())
    const result = await auditor.staticAudit(expDir)
    const check = result.checks.find(c => c.name === 'unit_tests')!
    expect(check.passed).toBe(false)
  })
})

// ── overall result ──────────────────────────────────────────────

describe('staticAudit overall', () => {
  test('passed=true when all checks pass', async () => {
    const expDir = makeExpDir()
    writeFileSync(
      join(expDir, 'src', 'main.py'),
      'import numpy as np\nnp.random.seed(42)\nimport json\njson.dump({}, open("metrics.json","w"))',
    )

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    expect(result.passed).toBe(true)
    expect(result.checks).toHaveLength(5)
    expect(result.timestamp).toBeTruthy()
  })

  test('passed=false when any check fails', async () => {
    const expDir = makeExpDir()
    // No seed, no output format → 2 checks fail
    writeFileSync(join(expDir, 'src', 'main.py'), 'print("hello")')

    const auditor = new ExperimentAuditor(expDir, successRunner())
    const result = await auditor.staticAudit(expDir)
    expect(result.passed).toBe(false)
  })
})

// ── saveAudit ───────────────────────────────────────────────────

describe('saveAudit', () => {
  test('creates audit.json with correct structure', async () => {
    const expDir = makeExpDir()

    // Write meta.json
    const meta = { id: 'run-001-test', tier: 2 }
    writeFileSync(join(expDir, 'meta.json'), JSON.stringify(meta))

    const auditResult = {
      passed: true,
      checks: [{ name: 'ruff_lint', passed: true, details: 'OK' }],
      timestamp: '2026-03-14T00:00:00Z',
    }

    const auditor = new ExperimentAuditor(expDir)
    await auditor.saveAudit(expDir, auditResult)

    const written = JSON.parse(
      readFileSync(join(expDir, 'audit.json'), 'utf-8'),
    )
    expect(written.experiment_id).toBe('run-001-test')
    expect(written.audit_timestamp).toBeTruthy()
    expect(written.static_audit).toEqual(auditResult)
    expect(written.semantic_audit).toBeUndefined()
  })

  test('includes semantic_audit when provided', async () => {
    const expDir = makeExpDir()
    writeFileSync(
      join(expDir, 'meta.json'),
      JSON.stringify({ id: 'run-002-test' }),
    )

    const staticResult = {
      passed: true,
      checks: [],
      timestamp: '2026-03-14T00:00:00Z',
    }
    const semanticResult = {
      overall_assessment: 'pass' as const,
      issues: [],
      positive_notes: ['Good reproducibility'],
    }

    const auditor = new ExperimentAuditor(expDir)
    await auditor.saveAudit(expDir, staticResult, semanticResult)

    const written = JSON.parse(
      readFileSync(join(expDir, 'audit.json'), 'utf-8'),
    )
    expect(written.semantic_audit).toEqual(semanticResult)
  })

  test('uses "unknown" when meta.json is missing', async () => {
    const expDir = makeExpDir()

    const auditor = new ExperimentAuditor(expDir)
    await auditor.saveAudit(expDir, {
      passed: true,
      checks: [],
      timestamp: '2026-03-14T00:00:00Z',
    })

    const written = JSON.parse(
      readFileSync(join(expDir, 'audit.json'), 'utf-8'),
    )
    expect(written.experiment_id).toBe('unknown')
  })
})
