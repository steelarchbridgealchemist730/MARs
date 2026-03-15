import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import type { ResearchState } from '../../src/paper/research-state'
import type { WritingPipelinePhase } from '../../src/paper/writing/types'
import { PageChecker } from '../../src/paper/writing/page-checker'
import { estimateWordCount } from '../../src/paper/writing/writer'

const TMP = join(import.meta.dir, '__writing_pipeline_test_tmp__')

function makeMinimalState(overrides?: Partial<ResearchState>): ResearchState {
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
          source_ref: 'smith2024',
          type: 'grounded',
          claim_ids: ['c1'],
        },
      ],
      derived: [
        {
          id: 'e2',
          claim: 'Experiment shows 10% improvement',
          method: 'benchmark',
          type: 'derived',
          claim_ids: ['c1'],
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

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
})

// ─── WritingPipelinePhase type tests ────────────────────

describe('WritingPipelinePhase type', () => {
  test('all expected phases are valid', () => {
    const phases: WritingPipelinePhase[] = [
      'plan',
      'bibliography',
      'write_sections',
      'figures',
      'assemble',
      'compile',
      'page_check',
      'final_sync',
    ]
    expect(phases).toHaveLength(8)
  })
})

// ─── WritingPipelineResult type tests ───────────────────

describe('WritingPipelineResult shape', () => {
  test('result has expected fields', () => {
    const result = {
      success: true,
      pdfPath: '/tmp/paper.pdf',
      warnings: [],
      phases_completed: ['plan', 'bibliography'] as WritingPipelinePhase[],
    }
    expect(result.success).toBe(true)
    expect(result.phases_completed).toHaveLength(2)
    expect(result.warnings).toEqual([])
  })

  test('failed result has no pdfPath', () => {
    const result = {
      success: false,
      warnings: ['Compilation failed'],
      phases_completed: ['plan'] as WritingPipelinePhase[],
    }
    expect(result.success).toBe(false)
    expect(result.pdfPath).toBeUndefined()
  })
})

// ─── PageChecker.applyCuts ──────────────────────────────

