/**
 * Shared test factories for writing pipeline tests.
 * New tests use these helpers; existing tests are NOT refactored.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ResearchState } from '../../src/paper/research-state'
import type { NarrativePlan } from '../../src/paper/writing/types'

export function makeMinimalState(
  overrides?: Partial<ResearchState>,
): ResearchState {
  return {
    proposal: {
      title: 'Test Paper',
      authors: ['Alice', 'Bob'],
      template: 'neurips',
      methodology: 'mixed',
      ...(overrides?.proposal ?? {}),
    },
    paper_type: 'empirical',
    claimGraph: {
      claims: [
        {
          id: 'c1',
          statement: 'Our method outperforms baselines',
          type: 'result',
          epistemicLayer: 'exploitation',
          phase: 'admitted',
          strength: {
            confidence: 0.85,
            evidenceType: 'empirical',
          },
          created_at: new Date().toISOString(),
          metadata: {},
        },
      ],
      edges: [],
    },
    evidencePool: {
      grounded: [
        {
          id: 'e1',
          claim: 'Results from prior work',
          source_type: 'literature',
          source_ref: 'smith2024',
          verified: true,
          supports_claims: ['c1'],
          contradicts_claims: [],
          acquired_at: new Date().toISOString(),
          acquired_by: 'investigator',
        },
      ],
      derived: [
        {
          id: 'e2',
          claim: 'Experiment shows 10% improvement',
          method: 'experiment',
          reproducible: true,
          artifact_id: '',
          assumptions: [],
          supports_claims: ['c1'],
          contradicts_claims: [],
          produced_at: new Date().toISOString(),
          produced_by: 'experiment-runner',
        },
      ],
    },
    stability: {
      convergenceScore: 0.75,
      admittedClaimCount: 1,
      proposedClaimCount: 0,
      weakestBridge: null,
      paperReadiness: 'nearly_ready',
      evidenceCoverage: 0.8,
      lastArbiterAssessment: 'Good progress',
    },
    literature_awareness: {
      deeply_read: [],
      aware_but_unread: [],
      known_results: [],
      confirmed_gaps: [],
      last_comprehensive_search: null,
    },
    theory: { proofs: [] },
    budget: {
      total_usd: 50,
      spent_usd: 10,
      remaining_usd: 40,
      breakdown: {},
    },
    time: {
      started_at: new Date().toISOString(),
      deadline: null,
      estimated_completion: null,
    },
    compute: null,
    artifacts: {
      entries: [],
      literature_db: null,
      selected_proposal: null,
      paper_tex: null,
      compiled_pdf: null,
    },
    trajectory: [],
    initialized: true,
    orchestrator_cycle_count: 5,
    ...overrides,
  } as any
}

export function makeClaimGraphData(
  claims?: Array<{
    id: string
    statement: string
    phase?: string
    layer?: string
  }>,
) {
  return {
    claims: (claims ?? []).map(c => ({
      id: c.id,
      statement: c.statement,
      type: 'hypothesis',
      epistemicLayer: c.layer ?? 'exploitation',
      phase: c.phase ?? 'admitted',
      strength: { confidence: 0.85, evidenceType: 'empirical' },
      created_at: new Date().toISOString(),
      metadata: {},
    })),
    edges: [],
  }
}

export function makeEvidencePool(
  evidence?: Array<{ id: string; claim_ids: string[] }>,
) {
  return {
    grounded: (evidence ?? []).map(e => ({
      id: e.id,
      claim: 'Evidence',
      source_type: 'literature' as const,
      source_ref: 'ref',
      verified: true,
      supports_claims: e.claim_ids,
      contradicts_claims: [] as string[],
      acquired_at: new Date().toISOString(),
      acquired_by: 'investigator',
    })),
    derived: [],
  }
}

export function makeNarrativePlan(
  overrides?: Partial<NarrativePlan>,
): NarrativePlan {
  return {
    narrative_arc: {
      hook: 'Neural operators can bypass SDE solving',
      gap: 'No existing work handles the calibration loop',
      insight: 'Operator learning replaces iterative calibration',
      method_summary: 'Train DeepONet on synthetic calibration paths',
      evidence_summary: '10x speedup on benchmark',
      nuance: 'Limited to low-dimensional parameter spaces',
    },
    hero_figure: null,
    main_table: null,
    sections: [
      {
        name: 'introduction',
        title: 'Introduction',
        page_budget: 1.5,
        claims_covered: ['c1'],
        key_points: ['Problem motivation', 'Contribution summary'],
        tone: 'assertive',
      },
      {
        name: 'methodology',
        title: 'Methodology',
        page_budget: 2.5,
        claims_covered: ['c1'],
        key_points: ['Architecture', 'Training procedure'],
        tone: 'assertive',
      },
      {
        name: 'conclusion',
        title: 'Conclusion',
        page_budget: 0.5,
        claims_covered: [],
        key_points: ['Summary'],
        tone: 'assertive',
      },
    ],
    appendix_sections: [],
    ...overrides,
  }
}

export function makeFakePdf(tmpDir: string, pageCount: number): string {
  let pdf = '%PDF-1.4\n'
  for (let i = 0; i < pageCount; i++) {
    pdf += `${i + 1} 0 obj\n<< /Type /Page >>\nendobj\n`
  }
  const pdfPath = join(tmpDir, 'main.pdf')
  writeFileSync(pdfPath, pdf)
  return pdfPath
}

export function MOCK_CHAT_RESPONSE(text: string) {
  return {
    text,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    stop_reason: 'end_turn',
  }
}
