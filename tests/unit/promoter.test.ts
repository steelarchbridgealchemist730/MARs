import { describe, test, expect } from 'bun:test'
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CreateExperiment,
  ExperimentLogManager,
  ExperimentPromoter,
} from '../../src/paper/experiments/index'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'promoter-test-'))
}

/**
 * Creates a fake completed probe with .py files, meta.json, and log entry.
 */
async function createFakeProbe(
  projectDir: string,
  opts?: { withConfig?: boolean },
): Promise<{ probeId: string; probeDir: string }> {
  const creator = new CreateExperiment(projectDir)
  const { id, dir } = await creator.execute({
    name: 'garch-sanity',
    tier: 1,
    purpose: 'quick validation of GARCH fit',
    targets_claim: 'claim-vol-1',
  })

  // Write Python files
  await Bun.write(join(dir, 'probe.py'), 'import numpy as np\nprint("probe")\n')
  await Bun.write(join(dir, 'helpers.py'), 'def helper():\n    return 42\n')

  // Optionally write config.yaml
  if (opts?.withConfig) {
    await Bun.write(join(dir, 'config.yaml'), 'epochs: 10\nlr: 0.001\n')
  }

  // Write results
  mkdirSync(join(dir, 'results'), { recursive: true })
  await Bun.write(
    join(dir, 'results', 'metrics.json'),
    JSON.stringify({ experiment_id: id, seed: 42, models: {} }),
  )

  // Mark as completed in meta.json
  const metaPath = join(dir, 'meta.json')
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
  meta.status = 'completed'
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')

  // Mark as completed in experiment log
  const logMgr = new ExperimentLogManager(projectDir)
  await logMgr.updateStatus(id, { status: 'completed' })

  return { probeId: id, probeDir: dir }
}

// ── ExperimentPromoter ─────────────────────────────────────────────

