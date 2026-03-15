import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  postProcessSection,
  extractCiteKeys,
  estimateWordCount,
  PaperWriter,
} from '../../src/paper/writing/writer'
import {
  BibTeXManager,
  formatBibTeX,
} from '../../src/paper/writing/bibtex-manager'
import type { BibTeXEntry } from '../../src/paper/writing/bibtex-manager'
import type {
  NarrativeSectionPlan,
  SectionMaterials,
} from '../../src/paper/writing/types'
import type { VenueConstraints } from '../../src/paper/writing/template-types'
import { FragmentStore } from '../../src/paper/fragment-store'
import type { ResearchState } from '../../src/paper/research-state'
import type { ClaimGraphData } from '../../src/paper/claim-graph/types'
import type { EvidencePool } from '../../src/paper/evidence-pool'

// ── Fetch stub (prevent accidental network calls) ──────

const _originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('Network disabled in test')
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = _originalFetch
})

// ── Helpers ─────────────────────────────────────────────

function makePlan(
  overrides?: Partial<NarrativeSectionPlan>,
): NarrativeSectionPlan {
  return {
    name: 'introduction',
    title: 'Introduction',
    page_budget: 1.5,
    claims_covered: [],
    key_points: ['Motivation', 'Problem statement'],
    tone: 'assertive',
    ...overrides,
  }
}

function makeConstraints(
  overrides?: Partial<VenueConstraints>,
): VenueConstraints {
  return {
    page_limits: {
      main_body: 9 as any,
      references: 'unlimited',
      appendix: 'unlimited',
    },
    formatting: {
      columns: 2,
      font_size: '10pt',
      margins: 'default',
      line_spacing: 'single',
    },
    structure: {
      required_sections: ['Abstract', 'Introduction', 'Conclusion'],
      optional_sections: [],
      abstract_word_limit: 250,
    },
    writing_guidelines: {
      page_budget: {},
      main_body_strategy: 'standard',
    },
    ...overrides,
  } as VenueConstraints
}

function setupBib(tmpDir: string, entries: BibTeXEntry[]): BibTeXManager {
  const bibPath = join(tmpDir, 'test.bib')
  const content = entries.map(e => formatBibTeX(e)).join('\n\n') + '\n'
  writeFileSync(bibPath, content, 'utf-8')
  return new BibTeXManager(bibPath)
}

function makeClaimGraphData(
  claims: Array<{
    id: string
    statement: string
    phase?: string
    epistemicLayer?: string
    type?: string
    confidence?: number
  }>,
): ClaimGraphData {
  return {
    claims: claims.map(c => ({
      id: c.id,
      type: (c.type ?? 'hypothesis') as any,
      epistemicLayer: (c.epistemicLayer ?? 'explanation') as any,
      statement: c.statement,
      phase: (c.phase ?? 'admitted') as any,
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: c.confidence ?? 0.85,
        evidenceType: 'empirical_support' as const,
        vulnerabilityScore: 0.2,
      },
      created_at: new Date().toISOString(),
      created_by: 'test',
      last_assessed_at: new Date().toISOString(),
      assessment_history: [],
    })),
    edges: [],
  }
}

function makeEvidencePool(evidence?: {
  grounded?: Array<{ claim_id: string; source_ref: string; claim: string }>
  derived?: Array<{ claim_id: string; method: string; claim: string }>
}): EvidencePool {
  return {
    grounded: (evidence?.grounded ?? []).map((e, i) => ({
      id: `g-${i}`,
      claim: e.claim,
      source_type: 'literature' as const,
      source_ref: e.source_ref,
      verified: true,
      supports_claims: [e.claim_id],
      contradicts_claims: [],
      acquired_at: new Date().toISOString(),
      acquired_by: 'test',
    })),
    derived: (evidence?.derived ?? []).map((e, i) => ({
      id: `d-${i}`,
      claim: e.claim,
      method: e.method as any,
      reproducible: true,
      artifact_id: `artifact-${i}`,
      assumptions: [],
      supports_claims: [e.claim_id],
      contradicts_claims: [],
      produced_at: new Date().toISOString(),
      produced_by: 'test',
    })),
  }
}

