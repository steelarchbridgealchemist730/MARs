import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AuditCheck,
  AuditResult,
  SemanticAuditResult,
  FullAuditResult,
  ExperimentMeta,
} from './types'

export type CommandRunner = (
  command: string,
  cwd: string,
) => Promise<{ exitCode: number; output: string }>

async function defaultCommandRunner(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(['bash', '-c', command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  const exitCode = await proc.exited
  const output = (stdout + '\n' + stderr).trim()
  return { exitCode, output }
}

/**
 * Collect all .py files recursively from the given directories.
 */
export function collectPyFiles(baseDirs: string[]): string[] {
  const files: string[] = []
  for (const dir of baseDirs) {
    if (!existsSync(dir)) continue
    try {
      const entries = readdirSync(dir, { recursive: true, withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.py')) {
          // entry.parentPath is the full parent path when recursive: true
          files.push(join(entry.parentPath, entry.name))
        }
      }
    } catch {
      // Directory not readable, skip
    }
  }
  return files
}

/**
 * Pre-execution static auditor for Tier 2 experiments.
 * Runs 5 checks (2 external commands + 3 file pattern scans) and produces an AuditResult.
 */
export class ExperimentAuditor {
  private runCommand: CommandRunner

  constructor(
    private projectDir: string,
    commandRunner?: CommandRunner,
  ) {
    this.runCommand = commandRunner ?? defaultCommandRunner
  }

  async staticAudit(experimentDir: string): Promise<AuditResult> {
    const checks: AuditCheck[] = []

    // 1. ruff_lint
    checks.push(await this.checkRuff(experimentDir))

    // 2. unit_tests
    checks.push(await this.checkTests(experimentDir))

    // 3. reproducibility_seed
    checks.push(this.checkReproducibilitySeed(experimentDir))

    // 4. data_leakage
    checks.push(this.checkDataLeakage(experimentDir))

    // 5. output_format
    checks.push(this.checkOutputFormat(experimentDir))

    return {
      passed: checks.every(c => c.passed),
      checks,
      timestamp: new Date().toISOString(),
    }
  }

  async saveAudit(
    experimentDir: string,
    staticResult: AuditResult,
    semanticResult?: SemanticAuditResult,
  ): Promise<void> {
    const metaPath = join(experimentDir, 'meta.json')
    let experimentId = 'unknown'
    if (existsSync(metaPath)) {
      try {
        const meta: ExperimentMeta = JSON.parse(readFileSync(metaPath, 'utf-8'))
        experimentId = meta.id
      } catch {
        // Use default
      }
    }

    const result: FullAuditResult = {
      experiment_id: experimentId,
      audit_timestamp: new Date().toISOString(),
      static_audit: staticResult,
      ...(semanticResult ? { semantic_audit: semanticResult } : {}),
    }

    await Bun.write(
      join(experimentDir, 'audit.json'),
      JSON.stringify(result, null, 2) + '\n',
    )
  }

  private async checkRuff(experimentDir: string): Promise<AuditCheck> {
    try {
      const { exitCode, output } = await this.runCommand(
        'uv run ruff check src/ 2>&1',
        experimentDir,
      )
      return {
        name: 'ruff_lint',
        passed: exitCode === 0,
        details:
          output || (exitCode === 0 ? 'No issues found' : 'Ruff check failed'),
      }
    } catch {
      return {
        name: 'ruff_lint',
        passed: false,
        details: 'Failed to run ruff',
      }
    }
  }

  private async checkTests(experimentDir: string): Promise<AuditCheck> {
    try {
      const { exitCode, output } = await this.runCommand(
        'uv run pytest tests/ -v --tb=short 2>&1',
        experimentDir,
      )
      return {
        name: 'unit_tests',
        passed: exitCode === 0,
        details:
          output || (exitCode === 0 ? 'All tests passed' : 'Tests failed'),
      }
    } catch {
      return {
        name: 'unit_tests',
        passed: false,
        details: 'Failed to run pytest',
      }
    }
  }

  private checkReproducibilitySeed(experimentDir: string): AuditCheck {
    const pyFiles = collectPyFiles([
      join(experimentDir, 'src'),
      join(experimentDir, 'scripts'),
    ])

    const seedPattern =
      /(?:random\.seed|np\.random\.seed|torch\.manual_seed|seed\s*=|set_seed)\s*\(/i

    const matches: string[] = []
    for (const filePath of pyFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (seedPattern.test(lines[i])) {
            matches.push(`${filePath}:${i + 1}: ${lines[i].trim()}`)
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return {
      name: 'reproducibility_seed',
      passed: matches.length > 0,
      details:
        matches.length > 0 ? matches.join('\n') : 'No seed setting found',
    }
  }

  private checkDataLeakage(experimentDir: string): AuditCheck {
    const pyFiles = collectPyFiles([
      join(experimentDir, 'src'),
      join(experimentDir, 'scripts'),
    ])

    const leakagePatterns = [
      /scaler\.fit\(.*(?:full|all|entire|complete)/i,
      /test.*(?:merge|join|concat).*(?:feature|train)/i,
      /shift\s*\(\s*-/,
    ]

    const matches: string[] = []
    for (const filePath of pyFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          for (const pattern of leakagePatterns) {
            if (pattern.test(lines[i])) {
              matches.push(`${filePath}:${i + 1}: ${lines[i].trim()}`)
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return {
      name: 'data_leakage',
      passed: matches.length === 0,
      details:
        matches.length > 0
          ? matches.join('\n')
          : 'No data leakage patterns detected',
    }
  }

  private checkOutputFormat(experimentDir: string): AuditCheck {
    const pyFiles = collectPyFiles([
      join(experimentDir, 'src'),
      join(experimentDir, 'scripts'),
    ])

    const outputPattern = /metrics\.json|json\.dump|json\.dumps|to_json/

    const matches: string[] = []
    for (const filePath of pyFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (outputPattern.test(lines[i])) {
            matches.push(`${filePath}:${i + 1}: ${lines[i].trim()}`)
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return {
      name: 'output_format',
      passed: matches.length > 0,
      details:
        matches.length > 0 ? matches.join('\n') : 'No structured output found',
    }
  }
}
