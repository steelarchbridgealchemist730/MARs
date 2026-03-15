import React from 'react'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import type { Command } from '@commands'
import { BashTool } from '@tools/BashTool/BashTool'
import { getCwd } from '@utils/state'
import { CommandSpinner } from '@components/CommandSpinner'
import { getSessionDir } from '../paper/session'
import { PaperReviewer } from '../paper/review/reviewer'
import { MetaReviewer } from '../paper/review/meta-reviewer'
import type {
  MetaReview,
  Rubric,
  ReviewConfig,
  ReviewReport,
} from '../paper/review/types'
import { RubricGenerator } from '../paper/rubric-generator'
import { loadResearchState } from '../paper/research-state'
import { RevisionHandler } from '../paper/review/revision-handler'

import { DEFAULT_MODEL_ASSIGNMENTS } from '../paper/types'
import { extractModelId } from '../paper/agent-dispatch'

const DEFAULT_MODEL = extractModelId(DEFAULT_MODEL_ASSIGNMENTS.review)

function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function collectPaperText(researchDir: string): string {
  const paperDir = join(researchDir, 'paper')
  const sectionsDir = join(paperDir, 'sections')

  const parts: string[] = []

  // Try main.tex first
  const mainTex = join(paperDir, 'main.tex')
  if (existsSync(mainTex)) {
    parts.push(readFileSafe(mainTex))
  }

  // Collect section .tex files
  if (existsSync(sectionsDir)) {
    try {
      const files = readdirSync(sectionsDir).filter(f => f.endsWith('.tex'))
      for (const f of files) {
        const content = readFileSafe(join(sectionsDir, f))
        if (content) parts.push(content)
      }
    } catch {
      // Best effort
    }
  }

  return parts.join('\n\n')
}

function getNextRoundNumber(reviewsDir: string): number {
  if (!existsSync(reviewsDir)) return 1
  try {
    const files = readdirSync(reviewsDir).filter(f =>
      f.match(/^round-\d+\.json$/),
    )
    if (files.length === 0) return 1
    const nums = files
      .map(f => parseInt(f.replace('round-', '').replace('.json', ''), 10))
      .filter(n => !isNaN(n))
    return Math.max(...nums) + 1
  } catch {
    return 1
  }
}

function formatMetaReviewOutput(
  metaReview: MetaReview,
  roundNum: number,
): string {
  const lines: string[] = [
    '=== Paper Review Results ===',
    `Round: ${roundNum}`,
    `Average Score: ${metaReview.average_score.toFixed(2)} / 10`,
    `Decision: ${metaReview.decision.replace(/_/g, ' ').toUpperCase()}`,
    `Consensus: ${metaReview.consensus_level}`,
    '',
    '--- Individual Reviewer Scores ---',
  ]

  for (const r of metaReview.reviews) {
    lines.push(
      `  ${r.reviewer_id}: ${r.overall_score.toFixed(2)} (${r.decision.replace(/_/g, ' ')}) [confidence: ${r.confidence}/5]`,
    )
    lines.push(
      `    Originality: ${r.dimensions.originality}  Significance: ${r.dimensions.significance}  Soundness: ${r.dimensions.soundness}`,
    )
    lines.push(
      `    Clarity: ${r.dimensions.clarity}  Reproducibility: ${r.dimensions.reproducibility}  Prior Work: ${r.dimensions.prior_work}  Contribution: ${r.dimensions.contribution}`,
    )
  }

  lines.push('')
  lines.push('--- Key Issues ---')

  const criticalIssues = metaReview.key_issues.filter(
    i => i.priority === 'critical',
  )
  const majorIssues = metaReview.key_issues.filter(i => i.priority === 'major')
  const minorIssues = metaReview.key_issues.filter(i => i.priority === 'minor')

  if (criticalIssues.length > 0) {
    lines.push('CRITICAL:')
    for (const issue of criticalIssues) {
      lines.push(`  [${issue.assignee}] ${issue.description}`)
      lines.push(`    Action: ${issue.action}`)
    }
  }

  if (majorIssues.length > 0) {
    lines.push('MAJOR:')
    for (const issue of majorIssues) {
      lines.push(`  [${issue.assignee}] ${issue.description}`)
      lines.push(`    Action: ${issue.action}`)
    }
  }

  if (minorIssues.length > 0) {
    lines.push('MINOR:')
    for (const issue of minorIssues) {
      lines.push(`  [${issue.assignee}] ${issue.description}`)
    }
  }

  if (metaReview.key_issues.length === 0) {
    lines.push('  No major issues identified.')
  }

  // Rubric summary
  if (metaReview.rubric_summary) {
    const rs = metaReview.rubric_summary
    lines.push('')
    lines.push('--- Rubric Assessment ---')
    lines.push(
      `Weighted Pass Rate: ${(rs.overall_weighted_pass_rate * 100).toFixed(1)}%`,
    )

    for (const agg of rs.aggregated) {
      const icon =
        agg.consensus_verdict === 'pass'
          ? '+'
          : agg.consensus_verdict === 'partial'
            ? '~'
            : 'X'
      lines.push(`  [${icon}] (w=${agg.weight.toFixed(2)}) ${agg.statement}`)
    }

    if (rs.failed_items.length > 0) {
      lines.push('')
      lines.push(`Failed Items (${rs.failed_items.length}):`)
      for (const item of rs.failed_items) {
        lines.push(`  [${item.assignee}] ${item.statement}`)
      }
    }
  }

  lines.push('')
  lines.push('--- Reviewer Summaries ---')
  for (const r of metaReview.reviews) {
    lines.push(`  ${r.reviewer_id}: ${r.summary}`)
  }

  lines.push('')
  lines.push('============================')

  return lines.join('\n')
}