describe('ExperimentPromoter', () => {
  test('run ID follows run-NNN-{slug} pattern under experiments/runs/', async () => {
    const proj = makeTmpDir()
    const { probeId } = await createFakeProbe(proj)
    const promoter = new ExperimentPromoter(proj)

    const { runId, runDir } = await promoter.promoteToRun(probeId)

    expect(runId).toBe('run-001-garch-sanity')
    expect(runDir).toContain(
      join('experiments', 'runs', 'run-001-garch-sanity'),
    )
  })

  test('scripts/run.py content matches original probe.py', async () => {
    const proj = makeTmpDir()
    const { probeId, probeDir } = await createFakeProbe(proj)
    const promoter = new ExperimentPromoter(proj)

    const { runDir } = await promoter.promoteToRun(probeId)

    const original = readFileSync(join(probeDir, 'probe.py'), 'utf-8')
    const copied = readFileSync(join(runDir, 'scripts', 'run.py'), 'utf-8')
    expect(copied).toBe(original)
  })

  test('other .py files copied to scripts/ with original names', async () => {
    const proj = makeTmpDir()
    const { probeId } = await createFakeProbe(proj)
    const promoter = new ExperimentPromoter(proj)

    const { runDir } = await promoter.promoteToRun(probeId)

    expect(existsSync(join(runDir, 'scripts', 'helpers.py'))).toBe(true)
    const content = readFileSync(join(runDir, 'scripts', 'helpers.py'), 'utf-8')
    expect(content).toContain('def helper()')
  })

  test('src/ has skeleton files with TODO comments', async () => {
    const proj = makeTmpDir()
    const { probeId } = await createFakeProbe(proj)
    const promoter = new ExperimentPromoter(proj)

    const { runDir } = await promoter.promoteToRun(probeId)

    expect(existsSync(join(runDir, 'src', '__init__.py'))).toBe(true)

    const models = readFileSync(join(runDir, 'src', 'models.py'), 'utf-8')
    expect(models).toContain('TODO: Extract model code from scripts/run.py')

    const data = readFileSync(join(runDir, 'src', 'data.py'), 'utf-8')
    expect(data).toContain('TODO: Extract data loading code')

    const evaluate = readFileSync(join(runDir, 'src', 'evaluate.py'), 'utf-8')
    expect(evaluate).toContain('TODO: Extract evaluation code')
  })

  test('tests/test_models.py exists with TODO', async () => {
    const proj = makeTmpDir()
    const { probeId } = await createFakeProbe(proj)
    const promoter = new ExperimentPromoter(proj)

    const { runDir } = await promoter.promoteToRun(probeId)

    const testFile = readFileSync(
      join(runDir, 'tests', 'test_models.py'),
      'utf-8',
    )
    expect(testFile).toContain('TODO: Write model tests')
  })

  test('config.yaml copied to configs/main.yaml when present', async () => {
    const proj = makeTmpDir()
    const { probeId } = await createFakeProbe(proj, { withConfig: true })
    const promoter = new ExperimentPromoter(proj)

    const { runDir } = await promoter.promoteToRun(probeId)

    const config = readFileSync(join(runDir, 'configs', 'main.yaml'), 'utf-8')
    expect(config).toContain('epochs: 10')
    expect(config).toContain('lr: 0.001')
  })

  test('config copy skipped when absent', async () => {
    const proj = makeTmpDir()
    const { probeId } = await createFakeProbe(proj)
    const promoter = new ExperimentPromoter(proj)

    const { runDir } = await promoter.promoteToRun(probeId)

    // configs/ dir exists (created by environment.create) but main.yaml absent
    expect(existsSync(join(runDir, 'configs'))).toBe(true)
    expect(existsSync(join(runDir, 'configs', 'main.yaml'))).toBe(false)
  })

  test('REPRODUCE.md exists and references both probe and run IDs', async () => {
    const proj = makeTmpDir()
    const { probeId } = await createFakeProbe(proj)
    const promoter = new ExperimentPromoter(proj)

    const { runId, runDir } = await promoter.promoteToRun(probeId)

    const reproduce = readFileSync(join(runDir, 'REPRODUCE.md'), 'utf-8')
    expect(reproduce).toContain(probeId)
    expect(reproduce).toContain(runId)
  })

  test('probe meta.json updated with promoted_to_run', async () => {
    const proj = makeTmpDir()
    const { probeId, probeDir } = await createFakeProbe(proj)
    const promoter = new ExperimentPromoter(proj)

    const { runId } = await promoter.promoteToRun(probeId)

    const meta = JSON.parse(readFileSync(join(probeDir, 'meta.json'), 'utf-8'))
    expect(meta.promoted_to_run).toBe(runId)
  })

  test('experiment log has new run entry with tier 2, status created, inherited purpose', async () => {
    const proj = makeTmpDir()
    const { probeId } = await createFakeProbe(proj)
    const promoter = new ExperimentPromoter(proj)

    const { runId } = await promoter.promoteToRun(probeId)

    const logMgr = new ExperimentLogManager(proj)
    const entry = logMgr.getExperiment(runId)
    expect(entry).not.toBeNull()
    expect(entry!.tier).toBe(2)
    expect(entry!.status).toBe('created')
    expect(entry!.purpose).toBe('quick validation of GARCH fit')
    expect(entry!.targets_claim).toBe('claim-vol-1')
  })

  test('throws on nonexistent probe', async () => {
    const proj = makeTmpDir()
    const promoter = new ExperimentPromoter(proj)

    expect(() => promoter.promoteToRun('probe-999-nope')).toThrow(
      'Probe not found: probe-999-nope',
    )
  })

  test('throws on non-completed probe', async () => {
    const proj = makeTmpDir()
    const creator = new CreateExperiment(proj)
    await creator.execute({
      name: 'incomplete',
      tier: 1,
      purpose: 'test',
      targets_claim: 'c1',
    })

    const promoter = new ExperimentPromoter(proj)
    expect(() => promoter.promoteToRun('probe-001-incomplete')).toThrow(
      'status "created", expected "completed"',
    )
  })

  test('run meta.json written with correct fields', async () => {
    const proj = makeTmpDir()
    const { probeId } = await createFakeProbe(proj)
    const promoter = new ExperimentPromoter(proj)

    const { runId, runDir } = await promoter.promoteToRun(probeId)

    const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf-8'))
    expect(meta.id).toBe(runId)
    expect(meta.tier).toBe(2)
    expect(meta.purpose).toBe('quick validation of GARCH fit')
    expect(meta.targets_claim).toBe('claim-vol-1')
    expect(meta.created_by).toBe('promoter')
    expect(meta.status).toBe('created')
    expect(meta.seed).toBe(42)
    expect(meta.created_at).toBeTruthy()
  })
})
