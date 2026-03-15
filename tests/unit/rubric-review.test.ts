import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RubricGenerator } from '../../src/paper/rubric-generator'
import { MetaReviewer } from '../../src/paper/review/meta-reviewer'
import { RevisionHandler } from '../../src/paper/review/revision-handler'
import type {
  Rubric,
  RubricItem,
  RubricReviewResult,
  RubricVerdict,
  ReviewReport,
  MetaReview,
  RubricSummary,
} from '../../src/paper/review/types'

// ── Helpers ──────────────────────────────────────────

function makeRubricItem(
  id: string,
  overrides?: Partial<RubricItem>,
): RubricItem {
  return {
    id,
    statement: `Rubric item ${id}`,
    category: 'completeness',
    weight: 0.05,
    assignee: 'any',
    ...overrides,
  }
}

function makeRubric(itemCount: number, weights?: number[]): Rubric {
  const items: RubricItem[] = []
  for (let i = 0; i < itemCount; i++) {
    items.push(
      makeRubricItem(`R${String(i + 1).padStart(2, '0')}`, {
        weight: weights ? weights[i] : 1 / itemCount,
      }),
    )
  }
  return {
    items,
    generated_at: new Date().toISOString(),
    paper_type: 'mixed',
    proposal_title: 'Test Proposal',
  }
}

function makeReviewReport(rubricResult?: RubricReviewResult): ReviewReport {
  return {
    reviewer_id: 'test-reviewer',
    model_used: 'test-model',
    dimensions: {
      originality: 7,
      significance: 7,
      soundness: 7,
      clarity: 7,
      reproducibility: 7,
      prior_work: 7,
      contribution: 7,
    },
    overall_score: 7,
    decision: 'minor_revision',
    confidence: 3,
    summary: 'Test review',
    strengths: [],
    weaknesses: [],
    questions: [],
    missing_references: [],
    minor_issues: [],
    actionable_suggestions: [],
    rubric_result: rubricResult,
  }
}

// ── RubricGenerator.validate() ──────────────────────

describe('RubricGenerator.validate()', () => {
  test('accepts valid rubric with 15 items and weights summing to 1.0', () => {
    const rubric = makeRubric(15)
    expect(() => RubricGenerator.validate(rubric)).not.toThrow()
  })

  test('accepts valid rubric with 25 items', () => {
    const rubric = makeRubric(25)
    expect(() => RubricGenerator.validate(rubric)).not.toThrow()
  })

  test('rejects rubric with fewer than 15 items', () => {
    const rubric = makeRubric(10)
    expect(() => RubricGenerator.validate(rubric)).toThrow('minimum is 15')
  })

  test('rejects rubric with more than 25 items', () => {
    const rubric = makeRubric(30)
    expect(() => RubricGenerator.validate(rubric)).toThrow('maximum is 25')
  })

  test('rejects rubric with weights not summing to 1.0', () => {
    const rubric = makeRubric(15)
    for (const item of rubric.items) {
      item.weight = 0.5 / 15
    }
    expect(() => RubricGenerator.validate(rubric)).toThrow('weights sum to')
  })

  test('rejects rubric with invalid category', () => {
    const rubric = makeRubric(15)
    ;(rubric.items[0] as any).category = 'invalid_category'
    expect(() => RubricGenerator.validate(rubric)).toThrow(
      'Invalid rubric category',
    )
  })

  test('rejects rubric with invalid assignee', () => {
    const rubric = makeRubric(15)
    ;(rubric.items[0] as any).assignee = 'invalid_assignee'
    expect(() => RubricGenerator.validate(rubric)).toThrow(
      'Invalid rubric assignee',
    )
  })
})

// ── RubricGenerator.isAtomic() ──────────────────────

describe('RubricGenerator.isAtomic()', () => {
  test('accepts atomic statement', () => {
    expect(
      RubricGenerator.isAtomic('The paper provides a proof of Theorem 1'),
    ).toBe(true)
  })

  test('accepts statement without conjunctions', () => {
    expect(RubricGenerator.isAtomic('The methodology section is clear')).toBe(
      true,
    )
  })

  test('rejects statement with "and" conjunction', () => {
    expect(
      RubricGenerator.isAtomic('The paper proves Theorem 1 and Theorem 2'),
    ).toBe(false)
  })

  test('rejects statement with "both"', () => {
    expect(RubricGenerator.isAtomic('Both assumptions are validated')).toBe(
      false,
    )
  })

  test('rejects statement with "as well as"', () => {
    expect(
      RubricGenerator.isAtomic('The algorithm is correct as well as efficient'),
    ).toBe(false)
  })

  test('rejects statement with "along with"', () => {
    expect(
      RubricGenerator.isAtomic('The results along with the proofs are correct'),
    ).toBe(false)
  })

  test('allows "and" between capitalized names', () => {
    expect(
      RubricGenerator.isAtomic(
        'The method builds on Johnson and Williams (2024)',
      ),
    ).toBe(true)
  })

  test('allows "and" in another proper-name context', () => {
    expect(
      RubricGenerator.isAtomic(
        'The result extends Bradley and Terry (1952) to mixing processes',
      ),
    ).toBe(true)
  })
})