function parseReviewFlags(argsStr: string): {
  strength: ReviewConfig['strength']
  numReviewers: number
  grounded: boolean
  noRubric: boolean
  dispatch: boolean
} {
  const strengthMatch = argsStr.match(
    /--strength\s+(light|standard|thorough|brutal)/,
  )
  const reviewersMatch = argsStr.match(/--reviewers\s+(\d+)/)
  const grounded = argsStr.includes('--grounded')
  const noRubric = argsStr.includes('--no-rubric')
  const dispatch = argsStr.includes('--dispatch')

  return {
    strength: (strengthMatch?.[1] as ReviewConfig['strength']) ?? 'standard',
    numReviewers: reviewersMatch
      ? Math.max(1, Math.min(5, parseInt(reviewersMatch[1], 10)))
      : 3,
    grounded,
    noRubric,
    dispatch,
  }
}

async function runPaperReview(
  researchDir: string,
  argsStr: string,
): Promise<string> {
  const mainTex = join(researchDir, 'paper', 'main.tex')
  if (!existsSync(mainTex)) {
    return 'No paper found at .claude-paper-research/paper/main.tex. Run /write to generate the paper first.'
  }

  const paperText = collectPaperText(researchDir)
  if (!paperText.trim()) {
    return 'Paper is empty. Generate the paper with /write first.'
  }

  const flags = parseReviewFlags(argsStr)

  const defaultReviewerModels = Array.from(
    { length: flags.numReviewers },
    () => DEFAULT_MODEL,
  )

  const config: ReviewConfig = {
    num_reviewers: flags.numReviewers,
    max_rounds: 3,
    acceptance_threshold: 7.0,
    strength: flags.strength,
    models: defaultReviewerModels,
    grounded: flags.grounded,
  }

  const numReviewers = config.num_reviewers ?? 3
  const reviewerModels = config.models ?? []

  // Build reviewers — each reviewer uses its own model for diversity
  const reviewers = Array.from({ length: numReviewers }, (_, i) => ({
    reviewer: new PaperReviewer(
      reviewerModels[i] ?? DEFAULT_MODEL,
      `reviewer-${i + 1}`,
    ),
    id: `reviewer-${i + 1}`,
  }))

  // Generate rubric if enabled and research state exists
  let rubric: Rubric | undefined
  if (!flags.noRubric) {
    try {
      const stateDir = join(researchDir, '.claude-paper')
      const statePath = join(stateDir, 'state.json')
      if (existsSync(statePath)) {
        const state = loadResearchState(researchDir)
        if (state) {
          const generator = new RubricGenerator()
          rubric = await generator.generate(state)
        }
      }
    } catch {
      // Rubric generation failed — fall back to standard review
    }
  }

  let reviewReports: ReviewReport[]
  try {
    if (rubric) {
      reviewReports = await Promise.all(
        reviewers.map(({ reviewer }) =>
          reviewer.reviewWithRubric(paperText, rubric!, config),
        ),
      )
    } else {
      reviewReports = await Promise.all(
        reviewers.map(({ reviewer }) => reviewer.review(paperText, config)),
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `Error running reviewers: ${message}`
  }

  const metaReviewer = new MetaReviewer(DEFAULT_MODEL)
  let metaReview: MetaReview
  try {
    metaReview = await metaReviewer.synthesize(reviewReports, config, rubric)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `Error synthesizing meta-review: ${message}`
  }

  // Save review to .claude-paper-research/reviews/round-N.json
  const reviewsDir = join(researchDir, 'reviews')
  if (!existsSync(reviewsDir)) {
    mkdirSync(reviewsDir, { recursive: true })
  }

  const roundNum = getNextRoundNumber(reviewsDir)
  const reviewPath = join(reviewsDir, `round-${roundNum}.json`)

  try {
    writeFileSync(reviewPath, JSON.stringify(metaReview, null, 2), 'utf-8')
  } catch {
    // Best effort
  }

  // Dispatch failed rubric items to agents if --dispatch flag is set
  let dispatchSummary = ''
  if (flags.dispatch && metaReview.rubric_summary?.failed_items?.length) {
    try {
      const state = loadResearchState(researchDir)
      if (state) {
        const handler = new RevisionHandler(researchDir, DEFAULT_MODEL, state)
        const paperDir = join(researchDir, 'paper')
        await handler.revise(paperDir, metaReview)
        dispatchSummary = `\n\nDispatched ${metaReview.rubric_summary.failed_items.length} failed rubric items to agents for revision.`
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      dispatchSummary = `\n\nFailed to dispatch revisions: ${msg}`
    }
  }

  const output = formatMetaReviewOutput(metaReview, roundNum)
  return output + dispatchSummary + `\nReview saved to: ${reviewPath}`
}

export default {
  type: 'local-jsx',
  name: 'review',
  userFacingName() {
    return 'review'
  },
  description: 'Review a pull request or run paper peer review',
  isEnabled: true,
  isHidden: false,
  argumentHint:
    '[--paper] [--strength light|standard|thorough|brutal] [--reviewers <n>] [--grounded] [--no-rubric] [--dispatch] [<pr-number>]',
  aliases: [],

  async call(
    onDone: (result?: string) => void,
    _context: any,
    args?: string,
  ): Promise<React.ReactNode> {
    const argsStr = args ?? ''
    const researchDir = getSessionDir()
    const mainTex = join(researchDir, 'paper', 'main.tex')

    if (argsStr.includes('--paper') || existsSync(mainTex)) {
      const flags = parseReviewFlags(argsStr)
      return (
        <CommandSpinner
          label={`Running peer review (${flags.numReviewers} reviewers, ${flags.strength})...`}
          runner={() => runPaperReview(researchDir, argsStr)}
          onDone={result => onDone(result)}
        />
      )
    }

    const prNumber = argsStr.trim()
    if (!prNumber) {
      onDone(
        [
          'Usage:',
          '  /review --paper                         Run AI peer review on your research paper',
          '  /review --paper --strength thorough      Set review depth (light|standard|thorough|brutal)',
          '  /review --paper --reviewers 5            Set number of reviewers (1-5)',
          '  /review --paper --grounded               Ground review in recent arXiv literature',
          '  /review --paper --no-rubric              Skip rubric-driven assessment',
          '  /review --paper --dispatch               Dispatch failed rubric items to agents for revision',
          '  /review <pr-number>                      Review a GitHub pull request',
        ].join('\n'),
      )
      return null
    }

    onDone(
      [
        `To review PR #${prNumber}:`,
        `  1. Run: gh pr view ${prNumber}`,
        `  2. Run: gh pr diff ${prNumber}`,
        `  3. Analyze the changes.`,
      ].join('\n'),
    )
    return null
  },
} satisfies Command
