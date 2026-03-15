import { existsSync } from 'fs'
import { join } from 'path'

export const COMMIT_POINTS = {
  RESEARCH_DONE: (n: number) => `Literature review completed (${n} papers)`,
  PROPOSAL_SELECTED: (title: string) => `Selected: ${title}`,
  EXPERIMENT_CODE: 'Initial experiment code',
  EXPERIMENT_RESULTS: (name: string) => `Results for ${name}`,
  PAPER_DRAFT: 'First draft',
  REVISION: (round: number, issues: number) =>
    `Round ${round}: addressed ${issues} issues`,
  FINAL: 'Camera-ready version',
}

export class GitManager {
  private projectDir: string

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  private async runGit(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(['git', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: this.projectDir,
    })

    await proc.exited

    let stdout = ''
    let stderr = ''
    try {
      stdout = await new Response(proc.stdout as ReadableStream).text()
    } catch {
      // best effort
    }
    try {
      stderr = await new Response(proc.stderr as ReadableStream).text()
    } catch {
      // best effort
    }

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: proc.exitCode ?? 0,
    }
  }

  async init(): Promise<void> {
    const gitDir = join(this.projectDir, '.git')
    if (existsSync(gitDir)) {
      return
    }
    const result = await this.runGit(['init'])
    if (result.exitCode !== 0) {
      throw new Error(`git init failed: ${result.stderr}`)
    }
  }

  async autoCommit(stage: string, message: string): Promise<void> {
    // Stage all changes
    const addResult = await this.runGit(['add', '-A'])
    if (addResult.exitCode !== 0) {
      throw new Error(`git add failed: ${addResult.stderr}`)
    }

    const commitMessage = `[${stage}] ${message}`
    const commitResult = await this.runGit(['commit', '-m', commitMessage])
    if (commitResult.exitCode !== 0) {
      // If nothing to commit, that's not a hard failure
      if (
        commitResult.stdout.includes('nothing to commit') ||
        commitResult.stderr.includes('nothing to commit')
      ) {
        return
      }
      throw new Error(`git commit failed: ${commitResult.stderr}`)
    }
  }

  async hasUncommitted(): Promise<boolean> {
    const result = await this.runGit(['status', '--porcelain'])
    return result.stdout.length > 0
  }
}