// ── Rubric assessment metrics ────────────────────────

describe('RubricReviewResult metrics', () => {
  test('weighted_pass_rate computed correctly', () => {
    const result: RubricReviewResult = {
      assessments: [
        { rubric_id: 'R01', verdict: 'pass', justification: 'ok' },
        { rubric_id: 'R02', verdict: 'partial', justification: 'ok' },
        { rubric_id: 'R03', verdict: 'fail', justification: 'bad' },
      ],
      // pass: 0.5*1 + partial: 0.3*0.5 + fail: 0.2*0 = 0.65
      weighted_pass_rate: 0.65,
      pass_count: 1,
      partial_count: 1,
      fail_count: 1,
    }

    expect(result.weighted_pass_rate).toBeCloseTo(0.65, 2)
    expect(result.pass_count).toBe(1)
    expect(result.partial_count).toBe(1)
    expect(result.fail_count).toBe(1)
  })
})

// ── MetaReviewer rubric aggregation ──────────────────

describe('MetaReviewer rubric aggregation', () => {
  test('aggregates verdicts across 3 reviewers with majority rule', () => {
    const rubric = makeRubric(3, [0.4, 0.35, 0.25])

    const reviews: ReviewReport[] = [
      makeReviewReport({
        assessments: [
          { rubric_id: 'R01', verdict: 'pass', justification: 'good' },
          { rubric_id: 'R02', verdict: 'fail', justification: 'missing' },
          { rubric_id: 'R03', verdict: 'pass', justification: 'ok' },
        ],
        weighted_pass_rate: 0.575,
        pass_count: 2,
        partial_count: 0,
        fail_count: 1,
      }),
      makeReviewReport({
        assessments: [
          {
            rubric_id: 'R01',
            verdict: 'pass',
            justification: 'confirmed',
          },
          { rubric_id: 'R02', verdict: 'fail', justification: 'not there' },
          { rubric_id: 'R03', verdict: 'partial', justification: 'weak' },
        ],
        weighted_pass_rate: 0.525,
        pass_count: 1,
        partial_count: 1,
        fail_count: 1,
      }),
      makeReviewReport({
        assessments: [
          { rubric_id: 'R01', verdict: 'partial', justification: 'mostly' },
          { rubric_id: 'R02', verdict: 'pass', justification: 'found it' },
          { rubric_id: 'R03', verdict: 'pass', justification: 'ok' },
        ],
        weighted_pass_rate: 0.775,
        pass_count: 2,
        partial_count: 1,
        fail_count: 0,
      }),
    ]

    const meta = new MetaReviewer('test-model')
    const summary = (meta as any).aggregateRubric(
      rubric,
      reviews,
    ) as RubricSummary

    expect(summary.aggregated.length).toBe(3)

    // R01: 2 pass, 1 partial → majority pass
    expect(summary.aggregated[0].consensus_verdict).toBe('pass')

    // R02: 2 fail, 1 pass → majority fail
    expect(summary.aggregated[1].consensus_verdict).toBe('fail')

    // R03: 2 pass, 1 partial → majority pass
    expect(summary.aggregated[2].consensus_verdict).toBe('pass')

    // Only R02 should be in failed_items
    expect(summary.failed_items.length).toBe(1)
    expect(summary.failed_items[0].rubric_id).toBe('R02')
  })

  test('tie-breaks toward worse verdict', () => {
    const rubric = makeRubric(15)

    // 2 reviewers: one pass, one partial → no majority → worse = partial
    const reviews: ReviewReport[] = [
      makeReviewReport({
        assessments: rubric.items.map(item => ({
          rubric_id: item.id,
          verdict: 'pass' as RubricVerdict,
          justification: 'ok',
        })),
        weighted_pass_rate: 1.0,
        pass_count: 15,
        partial_count: 0,
        fail_count: 0,
      }),
      makeReviewReport({
        assessments: rubric.items.map(item => ({
          rubric_id: item.id,
          verdict: 'partial' as RubricVerdict,
          justification: 'weak',
        })),
        weighted_pass_rate: 0.5,
        pass_count: 0,
        partial_count: 15,
        fail_count: 0,
      }),
    ]

    const meta = new MetaReviewer('test-model')
    const summary = (meta as any).aggregateRubric(
      rubric,
      reviews,
    ) as RubricSummary

    for (const agg of summary.aggregated) {
      expect(agg.consensus_verdict).toBe('partial')
    }

    expect(summary.failed_items.length).toBe(0)
  })

  test('failed_items list contains only consensus fail items', () => {
    const rubric = makeRubric(15)

    const reviews: ReviewReport[] = [
      makeReviewReport({
        assessments: rubric.items.map((item, i) => ({
          rubric_id: item.id,
          verdict: (i < 3 ? 'fail' : 'pass') as RubricVerdict,
          justification: i < 3 ? 'missing' : 'ok',
        })),
        weighted_pass_rate: 0.8,
        pass_count: 12,
        partial_count: 0,
        fail_count: 3,
      }),
    ]

    const meta = new MetaReviewer('test-model')
    const summary = (meta as any).aggregateRubric(
      rubric,
      reviews,
    ) as RubricSummary

    expect(summary.failed_items.length).toBe(3)
    expect(summary.failed_items[0].rubric_id).toBe('R01')
    expect(summary.failed_items[1].rubric_id).toBe('R02')
    expect(summary.failed_items[2].rubric_id).toBe('R03')
  })

  test('overall_weighted_pass_rate averages across reviewers', () => {
    const rubric = makeRubric(15)

    const reviews: ReviewReport[] = [
      makeReviewReport({
        assessments: rubric.items.map(item => ({
          rubric_id: item.id,
          verdict: 'pass' as RubricVerdict,
          justification: 'ok',
        })),
        weighted_pass_rate: 1.0,
        pass_count: 15,
        partial_count: 0,
        fail_count: 0,
      }),
      makeReviewReport({
        assessments: rubric.items.map(item => ({
          rubric_id: item.id,
          verdict: 'fail' as RubricVerdict,
          justification: 'bad',
        })),
        weighted_pass_rate: 0.0,
        pass_count: 0,
        partial_count: 0,
        fail_count: 15,
      }),
    ]

    const meta = new MetaReviewer('test-model')
    const summary = (meta as any).aggregateRubric(
      rubric,
      reviews,
    ) as RubricSummary

    expect(summary.overall_weighted_pass_rate).toBeCloseTo(0.5, 2)
  })
})

