/**
 * @deprecated This module is dead code. The orchestrator now uses
 * agent-dispatch with the experiment-runner agent instead.
 * The new experiment system lives in `src/paper/experiments/` (plural).
 * Retained temporarily for reference; will be removed in a future cleanup.
 */
import { join } from 'path'
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs'
import type { ExperimentPlan, ExperimentRun } from './types'
import { ExperimentEnvironment } from './environment'
import { chatCompletion } from '../llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'

const MAX_RETRIES = 3

function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const METRIC_PATTERNS: Array<{ key: string; pattern: RegExp }> = [
  { key: 'accuracy', pattern: /accuracy[:\s]+([0-9.]+)/i },
  { key: 'loss', pattern: /loss[:\s]+([0-9.]+)/i },
  { key: 'mse', pattern: /mse[:\s]+([0-9.]+)/i },
  { key: 'mae', pattern: /mae[:\s]+([0-9.]+)/i },
  { key: 'rmse', pattern: /rmse[:\s]+([0-9.]+)/i },
  { key: 'f1', pattern: /f1[:\s]+([0-9.]+)/i },
  { key: 'auc', pattern: /auc[:\s]+([0-9.]+)/i },
  { key: 'r2', pattern: /r2[:\s]+([0-9.]+)/i },
  { key: 'precision', pattern: /precision[:\s]+([0-9.]+)/i },
  { key: 'recall', pattern: /recall[:\s]+([0-9.]+)/i },
]

function extractMetrics(lines: string[]): Record<string, number | string> {
  const metrics: Record<string, number | string> = {}
  for (const line of lines) {
    for (const { key, pattern } of METRIC_PATTERNS) {
      const match = line.match(pattern)
      if (match && match[1] !== undefined) {
        const val = parseFloat(match[1])
        if (!isNaN(val)) {
          metrics[key] = val
        }
      }
    }
  }
  return metrics
}

function isOOMError(error: string): boolean {
  const oomPatterns = [
    /out of memory/i,
    /CUDA out of memory/i,
    /OOM/,
    /RuntimeError: CUDA error/i,
    /MemoryError/i,
    /torch\.cuda\.OutOfMemoryError/i,
    /Cannot allocate memory/i,
  ]
  return oomPatterns.some(p => p.test(error))
}

export class ExperimentRunner {
  private projectDir: string

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async run(
    plan: ExperimentPlan,
    onOutput: (line: string) => void,
  ): Promise<ExperimentRun> {
    const experimentsDir = join(this.projectDir, 'experiments')
    const runsDir = join(experimentsDir, '.checkpoints')

    mkdirSync(runsDir, { recursive: true })
    mkdirSync(experimentsDir, { recursive: true })

    // Persist plan for resume support
    this.savePlan(plan)

    // Setup environment
    const env = new ExperimentEnvironment(this.projectDir)
    try {
      onOutput('[setup] Installing dependencies...')
      await env.setup(plan.dependencies)
      onOutput('[setup] Environment ready.')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const run: ExperimentRun = {
        id: generateRunId(),
        plan_id: plan.id,
        status: 'failed',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        output_files: [],
        metrics: {},
        error: `Environment setup failed: ${msg}`,
      }
      this.saveRun(runsDir, run)
      return run
    }

    // Ensure placeholder scripts exist
    for (const script of plan.scripts) {
      const scriptPath = join(experimentsDir, script.filename)
      if (!existsSync(scriptPath)) {
        const placeholder = this.buildPlaceholderScript(plan, script)
        writeFileSync(scriptPath, placeholder, 'utf-8')
        onOutput(`[setup] Created placeholder script: ${script.filename}`)
      }
    }

    if (plan.scripts.length === 0) {
      const run: ExperimentRun = {
        id: generateRunId(),
        plan_id: plan.id,
        status: 'failed',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        output_files: [],
        metrics: {},
        error: 'No scripts defined in experiment plan.',
      }
      this.saveRun(runsDir, run)
      return run
    }

    // Retry loop (up to MAX_RETRIES attempts, per spec/agents/experiment-runner.md)
    let lastRun: ExperimentRun | null = null
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 1) {
        onOutput(`[retry] Attempt ${attempt}/${MAX_RETRIES}...`)
      }

      lastRun = await this.executeScript(plan, env, runsDir, onOutput)

      if (lastRun.status === 'completed') {
        return lastRun
      }

      // Check for OOM -- attempt batch size reduction
      if (lastRun.error && isOOMError(lastRun.error) && attempt < MAX_RETRIES) {
        onOutput(
          '[retry] OOM detected. Attempting batch size reduction in script...',
        )
        await this.patchOOMFix(plan, experimentsDir, onOutput)
        continue
      }

