import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ExperimentLogManager } from './experiment-log'
import type {
  ExperimentMeta,
  MetricsJson,
  FullAuditResult,
  NoteData,
  ExperimentNoteSummary,
} from './types'

/**
 * Generates human-readable NOTE.md files for each experiment.
 * Pure template rendering — no LLM calls.
 */
export class ExperimentNotebook {
  private logManager: ExperimentLogManager

  constructor(private projectDir: string) {
    this.logManager = new ExperimentLogManager(projectDir)
  }

  /**
   * Generate a NOTE.md in the experiment directory summarizing the experiment.
   * Silently returns if experiment dir is not found (non-critical).
   */
  async generateNote(experimentId: string, data: NoteData): Promise<void> {
    const entry = this.logManager.getExperiment(experimentId)
    if (!entry) return

    const experimentDir = join(this.projectDir, entry.path)
    if (!existsSync(experimentDir)) return

    let meta: ExperimentMeta | null = null
    try {
      meta = JSON.parse(
        readFileSync(join(experimentDir, 'meta.json'), 'utf-8'),
      ) as ExperimentMeta
    } catch {
      // meta.json missing — use fallback values from log entry
    }

    const lines: string[] = []

    // Header
    lines.push(`# Experiment Note: ${experimentId}`)
    lines.push('')
    lines.push(
      `| Field | Value |`,
      `|-------|-------|`,
      `| **ID** | ${experimentId} |`,
      `| **Timestamp** | ${meta?.created_at ?? entry.created_at ?? new Date().toISOString()} |`,
      `| **Tier** | ${meta?.tier ?? entry.tier} |`,
      `| **Seed** | ${meta?.seed ?? 'N/A'} |`,
    )
    lines.push('')

    // Purpose + target claim
    lines.push(`## Purpose`)
    lines.push('')
    lines.push(meta?.purpose ?? entry.purpose ?? 'N/A')
    lines.push('')
    lines.push(
      `**Target claim:** ${meta?.targets_claim ?? entry.targets_claim ?? 'N/A'}`,
    )
    lines.push('')

    // Execution
    lines.push(`## Execution`)
    lines.push('')
    lines.push(
      `- **Status:** ${data.executionResult.success ? 'SUCCESS' : 'FAILED'}`,
    )
    lines.push(`- **Agent:** ${data.executionResult.agent}`)
    lines.push(`- **Cost:** $${data.executionResult.cost_usd.toFixed(4)}`)
    if (data.executionResult.artifacts_produced.length > 0) {
      lines.push(
        `- **Artifacts:** ${data.executionResult.artifacts_produced.join(', ')}`,
      )
    }
    lines.push('')

    // Summary
    lines.push(`## Summary`)
    lines.push('')
    lines.push(data.executionResult.summary || 'No summary available.')
    lines.push('')

    // Metrics
    lines.push(`## Metrics`)
    lines.push('')
    if (data.metricsJson?.models) {
      lines.push(`| Model | Metric | Value |`)
      lines.push(`|-------|--------|-------|`)
      for (const [model, modelData] of Object.entries(
        data.metricsJson.models,
      )) {
        const oos = modelData.out_of_sample
        if (oos) {
          for (const [metric, value] of Object.entries(oos)) {
            lines.push(
              `| ${model} | ${metric} | ${typeof value === 'number' ? value.toFixed(6) : String(value)} |`,
            )
          }
        }
      }
    } else {
      lines.push('No metrics.json found.')
    }
    lines.push('')

    // Statistical tests
    lines.push(`## Statistical Tests`)
    lines.push('')
    if (data.metricsJson?.statistical_tests) {
      lines.push(`| Test | Statistic | p-value | Sig@5% | Direction |`)
      lines.push(`|------|-----------|---------|--------|-----------|`)
      for (const [name, test] of Object.entries(
        data.metricsJson.statistical_tests,
      )) {
        lines.push(
          `| ${name} | ${test.statistic.toFixed(4)} | ${test.p_value.toFixed(4)} | ${test.significant_5pct ? 'Yes' : 'No'} | ${test.direction} |`,
        )
      }
    } else {
      lines.push('None.')
    }
    lines.push('')

    // Audit checks
    lines.push(`## Audit`)
    lines.push('')
    if (data.auditResult?.static_audit?.checks) {
      lines.push(`| Check | Result |`)
      lines.push(`|-------|--------|`)
      for (const check of data.auditResult.static_audit.checks) {
        lines.push(`| ${check.name} | ${check.passed ? 'PASS' : 'FAIL'} |`)
      }
    } else {
      lines.push('No audit performed.')
    }
    lines.push('')

    // Builder narrative
    lines.push(`## Builder Narrative`)
    lines.push('')
    lines.push(data.builderNarrative || 'N/A')
    lines.push('')

    // Skeptic challenge
    lines.push(`## Skeptic Challenge`)
    lines.push('')
    lines.push(data.skepticChallenge || 'No challenges raised.')
    lines.push('')

    // Arbiter decision
    lines.push(`## Arbiter Decision`)
    lines.push('')
    lines.push(`**Reasoning:** ${data.arbiterDecision.reasoning}`)
    lines.push('')
    lines.push(`**Action:** ${data.arbiterDecision.action.type}`)
    lines.push('')

    // Claim impacts
    lines.push(`## Claim Impacts`)
    lines.push('')
    if (data.claimImpacts.length > 0) {
      lines.push(`| Claim ID | Action | New Confidence | Reason |`)
      lines.push(`|----------|--------|----------------|--------|`)
      for (const impact of data.claimImpacts) {
        lines.push(
          `| ${impact.claim_id} | ${impact.action} | ${impact.new_confidence?.toFixed(2) ?? 'N/A'} | ${impact.reason} |`,
        )
      }
    } else {
      lines.push('No claim updates.')
    }
    lines.push('')

    await Bun.write(join(experimentDir, 'NOTE.md'), lines.join('\n'))
  }

