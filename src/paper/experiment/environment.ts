import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import type { IsolationMode } from './types'

export class ExperimentEnvironment {
  private projectDir: string
  private preferDocker: boolean

  constructor(projectDir: string, preferDocker = false) {
    this.projectDir = projectDir
    this.preferDocker = preferDocker
  }

  async detectIsolation(): Promise<IsolationMode> {
    // Try uv first (lightweight, fast)
    try {
      const uvProc = Bun.spawn(['uv', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await uvProc.exited
      if (uvProc.exitCode === 0) {
        return 'uv'
      }
    } catch {
      // uv not available
    }

    // Docker as strong isolation option (if preferred or uv unavailable)
    if (this.preferDocker) {
      try {
        const dockerProc = Bun.spawn(['docker', 'info'], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        await dockerProc.exited
        if (dockerProc.exitCode === 0) {
          return 'docker'
        }
      } catch {
        // docker not available
      }
    }

    // Try venv
    try {
      const venvProc = Bun.spawn(['python3', '-m', 'venv', '--help'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await venvProc.exited
      if (venvProc.exitCode === 0) {
        return 'venv'
      }
    } catch {
      // venv not available
    }

    return 'none'
  }

  async setup(dependencies: string[]): Promise<void> {
    const mode = await this.detectIsolation()
    const experimentsDir = join(this.projectDir, 'experiments')

    if (mode === 'uv') {
      const initProc = Bun.spawn(
        ['uv', 'init', '--python', '3.11', experimentsDir],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: this.projectDir,
        },
      )
      await initProc.exited

      if (dependencies.length > 0) {
        const addProc = Bun.spawn(['uv', 'add', ...dependencies], {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: experimentsDir,
        })
        await addProc.exited
      }
    } else if (mode === 'docker') {
      await this.setupDocker(experimentsDir, dependencies)
    } else if (mode === 'venv') {
      const venvPath = join(experimentsDir, '.venv')
      const createProc = Bun.spawn(['python3', '-m', 'venv', venvPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await createProc.exited

      if (dependencies.length > 0) {
        const pipPath = join(venvPath, 'bin', 'pip')
        const installProc = Bun.spawn([pipPath, 'install', ...dependencies], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        await installProc.exited
      }
    } else {
      // no isolation -- install globally
      if (dependencies.length > 0) {
        const installProc = Bun.spawn(['pip', 'install', ...dependencies], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        await installProc.exited
      }
    }
  }

  private async setupDocker(
    experimentsDir: string,
    dependencies: string[],
  ): Promise<void> {
    const projectId = this.projectDir.replace(/[^a-z0-9]/gi, '-').slice(-30)
    const depsLine =
      dependencies.length > 0
        ? `RUN pip install --no-cache-dir ${dependencies.join(' ')}`
        : ''
    const dockerfile = [
      'FROM python:3.11-slim',
      'WORKDIR /workspace',
      depsLine,
      'COPY . /workspace/',
      'CMD ["python3", "main_experiment.py"]',
    ]
      .filter(Boolean)
      .join('\n')

    const dockerfilePath = join(experimentsDir, 'Dockerfile')
    if (!existsSync(dockerfilePath)) {
      writeFileSync(dockerfilePath, dockerfile + '\n', 'utf-8')
    }

    const buildProc = Bun.spawn(
      ['docker', 'build', '-t', `cpaper-exp-${projectId}`, '.'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: experimentsDir,
      },
    )
    await buildProc.exited
  }

  getRunCommand(script: string): string {
    const experimentsDir = join(this.projectDir, 'experiments')
    const venvPython = join(experimentsDir, '.venv', 'bin', 'python')
    return `${venvPython} ${script}`
  }
}