      // For non-OOM failures, attempt auto-fix via LLM
      if (lastRun.error && attempt < MAX_RETRIES) {
        onOutput('[retry] Attempting auto-fix via LLM...')
        const fixed = await this.attemptAutoFix(
          plan,
          experimentsDir,
          lastRun.error,
          lastRun.logs_path,
          onOutput,
        )
        if (!fixed) {
          onOutput('[retry] Auto-fix failed, stopping retries.')
          break
        }
        continue
      }
    }

    return lastRun!
  }

  private async executeScript(
    plan: ExperimentPlan,
    env: ExperimentEnvironment,
    runsDir: string,
    onOutput: (line: string) => void,
  ): Promise<ExperimentRun> {
    const runId = generateRunId()
    const experimentsDir = join(this.projectDir, 'experiments')
    const firstScript = plan.scripts[0]
    const scriptPath = join(experimentsDir, firstScript.filename)
    const logsPath = join(runsDir, `${runId}.log`)

    const run: ExperimentRun = {
      id: runId,
      plan_id: plan.id,
      status: 'running',
      started_at: new Date().toISOString(),
      output_files: [],
      metrics: {},
      logs_path: logsPath,
    }

    const outputLines: string[] = []

    // Determine python interpreter
    const isolation = await env.detectIsolation()
    let pythonBin = 'python3'
    if (isolation === 'venv') {
      const venvPython = join(experimentsDir, '.venv', 'bin', 'python')
      if (existsSync(venvPython)) {
        pythonBin = venvPython
      }
    } else if (isolation === 'uv') {
      pythonBin = 'uv'
    }

    try {
      let proc: ReturnType<typeof Bun.spawn>
      if (isolation === 'uv') {
        proc = Bun.spawn(['uv', 'run', scriptPath], {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: experimentsDir,
        })
      } else if (isolation === 'docker') {
        const projectId = this.projectDir.replace(/[^a-z0-9]/gi, '-').slice(-30)
        proc = Bun.spawn(
          [
            'docker',
            'run',
            '--rm',
            '-v',
            `${experimentsDir}:/workspace`,
            `cpaper-exp-${projectId}`,
            'python3',
            firstScript.filename,
          ],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            cwd: experimentsDir,
          },
        )
      } else {
        proc = Bun.spawn([pythonBin, scriptPath], {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: experimentsDir,
        })
      }

      // Stream stdout
      const stdoutStream = proc.stdout as ReadableStream<Uint8Array>
      const reader = stdoutStream.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n')
        buffer = parts.pop() ?? ''
        for (const line of parts) {
          outputLines.push(line)
          onOutput(line)
        }
      }

      // Flush remaining buffer
      if (buffer.length > 0) {
        outputLines.push(buffer)
        onOutput(buffer)
      }

      await proc.exited
      const exitCode = proc.exitCode ?? 0

      run.exit_code = exitCode
      run.status = exitCode === 0 ? 'completed' : 'failed'
      if (exitCode !== 0) {
        try {
          const stderrText = await new Response(
            proc.stderr as ReadableStream,
          ).text()
          if (stderrText.trim()) {
            run.error = stderrText.trim().slice(0, 2000)
          }
        } catch {
          run.error = `Process exited with code ${exitCode}`
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      run.status = 'failed'
      run.error = msg
    }

    // Save logs
    try {
      writeFileSync(logsPath, outputLines.join('\n'), 'utf-8')
      run.output_files.push(logsPath)
    } catch {
      // best effort
    }

    run.metrics = extractMetrics(outputLines)
    run.completed_at = new Date().toISOString()

    // Detect placeholder script output — prevent fake metrics from propagating
    const isPlaceholder =
      run.status === 'completed' &&
      (outputLines.some(l =>
        l.includes('# TODO: implement experiment logic'),
      ) ||
        (run.metrics &&
          run.metrics['accuracy'] === 0 &&
          run.metrics['loss'] === 0 &&
          outputLines.some(l => l.includes('accuracy: 0.0')) &&
          outputLines.some(l => l.includes('loss: 0.0'))))
    if (isPlaceholder) {
      run.status = 'failed'
      run.error =
        'Placeholder script executed — agent did not write actual experiment code. Metrics are not real.'
      run.metrics = {}
    }

    this.saveRun(runsDir, run)
    return run
  }

  private async patchOOMFix(
    plan: ExperimentPlan,
    experimentsDir: string,
    onOutput: (line: string) => void,
  ): Promise<void> {
    const firstScript = plan.scripts[0]
    const scriptPath = join(experimentsDir, firstScript.filename)

    try {
      const code = readFileSync(scriptPath, 'utf-8')
      // Simple heuristic: halve batch_size values
      const patched = code.replace(
        /batch[_\s]?size\s*=\s*(\d+)/gi,
        (_match, num) => {
          const newSize = Math.max(1, Math.floor(parseInt(num, 10) / 2))
          return `batch_size = ${newSize}`
        },
      )
      if (patched !== code) {
        writeFileSync(scriptPath, patched, 'utf-8')
        onOutput('[oom-fix] Halved batch_size values in script.')
      } else {
        onOutput('[oom-fix] No batch_size found to reduce.')
      }
    } catch {
      onOutput('[oom-fix] Could not read/patch script.')
    }
  }

  private async attemptAutoFix(
    plan: ExperimentPlan,
    experimentsDir: string,
    error: string,
    logsPath: string | undefined,
    onOutput: (line: string) => void,
  ): Promise<boolean> {
    const firstScript = plan.scripts[0]
    const scriptPath = join(experimentsDir, firstScript.filename)

    let code: string
    try {
      code = readFileSync(scriptPath, 'utf-8')
    } catch {
      return false
    }

    let logsSnippet = ''
    if (logsPath) {
      try {
        const logs = readFileSync(logsPath, 'utf-8')
        logsSnippet = logs.slice(-2000)
      } catch {
        // ignore
      }
    }

    try {
      const response = await chatCompletion({
        modelSpec: DEFAULT_MODEL_ASSIGNMENTS.coding,
        max_tokens: 4096,
        system:
          'You are a Python debugging expert. Fix the script so it runs without errors. Return ONLY the complete fixed Python code, no markdown fences or explanations.',
        messages: [
          {
            role: 'user',
            content: `This Python script failed with error:\n${error.slice(0, 1500)}\n\nLast logs:\n${logsSnippet}\n\nScript:\n${code.slice(0, 6000)}\n\nReturn the fixed code.`,
          },
        ],
      })

      const rawText = response.text
      const fixedCode = rawText
        .replace(/^```(?:python)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim()

      if (fixedCode.length > 50) {
        writeFileSync(scriptPath, fixedCode + '\n', 'utf-8')
        onOutput('[auto-fix] Script patched by LLM.')
        return true
      }
    } catch {
      // LLM call failed
    }
    return false
  }

  async generateScript(plan: ExperimentPlan, modelName: string): Promise<void> {
    const experimentsDir = join(this.projectDir, 'experiments')
    mkdirSync(experimentsDir, { recursive: true })

    if (plan.scripts.length === 0) return

    const firstScript = plan.scripts[0]
    const scriptPath = join(experimentsDir, firstScript.filename)

    const systemPrompt = `You are an expert Python programmer specializing in scientific computing and machine learning. Generate a complete, runnable Python script for a research experiment. The script should:
- Be self-contained with all necessary imports
- Print metrics in the format "metric_name: value" (e.g. "accuracy: 0.95", "loss: 0.042")
- Include basic error handling
- Use only the specified dependencies
- Be concise but complete

Return ONLY the Python code, no markdown fences or explanations.`

    const userContent = `Generate a Python experiment script with filename "${firstScript.filename}" for the following research experiment:

Title: ${plan.title}
Description: ${plan.description}
Script description: ${firstScript.description}
Dependencies: ${plan.dependencies.join(', ') || 'standard library only'}

The script should implement the experiment described and print key metrics to stdout.`

    const response = await chatCompletion({
      modelSpec: modelName,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    })

    const rawText = response.text

    const code = rawText
      .replace(/^```(?:python)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim()

    writeFileSync(scriptPath, code + '\n', 'utf-8')
  }

  private buildPlaceholderScript(
    plan: ExperimentPlan,
    script: { name: string; filename: string; description: string },
  ): string {
    return [
      '#!/usr/bin/env python3',
      `"""`,
      `Experiment: ${plan.title}`,
      `Script: ${script.name}`,
      `Description: ${script.description}`,
      `"""`,
      '',
      'import sys',
      '',
      'def main():',
      `    print("Running experiment: ${plan.title.replace(/"/g, '\\"')}")`,
      `    print("Script: ${script.name.replace(/"/g, '\\"')}")`,
      '    # TODO: implement experiment logic',
      '    print("accuracy: 0.0")',
      '    print("loss: 0.0")',
      '',
      'if __name__ == "__main__":',
      '    main()',
      '',
    ].join('\n')
  }

  private saveRun(runsDir: string, run: ExperimentRun): void {
    const runPath = join(runsDir, `${run.id}.json`)
    try {
      writeFileSync(runPath, JSON.stringify(run, null, 2), 'utf-8')
    } catch {
      // best effort
    }
  }

  savePlan(plan: ExperimentPlan): void {
    const plansDir = join(this.projectDir, 'experiments', '.plans')
    mkdirSync(plansDir, { recursive: true })
    const planPath = join(plansDir, `${plan.id}.json`)
    try {
      writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8')
    } catch {
      // best effort
    }
  }

  loadPlan(planId: string): ExperimentPlan | null {
    const plansDir = join(this.projectDir, 'experiments', '.plans')
    const planPath = join(plansDir, `${planId}.json`)
    if (!existsSync(planPath)) return null
    try {
      return JSON.parse(readFileSync(planPath, 'utf-8')) as ExperimentPlan
    } catch {
      return null
    }
  }
}
