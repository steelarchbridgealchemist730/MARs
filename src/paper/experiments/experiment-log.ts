import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ExperimentLog,
  ExperimentLogEntry,
  ExperimentSummary,
} from './types'

/**
 * File-backed JSON store tracking all experiments.
 * Consumed by the orchestrator, auditor, and result-analyzer.
 */
export class ExperimentLogManager {
  private logPath: string

  constructor(projectDir: string) {
    this.logPath = join(projectDir, 'experiments', 'experiment-log.json')
  }

  /**
   * Read the experiment log from disk.
   * Returns empty log if file is missing or corrupt.
   */
  load(): ExperimentLog {
    try {
      const raw = readFileSync(this.logPath, 'utf-8')
      return JSON.parse(raw) as ExperimentLog
    } catch {
      return { experiments: [] }
    }
  }

  /**
   * Write the experiment log to disk.
   * Creates parent directories if needed.
   */
  async save(log: ExperimentLog): Promise<void> {
    mkdirSync(dirname(this.logPath), { recursive: true })
    await Bun.write(this.logPath, JSON.stringify(log, null, 2) + '\n')
  }

  /**
   * Register a new experiment entry, or overwrite an existing one with the same ID.
   */
  async register(entry: ExperimentLogEntry): Promise<void> {
    const log = this.load()
    const idx = log.experiments.findIndex(e => e.id === entry.id)
    if (idx >= 0) {
      log.experiments[idx] = entry
    } else {
      log.experiments.push(entry)
    }
    await this.save(log)
  }

  /**
   * Merge partial updates into an existing entry's fields.
   * Silently ignores unknown IDs.
   */
  async updateStatus(
    id: string,
    updates: Partial<ExperimentLogEntry>,
  ): Promise<void> {
    const log = this.load()
    const entry = log.experiments.find(e => e.id === id)
    if (!entry) return
    Object.assign(entry, updates)
    await this.save(log)
  }

  /**
   * Get a single experiment by ID, or null if not found.
   */
  getExperiment(id: string): ExperimentLogEntry | null {
    const log = this.load()
    return log.experiments.find(e => e.id === id) ?? null
  }

  /**
   * Return compact summaries for completed experiments only.
   */
  getSummaries(): ExperimentSummary[] {
    const log = this.load()
    return log.experiments
      .filter(e => e.status === 'completed')
      .map(e => ({
        id: e.id,
        tier: e.tier,
        purpose: e.purpose,
        targets_claim: e.targets_claim,
        key_result: e.key_result,
        created_at: e.created_at,
      }))
  }

  /**
   * Get the next sequential number for a given experiment type.
   * Scans existing IDs like "probe-003" or "run-012" and returns max+1.
   */
  getNextNumber(type: 'probes' | 'runs'): number {
    const prefix = type === 'probes' ? 'probe' : 'run'
    const re = new RegExp(`^${prefix}-(\\d+)`)
    const log = this.load()

    let max = 0
    for (const entry of log.experiments) {
      const m = re.exec(entry.id)
      if (m) {
        const num = parseInt(m[1], 10)
        if (num > max) max = num
      }
    }
    return max + 1
  }
}