function makeMinimalState(overrides?: Partial<ResearchState>): ResearchState {
  return {
    proposal: {
      title: 'Test Paper',
      abstract: 'A test paper.',
      innovations: [],
    },
    paper_type: 'empirical',
    claimGraph: { claims: [], edges: [] },
    evidencePool: { grounded: [], derived: [] },
    stability: {
      convergence_score: 0.5,
      admission_rate: 0.5,
      evidence_coverage: 0.5,
      structural_vulnerability: 0.3,
      momentum: 0,
      trajectory: [],
    },
    literature_awareness: {
      deeply_read: [],
      aware_but_unread: [],
      known_results: [],
      confirmed_gaps: [],
      last_comprehensive_search: '',
    },
    theory: {
      open_conjectures: [],
      proven_theorems: [],
      proofs: [],
    },
    budget: {
      total_usd: 50,
      spent_usd: 10,
      remaining_usd: 40,
      breakdown: [],
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
    orchestrator_cycle_count: 0,
    ...overrides,
  } as ResearchState
}

// ── Tests ───────────────────────────────────────────────

describe('extractCiteKeys', () => {
  test('extracts cite keys from all variants', () => {
    const latex = String.raw`
      Some text \cite{smith2024} and \citep{jones2023} and \citet{wang2025neural}.
      Multiple: \cite{a2024, b2025, c2026}.
    `
    const keys = extractCiteKeys(latex)
    expect(keys).toEqual([
      'smith2024',
      'jones2023',
      'wang2025neural',
      'a2024',
      'b2025',
      'c2026',
    ])
  })

  test('returns empty array for no citations', () => {
    expect(extractCiteKeys('No citations here.')).toEqual([])
  })
})

describe('estimateWordCount', () => {
  test('counts words in plain text', () => {
    const count = estimateWordCount(
      'This is a simple sentence with eight words.',
    )
    // "This is a simple sentence with eight words" = 8 words
    expect(count).toBe(8)
  })

  test('strips LaTeX commands', () => {
    const latex = String.raw`\textbf{bold} and \emph{italic} text \cite{ref}`
    const count = estimateWordCount(latex)
    expect(count).toBeGreaterThanOrEqual(2) // "and", "text" at minimum
  })

  test('handles empty string', () => {
    expect(estimateWordCount('')).toBe(0)
  })
})

describe('postProcessSection', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-pp-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('fixes known missing cite key via fuzzy match', async () => {
    const bibManager = setupBib(tmpDir, [
      {
        key: 'smith2024neural',
        type: 'article',
        title: 'Neural Networks',
        authors: ['Smith'],
        year: 2024,
      },
    ])

    const latex = String.raw`Prior work by \cite{smth2024neural} showed promising results.`
    const plan = makePlan()
    const { latex: result, warnings } = await postProcessSection(
      latex,
      plan,
      null,
      bibManager,
    )

    expect(result).toContain('\\cite{smith2024neural}')
    expect(result).not.toContain('\\cite{smth2024neural}')
    expect(warnings.some(w => w.includes('auto-fixed'))).toBe(true)
  })

  test('warns on over-budget word count', async () => {
    // Generate ~2000 words on a 1-page budget (~500 words)
    const longContent = Array(400).fill('word word word word word').join(' ')
    const plan = makePlan({ page_budget: 1 })
    const { latex: result, warnings } = await postProcessSection(
      longContent,
      plan,
      null,
      null,
    )

    expect(result).toContain(
      '% WARNING: Section "introduction" exceeds page budget',
    )
    expect(warnings.some(w => w.includes('exceeds word budget'))).toBe(true)
  })

  test('preserves valid citations unchanged', async () => {
    const bibManager = setupBib(tmpDir, [
      {
        key: 'chen2024fast',
        type: 'article',
        title: 'Fast Methods',
        authors: ['Chen'],
        year: 2024,
      },
    ])

    const latex = String.raw`We follow \cite{chen2024fast} for our approach.`
    const plan = makePlan()
    const { latex: result, warnings } = await postProcessSection(
      latex,
      plan,
      null,
      bibManager,
    )

    expect(result).toContain('\\cite{chen2024fast}')
    // Should not have any citation-related warnings
    const citeWarnings = warnings.filter(
      w => w.includes('auto-fixed') || w.includes('Missing citation'),
    )
    expect(citeWarnings).toEqual([])
  })

  test('adds missing section label', async () => {
    const latex = 'Some content without a label.'
    const plan = makePlan({ name: 'introduction' })
    const { latex: result } = await postProcessSection(latex, plan, null, null)

    expect(result).toContain('\\label{sec:introduction}')
  })

  test('does not duplicate existing section label', async () => {
    const latex = '\\label{sec:introduction}\nSome content.'
    const plan = makePlan({ name: 'introduction' })
    const { latex: result } = await postProcessSection(latex, plan, null, null)

    // Count occurrences of the label
    const matches = result.match(/\\label\{sec:introduction\}/g)
    expect(matches?.length).toBe(1)
  })

  test('warns on missing cite key with no fuzzy match', async () => {
    const bibManager = setupBib(tmpDir, [
      {
        key: 'chen2024fast',
        type: 'article',
        title: 'Fast Methods',
        authors: ['Chen'],
        year: 2024,
      },
    ])

    const latex = String.raw`We cite \cite{totallyunknown2099xyz}.`
    const plan = makePlan()
    const { warnings } = await postProcessSection(latex, plan, null, bibManager)

    expect(warnings.some(w => w.includes('Missing citation key'))).toBe(true)
  })

  test('no warnings for content within budget', async () => {
    const latex = 'A short section.'
    const plan = makePlan({ page_budget: 2 })
    const { warnings } = await postProcessSection(latex, plan, null, null)

    const budgetWarnings = warnings.filter(w => w.includes('exceeds'))
    expect(budgetWarnings).toEqual([])
  })

  test('handles constraints for word-per-page estimation', async () => {
    const longContent = Array(200).fill('word word word word word').join(' ')
    const plan = makePlan({ page_budget: 0.5 })
    const constraints = makeConstraints({
      formatting: {
        columns: 2,
        font_size: '10pt',
        margins: 'default',
        line_spacing: 'single',
      },
    })
    const { warnings } = await postProcessSection(
      longContent,
      plan,
      constraints,
      null,
    )

    // 200 * 5 = 1000 words, budget = 0.5 * 700 = 350 → should exceed
    expect(warnings.some(w => w.includes('exceeds word budget'))).toBe(true)
  })
})