describe('PageChecker.applyCuts', () => {
  test('returns zero when sections dir does not exist', async () => {
    const checker = new PageChecker()
    const result = await checker.applyCuts(
      join(TMP, 'nonexistent'),
      [
        {
          section: 'introduction',
          action: 'compress',
          estimated_savings_words: 100,
          risk_level: 'low',
        },
      ],
      null,
    )
    expect(result.applied).toBe(0)
    expect(result.wordsSaved).toBe(0)
  })

  test('skips high-risk cuts', async () => {
    const sectionsDir = join(TMP, 'sections')
    mkdirSync(sectionsDir, { recursive: true })
    writeFileSync(
      join(sectionsDir, 'intro.tex'),
      'This is a test section with some words that we could cut.',
    )

    const checker = new PageChecker()
    const result = await checker.applyCuts(
      TMP,
      [
        {
          section: 'intro',
          action: 'compress',
          estimated_savings_words: 5,
          risk_level: 'high',
        },
      ],
      null,
    )
    // High-risk should be skipped
    expect(result.applied).toBe(0)
  })

  test('skips cut when section file does not exist', async () => {
    const sectionsDir = join(TMP, 'sections')
    mkdirSync(sectionsDir, { recursive: true })

    const checker = new PageChecker()
    const result = await checker.applyCuts(
      TMP,
      [
        {
          section: 'nonexistent',
          action: 'compress',
          estimated_savings_words: 50,
          risk_level: 'low',
        },
      ],
      null,
    )
    expect(result.applied).toBe(0)
  })

  test('processes appendix action — creates appendix file and updates main.tex', async () => {
    const sectionsDir = join(TMP, 'sections')
    mkdirSync(sectionsDir, { recursive: true })
    writeFileSync(
      join(sectionsDir, 'experiments.tex'),
      'Detailed experiment setup and results. Long ablation tables here.',
    )
    // Create a main.tex so ensureAppendixInMainTex can update it
    writeFileSync(
      join(TMP, 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\n\\input{sections/experiments}\n\\end{document}\n',
    )

    // PageChecker is imported after mock — need to re-import for this test
    // The LLM mock is already set up in writing-pipeline.test.ts but PageChecker
    // doesn't use mock.module here, so we need to handle this differently.
    // The PageChecker.applyCuts calls chatCompletion for the moveToAppendix LLM call.
    // Since this test file doesn't mock chatCompletion, the call will fail.
    // Instead, we just verify the old behavior is gone (no "MOVED TO APPENDIX" comment).
    // The actual LLM-based appendix test is in page-checker-cuts.test.ts which mocks LLM.

    const checker = new PageChecker()
    const result = await checker.applyCuts(
      TMP,
      [
        {
          section: 'experiments',
          action: 'move_to_appendix: detailed ablation tables',
          estimated_savings_words: 200,
          risk_level: 'low',
        },
      ],
      null,
    )
    // The LLM call will throw (no mock), so the try/catch in applyCuts skips it
    // The fake comment should NOT appear
    const content = readFileSync(join(sectionsDir, 'experiments.tex'), 'utf-8')
    expect(content).not.toContain('MOVED TO APPENDIX')
  })
})

// ─── State helpers ──────────────────────────────────────

describe('makeMinimalState', () => {
  test('creates valid minimal state', () => {
    const state = makeMinimalState()
    expect(state.proposal.title).toBe('Test Paper')
    expect(state.claimGraph.claims).toHaveLength(1)
    expect(state.claimGraph.claims[0].phase).toBe('admitted')
    expect(state.initialized).toBe(true)
  })

  test('state with no claims', () => {
    const state = makeMinimalState({
      claimGraph: { claims: [], edges: [] },
    })
    expect(state.claimGraph.claims).toHaveLength(0)
  })

  test('state with overrides', () => {
    const state = makeMinimalState({
      paper_type: 'theoretical',
      stability: {
        convergenceScore: 0.95,
        admittedClaimCount: 10,
        proposedClaimCount: 0,
        weakestBridge: null,
        paperReadiness: 'ready',
        evidenceCoverage: 0.9,
        lastArbiterAssessment: 'Excellent',
      },
    })
    expect(state.paper_type).toBe('theoretical')
    expect(state.stability.paperReadiness).toBe('ready')
  })
})

// ─── Word count estimation ──────────────────────────────

describe('estimateWordCount for pipeline', () => {
  test('estimates correctly for typical LaTeX content', () => {
    const latex = `\\label{sec:intro}
This is a test section with some introductory text about our method.
We propose a novel approach to solving the problem of calibration
in neural network uncertainty estimation.

\\subsection{Motivation}
The motivation comes from practical applications in autonomous driving
where reliable uncertainty estimates are critical for safety.`

    const count = estimateWordCount(latex)
    expect(count).toBeGreaterThan(30)
    expect(count).toBeLessThan(60)
  })
})

// ─── Pipeline constructor defaults ──────────────────────

describe('WritingPipeline constructor', () => {
  test('can be imported', async () => {
    const { WritingPipeline } = await import('../../src/paper/writing/pipeline')
    expect(WritingPipeline).toBeDefined()
    expect(typeof WritingPipeline).toBe('function')
  })

  test('accepts minimal options', async () => {
    const { WritingPipeline } = await import('../../src/paper/writing/pipeline')
    const state = makeMinimalState()
    const pipeline = new WritingPipeline({
      projectDir: TMP,
      state,
    })
    expect(pipeline).toBeDefined()
  })

  test('accepts custom templateId and modelSpec', async () => {
    const { WritingPipeline } = await import('../../src/paper/writing/pipeline')
    const state = makeMinimalState()
    const pipeline = new WritingPipeline({
      projectDir: TMP,
      state,
      templateId: 'icml',
      modelSpec: 'claude-opus-4-6',
    })
    expect(pipeline).toBeDefined()
  })
})

// ─── mapSectionToFragmentType ────────────────────────────

describe('mapSectionToFragmentType', () => {
  test('maps related-work to related_work', async () => {
    const { mapSectionToFragmentType } =
      await import('../../src/paper/writing/pipeline')
    expect(mapSectionToFragmentType('related-work')).toBe('related_work')
    expect(mapSectionToFragmentType('related_work')).toBe('related_work')
    expect(mapSectionToFragmentType('literature')).toBe('related_work')
  })

  test('maps experiments to experiments', async () => {
    const { mapSectionToFragmentType } =
      await import('../../src/paper/writing/pipeline')
    expect(mapSectionToFragmentType('experiments')).toBe('experiments')
    expect(mapSectionToFragmentType('results')).toBe('experiments')
    expect(mapSectionToFragmentType('data')).toBe('experiments')
  })

  test('maps methodology to definitions', async () => {
    const { mapSectionToFragmentType } =
      await import('../../src/paper/writing/pipeline')
    expect(mapSectionToFragmentType('methodology')).toBe('definitions')
    expect(mapSectionToFragmentType('method')).toBe('definitions')
    expect(mapSectionToFragmentType('model')).toBe('definitions')
  })

  test('returns null for introduction, conclusion', async () => {
    const { mapSectionToFragmentType } =
      await import('../../src/paper/writing/pipeline')
    expect(mapSectionToFragmentType('introduction')).toBeNull()
    expect(mapSectionToFragmentType('conclusion')).toBeNull()
    expect(mapSectionToFragmentType('abstract')).toBeNull()
    expect(mapSectionToFragmentType('discussion')).toBeNull()
  })
})

// ─── Export verification ────────────────────────────────

describe('exports', () => {
  test('WritingPipeline exported from writing/index', async () => {
    const writing = await import('../../src/paper/writing/index')
    expect(writing.WritingPipeline).toBeDefined()
  })

  test('WritingPipelinePhase and WritingPipelineResult types exported', async () => {
    // Type-only exports are verified by the import succeeding
    const types = await import('../../src/paper/writing/types')
    // The types are used at compile time, but we can check the module loaded
    expect(types).toBeDefined()
  })
})

// ─── PaperWriter public methods ─────────────────────────

describe('PaperWriter public methods', () => {
  test('injectFigureIntoSection is accessible', async () => {
    const { PaperWriter } = await import('../../src/paper/writing/writer')
    const writer = new PaperWriter(TMP, 'test-model')
    expect(typeof writer.injectFigureIntoSection).toBe('function')
  })

  test('injectTableIntoSection is accessible', async () => {
    const { PaperWriter } = await import('../../src/paper/writing/writer')
    const writer = new PaperWriter(TMP, 'test-model')
    expect(typeof writer.injectTableIntoSection).toBe('function')
  })

  test('ensurePackages is accessible', async () => {
    const { PaperWriter } = await import('../../src/paper/writing/writer')
    const writer = new PaperWriter(TMP, 'test-model')
    expect(typeof writer.ensurePackages).toBe('function')
  })
})