  /**
   * Extract a compact summary from an experiment's on-disk data.
   * Synchronous — same pattern as readMetrics/readAudit.
   */
  extractSummary(experimentId: string): ExperimentNoteSummary {
    const entry = this.logManager.getExperiment(experimentId)

    const fallback: ExperimentNoteSummary = {
      id: experimentId,
      purpose: 'unknown',
      targets_claim: 'unknown',
      success: false,
      key_metrics: [],
      audit_status: 'none',
      arbiter_action: 'unknown',
      one_liner: 'No data available',
    }

    if (!entry) return fallback

    const experimentDir = join(this.projectDir, entry.path)

    // Read meta.json for purpose and targets_claim
    let purpose = entry.purpose ?? 'unknown'
    let targetsClaim = entry.targets_claim ?? 'unknown'
    try {
      const meta = JSON.parse(
        readFileSync(join(experimentDir, 'meta.json'), 'utf-8'),
      ) as ExperimentMeta
      purpose = meta.purpose
      targetsClaim = meta.targets_claim
    } catch {
      // use entry values as fallback
    }

    // Read metrics.json for key_metrics (first 3 out_of_sample k/v pairs)
    const keyMetrics: string[] = []
    try {
      const metrics = JSON.parse(
        readFileSync(join(experimentDir, 'results', 'metrics.json'), 'utf-8'),
      ) as MetricsJson
      let count = 0
      outer: for (const modelData of Object.values(metrics.models)) {
        if (modelData.out_of_sample) {
          for (const [k, v] of Object.entries(modelData.out_of_sample)) {
            keyMetrics.push(
              `${k}: ${typeof v === 'number' ? v.toFixed(4) : String(v)}`,
            )
            count++
            if (count >= 3) break outer
          }
        }
      }
    } catch {
      // no metrics
    }

    // Read audit.json for audit_status
    let auditStatus = 'none'
    try {
      const audit = JSON.parse(
        readFileSync(join(experimentDir, 'audit.json'), 'utf-8'),
      ) as FullAuditResult
      auditStatus = audit.static_audit.passed ? 'passed' : 'failed'
    } catch {
      // no audit
    }

    // Read NOTE.md for arbiter_action
    let arbiterAction = 'unknown'
    try {
      const noteContent = readFileSync(join(experimentDir, 'NOTE.md'), 'utf-8')
      const actionMatch = noteContent.match(/\*\*Action:\*\*\s*(.+)/)
      if (actionMatch) {
        arbiterAction = actionMatch[1].trim()
      }
    } catch {
      // NOTE.md not written yet
    }

    const success = entry.status === 'completed'
    const oneLiner = entry.key_result ?? purpose

    return {
      id: experimentId,
      purpose,
      targets_claim: targetsClaim,
      success,
      key_metrics: keyMetrics,
      audit_status: auditStatus,
      arbiter_action: arbiterAction,
      one_liner: oneLiner,
    }
  }
}
