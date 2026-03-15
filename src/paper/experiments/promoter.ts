import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ExperimentEnvironment } from './environment'
import { ExperimentLogManager } from './experiment-log'
import type { ExperimentMeta } from './types'

function pad3(n: number): string {
  return String(n).padStart(3, '0')
}

/**
 * Takes a completed Tier-1 probe and scaffolds a full Tier-2 run directory,
 * copying Python code, generating skeleton source files, and updating metadata.
 */
export class ExperimentPromoter {
  private environment: ExperimentEnvironment
  private logManager: ExperimentLogManager

  constructor(private projectDir: string) {
    this.environment = new ExperimentEnvironment(projectDir)
    this.logManager = new ExperimentLogManager(projectDir)
  }

  async promoteToRun(
    probeId: string,
  ): Promise<{ runId: string; runDir: string }> {
    // 1. Find & validate probe
    const probeEntry = this.logManager.getExperiment(probeId)
    if (!probeEntry) {
      throw new Error(`Probe not found: ${probeId}`)
    }
    if (probeEntry.status !== 'completed') {
      throw new Error(
        `Probe ${probeId} has status "${probeEntry.status}", expected "completed"`,
      )
    }

    // 2. Generate run ID from probe slug
    const slugMatch = /^probe-\d+-(.+)$/.exec(probeId)
    const slug = slugMatch ? slugMatch[1] : probeId
    const nextNum = this.logManager.getNextNumber('runs')
    const runId = `run-${pad3(nextNum)}-${slug}`

    // 3. Create Tier-2 directory
    const runDir = join(this.projectDir, 'experiments', 'runs', runId)
    await this.environment.create(runDir, 2)

    // 4. Copy .py files from probe dir
    const probeDir = join(this.projectDir, probeEntry.path)
    const probeFiles = readdirSync(probeDir)
    const pyFiles = probeFiles.filter(f => f.endsWith('.py'))

    for (const pyFile of pyFiles) {
      const content = readFileSync(join(probeDir, pyFile), 'utf-8')
      const destName = pyFile === 'probe.py' ? 'run.py' : pyFile
      await Bun.write(join(runDir, 'scripts', destName), content)
    }

    // 5. Copy config.yaml if present
    const configPath = join(probeDir, 'config.yaml')
    try {
      const configContent = readFileSync(configPath, 'utf-8')
      await Bun.write(join(runDir, 'configs', 'main.yaml'), configContent)
    } catch {
      // config.yaml not present — skip
    }

    // 6. Create src/ skeletons
    await Bun.write(join(runDir, 'src', '__init__.py'), '')
    await Bun.write(
      join(runDir, 'src', 'models.py'),
      '# TODO: Extract model code from scripts/run.py\n',
    )
    await Bun.write(
      join(runDir, 'src', 'data.py'),
      '# TODO: Extract data loading code\n',
    )
    await Bun.write(
      join(runDir, 'src', 'evaluate.py'),
      '# TODO: Extract evaluation code\n',
    )

    // 7. Create tests/ skeleton
    await Bun.write(
      join(runDir, 'tests', 'test_models.py'),
      '# TODO: Write model tests\n',
    )

    // 8. Generate REPRODUCE.md
    const reproduce = `# Reproduction Guide

## Origin
Promoted from probe \`${probeId}\`.

## Setup
\`\`\`bash
cd ${runId}
uv sync
\`\`\`

## Run
\`\`\`bash
uv run python scripts/run.py
\`\`\`

## Run ID
\`${runId}\`
`
    await Bun.write(join(runDir, 'REPRODUCE.md'), reproduce)

    // 9. Update probe meta.json
    const probeMetaPath = join(probeDir, 'meta.json')
    const probeMeta: ExperimentMeta = JSON.parse(
      readFileSync(probeMetaPath, 'utf-8'),
    )
    probeMeta.promoted_to_run = runId
    await Bun.write(probeMetaPath, JSON.stringify(probeMeta, null, 2) + '\n')

    // 10. Write run meta.json
    const runMeta: ExperimentMeta = {
      id: runId,
      tier: 2,
      purpose: probeEntry.purpose,
      targets_claim: probeEntry.targets_claim,
      created_at: new Date().toISOString(),
      created_by: 'promoter',
      status: 'created',
      seed: 42,
    }
    await Bun.write(
      join(runDir, 'meta.json'),
      JSON.stringify(runMeta, null, 2) + '\n',
    )

    // 11. Register run in experiment log
    await this.logManager.register({
      id: runId,
      tier: 2,
      status: 'created',
      purpose: probeEntry.purpose,
      targets_claim: probeEntry.targets_claim,
      key_result: null,
      created_at: runMeta.created_at,
      duration_seconds: null,
      path: relative(this.projectDir, runDir),
    })

    // 12. Return
    return { runId, runDir }
  }
}