describe('PaperWriter.gatherMaterials', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-gm-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('resolves claim IDs to full objects', () => {
    const writer = new PaperWriter(tmpDir, 'test-model')
    const state = makeMinimalState({
      claimGraph: makeClaimGraphData([
        {
          id: 'claim-1',
          statement: 'Neural operators speed up calibration 10x',
          epistemicLayer: 'exploitation',
          type: 'hypothesis',
          confidence: 0.85,
        },
        {
          id: 'claim-2',
          statement: 'Benchmark shows 10x speedup',
          epistemicLayer: 'observation',
          type: 'result',
          confidence: 0.9,
        },
      ]),
    })

    const plan = makePlan({
      claims_covered: ['claim-1', 'claim-2'],
    })

    const materials = writer.gatherMaterials(plan, state)

    expect(materials.claims).toHaveLength(2)
    expect(materials.claims[0].id).toBe('claim-1')
    expect(materials.claims[0].statement).toBe(
      'Neural operators speed up calibration 10x',
    )
    expect(materials.claims[0].epistemicLayer).toBe('exploitation')
    expect(materials.claims[0].confidence).toBe(0.85)
    expect(materials.claims[1].id).toBe('claim-2')
  })

  test('resolves demoted claims', () => {
    const writer = new PaperWriter(tmpDir, 'test-model')
    const state = makeMinimalState({
      claimGraph: makeClaimGraphData([
        {
          id: 'claim-d1',
          statement: 'Original approach was too slow',
          phase: 'demoted',
          confidence: 0.4,
        },
      ]),
    })

    const plan = makePlan({
      demoted_claims_here: ['claim-d1'],
    })

    const materials = writer.gatherMaterials(plan, state)

    expect(materials.demotedClaims).toHaveLength(1)
    expect(materials.demotedClaims[0].statement).toBe(
      'Original approach was too slow',
    )
  })

  test('collects evidence for covered claims', () => {
    const writer = new PaperWriter(tmpDir, 'test-model')
    const state = makeMinimalState({
      claimGraph: makeClaimGraphData([{ id: 'c-1', statement: 'Test claim' }]),
      evidencePool: makeEvidencePool({
        grounded: [
          {
            claim_id: 'c-1',
            source_ref: 'Chen et al. 2024',
            claim: 'Prior work showed similar speedups',
          },
        ],
        derived: [
          {
            claim_id: 'c-1',
            method: 'experiment',
            claim: 'Experiment run-003 confirmed 10x speedup',
          },
        ],
      }),
    })

    const plan = makePlan({ claims_covered: ['c-1'] })

    const materials = writer.gatherMaterials(plan, state)

    expect(materials.evidence).toHaveLength(2)
    expect(materials.evidence[0].type).toBe('grounded')
    expect(materials.evidence[0].description).toContain('Prior work')
    expect(materials.evidence[1].type).toBe('derived')
    expect(materials.evidence[1].description).toContain('Experiment run-003')
  })

  test('reads experiment results from artifacts', () => {
    // Create an experiment result file
    const resultsDir = join(tmpDir, 'results')
    mkdirSync(resultsDir, { recursive: true })
    const resultPath = join(resultsDir, 'exp-1.json')
    writeFileSync(
      resultPath,
      JSON.stringify({ accuracy: 0.95, speedup: 10.2 }),
      'utf-8',
    )

    const writer = new PaperWriter(tmpDir, 'test-model')
    const state = makeMinimalState({
      artifacts: {
        entries: [
          {
            id: 'exp-1',
            type: 'experiment_result',
            path: 'results/exp-1.json',
            description: 'Calibration benchmark',
            created_at: new Date().toISOString(),
          },
        ],
        literature_db: null,
        selected_proposal: null,
        paper_tex: null,
        compiled_pdf: null,
      },
    })

    const plan = makePlan({ experiments_used: ['exp-1'] })

    const materials = writer.gatherMaterials(plan, state)

    expect(materials.experimentResults).not.toBeNull()
    expect(materials.experimentResults).toContain('Calibration benchmark')
    expect(materials.experimentResults).toContain('accuracy')
  })

  test('handles missing claims gracefully', () => {
    const writer = new PaperWriter(tmpDir, 'test-model')
    const state = makeMinimalState({
      claimGraph: makeClaimGraphData([
        { id: 'real-claim', statement: 'Exists' },
      ]),
    })

    const plan = makePlan({
      claims_covered: ['real-claim', 'nonexistent-claim', 'also-missing'],
    })

    const materials = writer.gatherMaterials(plan, state)

    // Only the real claim should appear
    expect(materials.claims).toHaveLength(1)
    expect(materials.claims[0].id).toBe('real-claim')
  })

  test('reads fragment previews when fragment store has assignments', () => {
    const writer = new PaperWriter(tmpDir, 'test-model')
    const store = new FragmentStore(tmpDir)
    store.init()

    const frag = store.create(
      'related_work',
      'Prior work survey',
      'Prior work on GARCH calibration has focused on traditional methods.',
    )
    store.assignToSection('introduction', frag.id)

    const state = makeMinimalState()
    const plan = makePlan({ name: 'introduction' })

    const materials = writer.gatherMaterials(plan, state)

    expect(materials.fragments).toHaveLength(1)
    expect(materials.fragments[0].id).toBe(frag.id)
    expect(materials.fragments[0].title).toBe('Prior work survey')
    expect(materials.fragments[0].preview).toContain('GARCH calibration')
  })

  test('passes through must_cite from plan', () => {
    const writer = new PaperWriter(tmpDir, 'test-model')
    const state = makeMinimalState()
    const plan = makePlan({
      must_cite: ['vaswani2017attention', 'chen2024fast'],
    })

    const materials = writer.gatherMaterials(plan, state)

    expect(materials.mustCite).toEqual(['vaswani2017attention', 'chen2024fast'])
  })

  test('gathers relatedWork from literature_awareness', () => {
    const writer = new PaperWriter(tmpDir, 'test-model')
    const state = makeMinimalState({
      literature_awareness: {
        deeply_read: [
          {
            paper_id: 'vaswani2017attention',
            key_takeaways: [
              'Self-attention enables parallelization',
              'Multi-head attention improves representation',
            ],
            relevance_to_us:
              'Foundation of transformer architecture used in our method',
            useful_techniques: ['multi-head attention'],
            potential_conflicts: [],
          },
          {
            paper_id: 'chen2024calibration',
            key_takeaways: ['Neural operators speed up calibration'],
            relevance_to_us: 'Direct competitor to our approach',
            useful_techniques: ['neural operator'],
            potential_conflicts: ['Claims faster convergence than ours'],
          },
        ],
        aware_but_unread: [],
        known_results: [
          {
            statement: 'Transformers achieve O(n^2) complexity',
            source: 'vaswani2017attention',
            confidence: 0.95,
            directly_usable: true,
          },
        ],
        confirmed_gaps: [],
        last_comprehensive_search: '2026-03-01',
      },
    })

    const plan = makePlan({ name: 'related-work' })

    const materials = writer.gatherMaterials(plan, state)

    expect(materials.relatedWork).toBeDefined()
    expect(materials.relatedWork).toContain('vaswani2017attention')
    expect(materials.relatedWork).toContain(
      'Foundation of transformer architecture',
    )
    expect(materials.relatedWork).toContain('chen2024calibration')
    expect(materials.relatedWork).toContain(
      'Known result: Transformers achieve O(n^2)',
    )
  })

  test('relatedWork is undefined when no literature data exists', () => {
    const writer = new PaperWriter(tmpDir, 'test-model')
    const state = makeMinimalState()
    const plan = makePlan()

    const materials = writer.gatherMaterials(plan, state)

    expect(materials.relatedWork).toBeUndefined()
  })

  test('returns empty materials when state has no data', () => {
    const writer = new PaperWriter(tmpDir, 'test-model')
    const state = makeMinimalState()
    const plan = makePlan()

    const materials = writer.gatherMaterials(plan, state)

    expect(materials.claims).toEqual([])
    expect(materials.demotedClaims).toEqual([])
    expect(materials.evidence).toEqual([])
    expect(materials.experimentResults).toBeNull()
    expect(materials.fragments).toEqual([])
    expect(materials.mustCite).toEqual([])
  })
})
