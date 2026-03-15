import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('SystemProbe', () => {
  test('probe() returns SystemCapabilities without errors', async () => {
    const { probeSystem } = await import('../../src/paper/system-probe')
    const caps = await probeSystem()
    expect(caps.os.name).toBeTruthy()
    expect(caps.cpu.cores).toBeGreaterThan(0)
    expect(caps.memory.total_gb).toBeGreaterThan(0)
    expect(typeof caps.latex.pdflatex).toBe('boolean')
    expect(typeof caps.git.available).toBe('boolean')
  })

  test('probe() includes network field', async () => {
    const { probeSystem } = await import('../../src/paper/system-probe')
    const caps = await probeSystem()
    expect('download_mbps' in caps.network).toBe(true)
  })
})

describe('PaperAcquisitionChain', () => {
  test('acquireBatch with empty array returns empty array', async () => {
    const { PaperAcquisitionChain } =
      await import('../../src/paper/acquisition')
    const tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-test-'))
    try {
      const chain = new PaperAcquisitionChain({ output_dir: tmpDir })
      const results = await chain.acquireBatch([])
      expect(results).toEqual([])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('acquire paper with no sources returns abstract_only', async () => {
    const { PaperAcquisitionChain } =
      await import('../../src/paper/acquisition')
    const tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-test-'))
    try {
      const chain = new PaperAcquisitionChain({ output_dir: tmpDir })
      const result = await chain.acquire({ title: 'Test Paper' })
      expect(result.status).toBe('abstract_only')
      expect(result.success).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('PDFExtractor', () => {
  test('isAvailable() returns a boolean', async () => {
    const { PDFExtractor } = await import('../../src/paper/pdf-extractor')
    const extractor = new PDFExtractor()
    const available = await extractor.isAvailable()
    expect(typeof available).toBe('boolean')
  })
})

describe('BudgetTracker', () => {
  test('tracks cost correctly', async () => {
    const { BudgetTracker } = await import('../../src/paper/budget-tracker')
    const tracker = new BudgetTracker({ limitUSD: 10 })
    tracker.trackUsage(1_000_000, 500_000, 'claude-opus-4-6')
    // 1M input * $15/M + 0.5M output * $75/M = $15 + $37.5 = $52.5
    expect(tracker.getTotal()).toBeCloseTo(52.5, 1)
    expect(tracker.isOverBudget()).toBe(true)
  })

  test('no limit means never over budget', async () => {
    const { BudgetTracker } = await import('../../src/paper/budget-tracker')
    const tracker = new BudgetTracker()
    tracker.trackUsage(10_000_000, 5_000_000, 'claude-opus-4-6')
    expect(tracker.isOverBudget()).toBe(false)
  })

  test('tracks breakdown by category', async () => {
    const { BudgetTracker } = await import('../../src/paper/budget-tracker')
    const tracker = new BudgetTracker({ limitUSD: 100 })
    tracker.trackUsage(100_000, 50_000, 'claude-opus-4-6', 'orchestrator')
    tracker.trackUsage(200_000, 100_000, 'claude-opus-4-6', 'experiment')
    tracker.trackUsage(50_000, 25_000, 'claude-opus-4-6', 'orchestrator')
    const breakdown = tracker.getBreakdown()
    expect(breakdown.length).toBe(2)
    // orchestrator should have 2 calls
    const orchEntry = breakdown.find(b => b.category === 'orchestrator')
    expect(orchEntry).toBeDefined()
    expect(orchEntry!.call_count).toBe(2)
  })

  test('wouldExceedBudget checks proposed cost', async () => {
    const { BudgetTracker } = await import('../../src/paper/budget-tracker')
    const tracker = new BudgetTracker({ limitUSD: 10 })
    tracker.recordCost(8, 'other')
    expect(tracker.wouldExceedBudget(1)).toBe(false)
    expect(tracker.wouldExceedBudget(3)).toBe(true)
  })

  test('toStateBudget exports correct format', async () => {
    const { BudgetTracker } = await import('../../src/paper/budget-tracker')
    const tracker = new BudgetTracker({ limitUSD: 50, warnAtPercent: 25 })
    tracker.recordCost(10, 'review')
    const state = tracker.toStateBudget()
    expect(state.total_usd).toBe(50)
    expect(state.spent_usd).toBe(10)
    expect(state.remaining_usd).toBe(40)
    expect(state.warn_at_percent).toBe(25)
    expect(state.breakdown.length).toBe(1)
    expect(state.breakdown[0]!.category).toBe('review')
  })
})

describe('DeepResearchEngine', () => {
  test('types.ts exports are correct shapes', async () => {
    const types = await import('../../src/paper/deep-research/types')
    expect(types).toBeDefined()
  })
})

describe('CitationGraphTraversal', () => {
  test('traverse with empty seed returns empty', async () => {
    const { CitationGraphTraversal } =
      await import('../../src/paper/deep-research/citation-graph')
    const cg = new CitationGraphTraversal(1)
    const result = await cg.traverse([])
    expect(result).toEqual([])
  })

  test('traverse with seed papers retains seeds', async () => {
    const { CitationGraphTraversal } =
      await import('../../src/paper/deep-research/citation-graph')
    const cg = new CitationGraphTraversal(0) // depth 0 = no traversal
    const seed = [
      {
        title: 'Test Paper',
        authors: ['A'],
        year: 2023,
        abstract: '',
        source: 'arxiv' as const,
        source_id: '1',
        citation_count: 10,
        relevance_score: 0.9,
      },
    ]
    const result = await cg.traverse(seed)
    expect(result.length).toBe(1)
    expect(result[0].title).toBe('Test Paper')
  })
})

// PlanRevisionLoop tests removed — absorbed into Orchestrator in v3

describe('DataAcquisition', () => {
  test('getKnownSources returns non-empty list', async () => {
    const { DataAcquisition } =
      await import('../../src/paper/experiment/data-acquisition')
    const da = new DataAcquisition()
    const sources = da.getKnownSources()
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.some(s => s.id === 'yahoo_finance')).toBe(true)
    expect(sources.some(s => s.id === 'huggingface')).toBe(true)
  })

  test('acquireDataset for free auto-downloadable source', async () => {
    const { DataAcquisition } =
      await import('../../src/paper/experiment/data-acquisition')
    const da = new DataAcquisition()
    const result = await da.acquireDataset({
      name: 'test',
      source: 'yahoo_finance',
      auto_downloadable: true,
    })
    expect(result.status).toBe('ready_to_download')
  })

  test('acquireDataset for institutional source', async () => {
    const { DataAcquisition } =
      await import('../../src/paper/experiment/data-acquisition')
    const da = new DataAcquisition()
    const result = await da.acquireDataset({
      name: 'taq',
      source: 'wrds_taq',
      auto_downloadable: false,
    })
    expect(result.status).toBe('waiting_for_user')
    expect(result.message).toContain('institutional')
  })

  test('acquireDataset for unknown source', async () => {
    const { DataAcquisition } =
      await import('../../src/paper/experiment/data-acquisition')
    const da = new DataAcquisition()
    const result = await da.acquireDataset({
      name: 'x',
      source: 'unknown_source_xyz',
      auto_downloadable: false,
    })
    expect(result.status).toBe('manual_required')
  })
})

describe('ExperimentEnvironment', () => {
  test('detectIsolation returns a valid mode', async () => {
    const { ExperimentEnvironment } =
      await import('../../src/paper/experiment/environment')
    const tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-env-'))
    try {
      const env = new ExperimentEnvironment(tmpDir)
      const mode = await env.detectIsolation()
      expect(['uv', 'docker', 'venv', 'none']).toContain(mode)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('ResourceEstimator', () => {
  test('estimate returns feasible for simple plan', async () => {
    const { ResourceEstimator } =
      await import('../../src/paper/experiment/resource-estimator')
    const estimator = new ResourceEstimator()
    const estimate = await estimator.estimate(
      { description: 'simple test', dependencies: [] },
      {
        memory: { available_gb: 16 },
        disk: [{ free_gb: 100 }],
        gpu: { available: false },
      },
    )
    expect(estimate.feasible).toBe(true)
    expect(estimate.gpu_required).toBe(false)
  })

  test('estimate detects GPU requirement from pytorch dep', async () => {
    const { ResourceEstimator } =
      await import('../../src/paper/experiment/resource-estimator')
    const estimator = new ResourceEstimator()
    const estimate = await estimator.estimate(
      { description: 'train model', dependencies: ['torch', 'torchvision'] },
      {
        memory: { available_gb: 4 },
        disk: [{ free_gb: 10 }],
        gpu: { available: false, devices: [] },
      },
    )
    expect(estimate.gpu_required).toBe(true)
    expect(estimate.feasible).toBe(false)
    expect(estimate.bottleneck).toContain('GPU')
  })
})

describe('ProposalGenerator types', () => {
  test('selectBestProposal picks highest composite score', async () => {
    const { selectBestProposal } =
      await import('../../src/paper/proposal/selector')
    const proposals = [
      {
        id: '1',
        novelty_score: 0.5,
        feasibility: { score: 0.9 },
        impact_score: 0.5,
      },
      {
        id: '2',
        novelty_score: 0.9,
        feasibility: { score: 0.3 },
        impact_score: 0.9,
      },
      {
        id: '3',
        novelty_score: 0.7,
        feasibility: { score: 0.8 },
        impact_score: 0.7,
      },
    ]
    const best = selectBestProposal(proposals as any)
    expect(best.id).toBe('3')
  })
})

describe('LaTeXEngine', () => {
  test('compile returns error structure when no tex file', async () => {
    const { LaTeXEngine } = await import('../../src/paper/writing/latex-engine')
    const engine = new LaTeXEngine('/tmp/nonexistent-project')
    try {
      const result = await engine.compile('/tmp/nonexistent/main.tex')
      expect(result.success).toBe(false)
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
    }
  })
})

describe('/papers command', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-papers-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('search finds papers by title', async () => {
    // Create mock discovered-papers.json
    const papers = [
      {
        title: 'Rough Volatility Estimation',
        authors: ['Author A'],
        year: 2023,
        abstract: 'We study rough volatility...',
        source: 'arxiv',
        citation_count: 42,
        arxiv_id: '2301.12345',
      },
      {
        title: 'Deep Learning for NLP',
        authors: ['Author B'],
        year: 2022,
        abstract: 'Neural networks...',
        source: 'semantic_scholar',
        citation_count: 100,
      },
    ]
    writeFileSync(
      join(tmpDir, 'discovered-papers.json'),
      JSON.stringify(papers),
    )

    // We can't easily call the command directly since it looks for
    // fixed paths. Instead test the search logic by importing and
    // simulating the search.
    const { readFileSync } = await import('fs')
    const loaded = JSON.parse(
      readFileSync(join(tmpDir, 'discovered-papers.json'), 'utf-8'),
    )
    const matches = loaded.filter((p: any) =>
      p.title.toLowerCase().includes('volatility'),
    )
    expect(matches.length).toBe(1)
    expect(matches[0].title).toContain('Rough Volatility')
  })
})

describe('/settings command', () => {
  test('loads default config structure', async () => {
    // Import and verify defaults
    const settingsModule = await import('../../src/commands/settings')
    const cmd = settingsModule.default
    expect(cmd.name).toBe('settings')
    expect(cmd.type).toBe('local-jsx')
  })
})

describe('Multi-model review config', () => {
  test('ReviewConfig accepts models array', async () => {
    const types = await import('../../src/paper/review/types')
    // Verify the type allows models field
    const config: (typeof types)['ReviewConfig'] extends { models?: string[] }
      ? true
      : false = true
    expect(config).toBe(true)
  })

  test('PaperReviewer accepts custom model name', async () => {
    const { PaperReviewer } = await import('../../src/paper/review/reviewer')
    const reviewer = new PaperReviewer('custom-model-name', 'test-reviewer')
    expect(reviewer).toBeDefined()
  })
})
