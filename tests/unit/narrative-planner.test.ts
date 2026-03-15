import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type {
  ClaimGraphData,
  Claim,
  ClaimEdge,
} from '../../src/paper/claim-graph/types'
import type { EvidencePool } from '../../src/paper/evidence-pool'
import type {
  ResearchState,
  TrajectoryEntry,
  ArtifactEntry,
} from '../../src/paper/research-state'
import type { ResolvedTemplate } from '../../src/paper/writing/template-types'
import type { NarrativePlan } from '../../src/paper/writing/types'

// ── Mock LLM client ──────────────────────────────────────

const GOOD_PLAN: NarrativePlan = {
  narrative_arc: {
    hook: 'Neural operators can bypass SDE solving',
    gap: 'No existing work handles the calibration loop',
    insight: 'Operator learning replaces iterative calibration',
    method_summary: 'Train DeepONet on synthetic calibration paths',
    evidence_summary: '10x speedup on benchmark',
    nuance: 'Limited to low-dimensional parameter spaces',
  },
  hero_figure: {
    description: 'Architecture diagram',
    components: ['encoder', 'operator', 'decoder'],
    placement: 'methodology',
    estimated_height: '0.35',
  },
  main_table: {
    content: 'Calibration accuracy comparison',
    experiments_used: ['exp-1'],
    placement: 'results',
    caption_draft: 'Comparison of calibration methods',
  },
  sections: [
    {
      name: 'introduction',
      title: 'Introduction',
      page_budget: 1.5,
      claims_covered: ['claim-1'],
      key_points: ['Problem motivation', 'Contribution summary'],
      tone: 'assertive',
      ends_with: 'transition to related work',
    },
    {
      name: 'related-work',
      title: 'Related Work',
      page_budget: 1.5,
      claims_covered: [],
      key_points: ['Prior calibration methods'],
      tone: 'comparative',
      must_cite: ['chen2024'],
    },
    {
      name: 'methodology',
      title: 'Methodology',
      page_budget: 2.5,
      claims_covered: ['claim-1', 'claim-2'],
      key_points: ['Architecture', 'Training procedure'],
      tone: 'assertive',
      contains_hero_figure: true,
    },
    {
      name: 'experiments',
      title: 'Experiments',
      page_budget: 2.0,
      claims_covered: ['claim-2'],
      key_points: ['Benchmark setup', 'Baselines'],
      tone: 'assertive',
      experiments_used: ['exp-1'],
      contains_main_table: true,
    },
    {
      name: 'conclusion',
      title: 'Conclusion',
      page_budget: 0.5,
      claims_covered: [],
      key_points: ['Summary', 'Future work'],
      tone: 'assertive',
      demoted_claims_here: ['claim-3'],
    },
  ],
  appendix_sections: [
    {
      name: 'proof-details',
      source_fragment: 'frag-proof-1',
    },
  ],
}

mock.module('../../src/paper/llm-client', () => ({
  chatCompletion: async () => ({
    text: JSON.stringify(GOOD_PLAN),
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 0.05,
    stop_reason: 'end_turn',
  }),
  loadModelAssignments: () => ({}),
}))

// Import AFTER mock
const { NarrativePlanner, narrativePlanToStructure } =
  await import('../../src/paper/writing/narrative-planner')

// ── Test helpers ─────────────────────────────────────────

function makeClaim(
  id: string,
  phase: string,
  layer: string,
  statement: string,
): Claim {
  return {
    id,
    type: 'hypothesis' as any,
    epistemicLayer: layer as any,
    statement,
    phase: phase as any,
    evidence: { grounded: [], derived: [] },
    strength: {
      confidence: 0.8,
      evidenceType: 'empirical_support' as any,
      vulnerabilityScore: 0.2,
    },
    created_at: new Date().toISOString(),
    created_by: 'builder',
    last_assessed_at: new Date().toISOString(),
    assessment_history: [],
  }
}

function makeClaimGraph(...claims: Claim[]): ClaimGraphData {
  return { claims, edges: [] }
}

function makeEvidencePool(): EvidencePool {
  return { grounded: [], derived: [] }
}

function makeTemplate(): ResolvedTemplate {
  return {
    manifest: {
      id: 'neurips',
      name: 'NeurIPS 2026',
      venue_type: 'conference',
      field: 'ml',
      description: 'NeurIPS template',
      template_files: { main: 'main.tex' },
      compilation: {
        engine: 'pdflatex',
        bibtex: 'bibtex',
        sequence: [],
        extra_packages: [],
      },
    },
    constraints: {
      page_limits: {
        main_body: 9,
        references: 'unlimited',
        appendix: 'unlimited',
      },
      structure: {
        required_sections: ['introduction', 'related-work', 'conclusion'],
        optional_sections: ['discussion'],
        abstract_word_limit: 250,
      },
      formatting: { columns: 2, font_size: '10pt' },
      writing_guidelines: {
        main_body_strategy: 'Dense 2-column, 10pt',
        page_budget: {
          introduction: 1.5,
          'related-work': 1.5,
          methodology: 2.5,
          experiments: 2,
          conclusion: 0.5,
        },
      },
      common_pitfalls: [],
    },
    directory: '/tmp/templates/neurips',
  }
}

