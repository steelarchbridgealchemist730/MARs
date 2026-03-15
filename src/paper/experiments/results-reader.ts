import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExperimentLogManager } from './experiment-log'
import type { ExperimentSummary, FullAuditResult, MetricsJson } from './types'

/**
 * Walk an object by dot-separated path. Returns undefined if any segment is missing.
 */
export function getNestedValue(obj: any, path: string): any {
  const segments = path.split('.')
  let current = obj
  for (const seg of segments) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[seg]
  }
  return current
}

/**
 * Read-only access to experiment results, metrics, and audit data.
 * Depends on ExperimentLogManager for experiment lookups.
 */
export class ExperimentResultsReader {
  constructor(
    private projectDir: string,
    private logManager: ExperimentLogManager,
  ) {}

  /**
   * Resolve the absolute directory for an experiment by ID.
   */
  getExperimentDir(id: string): string | null {
    const entry = this.logManager.getExperiment(id)
    if (!entry) return null
    return join(this.projectDir, entry.path)
  }

  /**
   * Read and parse results/metrics.json for an experiment.
   */
  readMetrics(id: string): MetricsJson | null {
    const dir = this.getExperimentDir(id)
    if (!dir) return null
    try {
      const raw = readFileSync(join(dir, 'results', 'metrics.json'), 'utf-8')
      return JSON.parse(raw) as MetricsJson
    } catch {
      return null
    }
  }

  /**
   * Read and parse audit.json for an experiment.
   */
  readAudit(id: string): FullAuditResult | null {
    const dir = this.getExperimentDir(id)
    if (!dir) return null
    try {
      const raw = readFileSync(join(dir, 'audit.json'), 'utf-8')
      return JSON.parse(raw) as FullAuditResult
    } catch {
      return null
    }
  }

  /**
   * Compare a specific metric across multiple experiments.
   * Returns results sorted ascending by value.
   */
  compareMetric(
    ids: string[],
    metricPath: string,
  ): Array<{ experiment_id: string; model: string; value: number }> {
    const results: Array<{
      experiment_id: string
      model: string
      value: number
    }> = []

    for (const id of ids) {
      const metrics = this.readMetrics(id)
      if (!metrics) continue
      for (const [model, modelData] of Object.entries(metrics.models)) {
        const value = getNestedValue(modelData, metricPath)
        if (typeof value === 'number') {
          results.push({ experiment_id: id, model, value })
        }
      }
    }

    results.sort((a, b) => a.value - b.value)
    return results
  }

  /**
   * Delegate to logManager.getSummaries() for compact experiment overviews.
   */
  getSummary(): ExperimentSummary[] {
    return this.logManager.getSummaries()
  }
}
