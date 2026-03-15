import { mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ExperimentEnvironment, slugify } from './environment'
import { ExperimentLogManager } from './experiment-log'
import type { ExperimentMeta } from './types'

function pad3(n: number): string {
  return String(n).padStart(3, '0')
}

/**
 * High-level workflow that composes ExperimentEnvironment + ExperimentLogManager
 * to create a new experiment directory with all scaffolding and metadata.
 */
export class CreateExperiment {
  private environment: ExperimentEnvironment
  private logManager: ExperimentLogManager

  constructor(private projectDir: string) {
    this.environment = new ExperimentEnvironment(projectDir)
    this.logManager = new ExperimentLogManager(projectDir)
  }

  async execute(params: {
    name: string
    tier: 1 | 2
    purpose: string
    targets_claim: string
  }): Promise<{ id: string; dir: string; message: string }> {
    const { name, tier, purpose, targets_claim } = params

    // 1. Generate ID
    const type = tier === 1 ? 'probes' : 'runs'
    const prefix = tier === 1 ? 'probe' : 'run'
    const nextNum = this.logManager.getNextNumber(type)
    const id = `${prefix}-${pad3(nextNum)}-${slugify(name)}`

    // 2. Compute directory
    const dir = join(this.projectDir, 'experiments', type, id)

    // 3. Create environment (dirs, pyproject, uv sync, env_snapshot)
    await this.environment.create(dir, tier)

    // 4. Write meta.json
    const meta: ExperimentMeta = {
      id,
      tier,
      purpose,
      targets_claim,
      created_at: new Date().toISOString(),
      created_by: 'orchestrator',
      status: 'created',
      seed: 42,
    }
    await Bun.write(
      join(dir, 'meta.json'),
      JSON.stringify(meta, null, 2) + '\n',
    )

    // 5. Register in experiment log
    await this.logManager.register({
      id,
      tier,
      status: 'created',
      purpose,
      targets_claim,
      key_result: null,
      created_at: meta.created_at,
      duration_seconds: null,
      path: relative(this.projectDir, dir),
    })

    // 6. Ensure shared directories exist
    mkdirSync(join(this.projectDir, 'experiments', 'shared', 'data'), {
      recursive: true,
    })
    mkdirSync(join(this.projectDir, 'experiments', 'shared', 'lib'), {
      recursive: true,
    })

    // 7. Return result
    return {
      id,
      dir,
      message: `Created tier-${tier} experiment: ${id}`,
    }
  }
}