function makeState(overrides?: Partial<ResearchState>): ResearchState {
  return {
    id: 'test-state',
    proposal: {
      id: 'p1',
      title: 'Neural Operator Calibration',
      abstract: 'A novel approach to calibration using neural operators.',
      innovations: [],
      methodology: 'Deep operator learning',
      expected_contributions: [],
      paper_type: 'empirical',
      feasibility_assessment: { overall_score: 0.8 },
    } as any,
    paper_type: 'empirical',
    claimGraph: makeClaimGraph(
      makeClaim(
        'claim-1',
        'admitted',
        'exploitation',
        'Neural operators speed up calibration 10x',
      ),
      makeClaim(
        'claim-2',
        'admitted',
        'observation',
        'Benchmark shows 10x speedup',
      ),
      makeClaim('claim-3', 'demoted', 'justification', 'Convergence guarantee'),
    ),
    evidencePool: makeEvidencePool(),
    stability: {
      convergenceScore: 0.7,
      admittedClaimCount: 2,
      proposedClaimCount: 0,
      weakestBridge: null,
      paperReadiness: 'nearly_ready',
      evidenceCoverage: 0.8,
      lastArbiterAssessment: 'Claims are well supported',
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
      warn_at_percent: 80,
      breakdown: [],
    },
    time: {
      started_at: new Date().toISOString(),
      estimated_completion: null,
      deadline: null,
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
    loaded_knowledge_packs: [],
    initialized: true,
    orchestrator_cycle_count: 5,
    ...overrides,
  } as ResearchState
}

// ── Tests ────────────────────────────────────────────────

describe('NarrativePlanner', () => {
  let tmpDir: string
  let planner: InstanceType<typeof NarrativePlanner>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-narr-'))
    planner = new NarrativePlanner(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('plan() returns valid NarrativePlan', async () => {
    const state = makeState()
    const template = makeTemplate()
    const plan = await planner.plan(state, template)

    expect(plan.narrative_arc).toBeDefined()
    expect(plan.narrative_arc.hook).toBe(
      'Neural operators can bypass SDE solving',
    )
    expect(plan.sections.length).toBeGreaterThanOrEqual(5)
    expect(plan.sections[0].name).toBe('introduction')
    expect(plan.hero_figure).toBeDefined()
    expect(plan.main_table).toBeDefined()
    expect(plan.appendix_sections.length).toBe(1)
  })

  test('plan() handles truncated LLM response', async () => {
    // Truncate JSON at a value boundary where repair can close braces
    const full = JSON.stringify(GOOD_PLAN)
    // Find a cut point right after a complete value (after a comma)
    const cutIdx = full.indexOf(',"hero_figure"')
    const truncated = full.slice(0, cutIdx)
    const parsed = planner.parseResponse(truncated)
    // repairTruncatedJSON should produce an object with narrative_arc
    expect(parsed).toBeDefined()
    expect(typeof parsed).toBe('object')
    expect(parsed.narrative_arc).toBeDefined()
    expect(parsed.narrative_arc.hook).toBe(
      'Neural operators can bypass SDE solving',
    )
  })

  test('validateAndFix() strips invalid claim IDs', () => {
    const { ClaimGraph } = require('../../src/paper/claim-graph/index')
    const graph = ClaimGraph.fromJSON(
      makeClaimGraph(
        makeClaim('claim-1', 'admitted', 'exploitation', 'Valid claim'),
      ),
    )

    const plan: NarrativePlan = {
      ...GOOD_PLAN,
      sections: [
        {
          name: 'intro',
          title: 'Intro',
          page_budget: 2,
          claims_covered: ['claim-1', 'invalid-id', 'also-invalid'],
          key_points: ['test'],
          tone: 'assertive',
          demoted_claims_here: ['invalid-id'],
        },
      ],
    }

    const fixed = planner.validateAndFix(plan, null, graph)
    expect(fixed.sections[0].claims_covered).toEqual(['claim-1'])
    expect(fixed.sections[0].demoted_claims_here).toEqual([])
  })

  test('validateAndFix() scales page budgets when exceeding limit', () => {
    const { ClaimGraph } = require('../../src/paper/claim-graph/index')
    const graph = ClaimGraph.fromJSON(makeClaimGraph())
    const template = makeTemplate()

    const plan: NarrativePlan = {
      ...GOOD_PLAN,
      sections: [
        {
          name: 'intro',
          title: 'Intro',
          page_budget: 5,
          claims_covered: [],
          key_points: [],
          tone: 'assertive',
        },
        {
          name: 'method',
          title: 'Method',
          page_budget: 5,
          claims_covered: [],
          key_points: [],
          tone: 'assertive',
        },
        {
          name: 'results',
          title: 'Results',
          page_budget: 5,
          claims_covered: [],
          key_points: [],
          tone: 'assertive',
        },
      ],
    }

    // Total = 15, limit = 9
    const fixed = planner.validateAndFix(plan, template.constraints, graph)
    const total = fixed.sections.reduce((s, sec) => s + sec.page_budget, 0)
    expect(total).toBeLessThanOrEqual(9)
  })

  test('validateAndFix() adds missing required sections', () => {
    const { ClaimGraph } = require('../../src/paper/claim-graph/index')
    const graph = ClaimGraph.fromJSON(makeClaimGraph())
    const template = makeTemplate()

    const plan: NarrativePlan = {
      ...GOOD_PLAN,
      sections: [
        {
          name: 'methodology',
          title: 'Methodology',
          page_budget: 3,
          claims_covered: [],
          key_points: [],
          tone: 'assertive',
        },
      ],
    }

    const fixed = planner.validateAndFix(plan, template.constraints, graph)
    const names = fixed.sections.map(s => s.name)
    expect(names).toContain('introduction')
    expect(names).toContain('related-work')
    expect(names).toContain('conclusion')
  })

  test('readExperimentResults() reads artifacts from disk', () => {
    const resultsDir = join(tmpDir, 'experiments')
    mkdirSync(resultsDir, { recursive: true })
    writeFileSync(
      join(resultsDir, 'result1.json'),
      JSON.stringify({ accuracy: 0.95, speedup: 10.2 }),
    )

    const entries: ArtifactEntry[] = [
      {
        id: 'exp-1',
        type: 'experiment_result',
        path: 'experiments/result1.json',
        created_by: 'experiment-runner',
        created_at: new Date().toISOString(),
        description: 'Calibration benchmark',
      },
      {
        id: 'exp-2',
        type: 'experiment_code', // Not a result — should be skipped
        path: 'experiments/run.py',
        created_by: 'experiment-runner',
        created_at: new Date().toISOString(),
        description: 'Runner script',
      },
    ]

    const results = planner.readExperimentResults(entries)
    expect(results.length).toBe(1)
    expect(results[0].id).toBe('exp-1')
    expect(results[0].summary).toContain('accuracy')
  })

  test('extractKeyTurningPoints() filters significant trajectory events', () => {
    const trajectory: TrajectoryEntry[] = [
      {
        timestamp: new Date().toISOString(),
        action_type: 'experiment_run',
        agent: 'experiment-runner',
        description: 'Ran benchmark',
        outcome: 'Got 10x speedup — exceeds expectations',
        state_changes: [],
        claim_graph_delta: {
          claims_added: 0,
          claims_admitted: 1,
          claims_demoted: 0,
          claims_rejected: 0,
          edges_added: 0,
        },
        cycle: 3,
      },
      {
        timestamp: new Date().toISOString(),
        action_type: 'reflect',
        agent: 'orchestrator',
        description: 'Reflection',
        outcome: 'ok',
        state_changes: [],
        cycle: 4,
      },
      {
        timestamp: new Date().toISOString(),
        action_type: 'literature_search',
        agent: 'investigator',
        description: 'Searched for competing methods',
        outcome: 'Found 3 new baselines that we should compare against',
        state_changes: [],
        cycle: 5,
      },
    ]

    const points = planner.extractKeyTurningPoints(trajectory)
    // First entry: significant delta (claims_admitted > 0)
    // Second entry: no delta, no experiment/literature — filtered out
    // Third entry: literature action with substantive outcome
    expect(points.length).toBe(2)
    expect(points[0].cycle).toBe(3)
    expect(points[1].cycle).toBe(5)
  })

  test('narrativePlanToStructure() produces valid PaperStructure', () => {
    const structure = narrativePlanToStructure(
      GOOD_PLAN,
      'Test Paper',
      'neurips',
    )

    expect(structure.title).toBe('Test Paper')
    expect(structure.template).toBe('neurips')
    expect(structure.sections.length).toBe(
      GOOD_PLAN.sections.length + GOOD_PLAN.appendix_sections.length,
    )

    // All main sections have empty fragments
    for (const s of structure.sections.slice(0, GOOD_PLAN.sections.length)) {
      expect(s.fragments).toEqual([])
      expect(s.needs_transition).toBe(true)
    }

    // Appendix section has source_fragment
    const appendixSection = structure.sections[structure.sections.length - 1]
    expect(appendixSection.name).toBe('proof-details')
    expect(appendixSection.needs_transition).toBe(false)
    expect(appendixSection.fragments).toEqual(['frag-proof-1'])
  })

  test('plan() with empty claim graph', async () => {
    const state = makeState({
      claimGraph: makeClaimGraph(),
    })
    const template = makeTemplate()
    const plan = await planner.plan(state, template)

    // Should still return a valid plan (LLM returns the mocked plan)
    expect(plan.sections.length).toBeGreaterThan(0)
  })

  test('plan() with no experiments (theoretical paper)', async () => {
    const state = makeState({
      paper_type: 'theoretical',
      artifacts: {
        entries: [],
        literature_db: null,
        selected_proposal: null,
        paper_tex: null,
        compiled_pdf: null,
      },
    })
    const template = makeTemplate()
    const plan = await planner.plan(state, template)

    expect(plan.narrative_arc).toBeDefined()
    expect(plan.sections.length).toBeGreaterThan(0)
  })
})