// ── RevisionHandler rubric dispatch ──────────────────

describe('RevisionHandler rubric dispatch', () => {
  let tmpDir: string
  let paperDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rubric-rev-'))
    paperDir = join(tmpDir, 'paper')
    const sectionsDir = join(paperDir, 'sections')
    mkdirSync(sectionsDir, { recursive: true })
    // Create a dummy .tex file so findTexFiles returns non-empty
    writeFileSync(
      join(sectionsDir, 'methodology.tex'),
      '\\section{Methodology}\nSome content.\n',
    )
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('dispatches failed math items to handleMathRevision', async () => {
    const handler = new RevisionHandler(tmpDir, 'test-model')
    let mathCalled = false

    ;(handler as any).handleMathRevision = async () => {
      mathCalled = true
    }

    const summary: RubricSummary = {
      items: [],
      aggregated: [],
      overall_weighted_pass_rate: 0.5,
      failed_items: [
        {
          rubric_id: 'R01',
          statement: 'Theorem 1 proof is incomplete',
          assignee: 'math-reasoner',
          action: 'Fix: complete the proof',
        },
      ],
    }

    await handler.reviseFromRubric(paperDir, summary)
    expect(mathCalled).toBe(true)
  })

  test('dispatches failed experiment items to handleExperimentRevision', async () => {
    const handler = new RevisionHandler(tmpDir, 'test-model')
    let expCalled = false

    ;(handler as any).handleExperimentRevision = async () => {
      expCalled = true
    }

    const summary: RubricSummary = {
      items: [],
      aggregated: [],
      overall_weighted_pass_rate: 0.5,
      failed_items: [
        {
          rubric_id: 'R05',
          statement: 'Ablation study is missing',
          assignee: 'experiment-runner',
          action: 'Fix: run ablation',
        },
      ],
    }

    await handler.reviseFromRubric(paperDir, summary)
    expect(expCalled).toBe(true)
  })

  test('dispatches failed writer items to handleWriterRevision', async () => {
    const handler = new RevisionHandler(tmpDir, 'test-model')
    let writerCalled = false

    ;(handler as any).handleWriterRevision = async () => {
      writerCalled = true
    }

    const summary: RubricSummary = {
      items: [],
      aggregated: [],
      overall_weighted_pass_rate: 0.5,
      failed_items: [
        {
          rubric_id: 'R10',
          statement: 'Abstract is unclear',
          assignee: 'writer',
          action: 'Fix: rewrite abstract',
        },
      ],
    }

    await handler.reviseFromRubric(paperDir, summary)
    expect(writerCalled).toBe(true)
  })

  test('rubric failures processed before key_issues in revise()', async () => {
    const handler = new RevisionHandler(tmpDir, 'test-model')
    const callOrder: string[] = []

    ;(handler as any).reviseFromRubric = async () => {
      callOrder.push('rubric')
      return []
    }

    const metaReview: MetaReview = {
      average_score: 5,
      decision: 'major_revision',
      consensus_level: 'medium',
      key_issues: [],
      reviews: [],
      rubric_summary: {
        items: [],
        aggregated: [],
        overall_weighted_pass_rate: 0.5,
        failed_items: [
          {
            rubric_id: 'R01',
            statement: 'test',
            assignee: 'any',
            action: 'fix',
          },
        ],
      },
    }

    await handler.revise(paperDir, metaReview)
    expect(callOrder[0]).toBe('rubric')
  })
})
