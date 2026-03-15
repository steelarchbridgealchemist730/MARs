import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PromptAssembler } from '../../src/paper/claim-graph/prompt-assembler'
import { ClaimGraph } from '../../src/paper/claim-graph/index'
import { EvidencePoolManager } from '../../src/paper/evidence-pool'
import { DKPLoader } from '../../src/paper/domain-knowledge/loader'
import { DKP_PATHS } from '../../src/paper/domain-knowledge/types'
import { estimateTokens } from '../../src/paper/claim-graph/token-utils'
import type {
  DKPManifest,
  KnowledgeEntry,
  DirectionSummary,
} from '../../src/paper/domain-knowledge/types'
import type {
  ResearchState,
  StabilityMetrics,
} from '../../src/paper/research-state'

// ── Helpers ──────────────────────────────────────────────

function makeMinimalState(): ResearchState {
  return {
    proposal: {
      id: 'test',
      title: 'Test Proposal',
      abstract: 'Testing DKP context injection',
      methodology: 'unit testing',
      innovation: [],
      novelty_score: 0.8,
      impact_score: 0.7,
      feasibility: { score: 0.9, data_required: '' },
    } as any,
    paper_type: 'theoretical',
    claimGraph: { claims: [], edges: [] },
    evidencePool: { grounded: [], derived: [] },
    stability: {
      convergenceScore: 0.3,
      admittedClaimCount: 0,
      proposedClaimCount: 0,
      weakestBridge: null,
      paperReadiness: 'needs_work',
      evidenceCoverage: 0.5,
      lastArbiterAssessment: '',
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
      total_usd: 100,
      spent_usd: 5,
      remaining_usd: 95,
      breakdown: {},
    } as any,
    time: {
      started_at: new Date().toISOString(),
      deadline: null,
      estimated_completion: null,
    } as any,
    compute: null,
    artifacts: { entries: [] } as any,
    trajectory: [],
    loaded_knowledge_packs: [],
    initialized: true,
    orchestrator_cycle_count: 0,
  } as any
}

function makeManifest(overrides: Partial<DKPManifest> = {}): DKPManifest {
  return {
    id: 'test-pack',
    name: 'Test Knowledge Pack',
    version: '1.0.0',
    description: 'A test DKP for context injection tests',
    sources: { textbooks: [], papers: [] },
    stats: {
      entries_total: 5,
      theorems: 3,
      definitions: 1,
      algorithms: 1,
      results: 0,
      datasets: 2,
      benchmarks: 1,
      codebases: 1,
    },
    context_sizes: {
      l0_overview_tokens: 100,
      l1_directions_tokens: 200,
      l2_entry_avg_tokens: 50,
    },
    built_at: '2026-01-01T00:00:00Z',
    built_with: 'claude-paper',
    ...overrides,
  }
}

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: 'thm-001',
    type: 'theorem',
    source: { id: 'test-book', chapter: '1', section: '1.1', page: 5 },
    label: 'Convergence Theorem',
    name: 'Convergence of Gradient Descent',
    statement:
      'Under L-smoothness and strong convexity, gradient descent converges at rate O(1/k).',
    proof_sketch: 'Use descent lemma + strong convexity bound.',
    proof_technique: 'descent lemma',
    proof_difficulty: 'moderate',
    usability: { citable: true, common_use: 'proving convergence rates' },
    relations: {
      depends_on: [],
      used_by: [],
      generalizes: null,
      specialized_by: [],
    },
    tags: ['optimization', 'convergence', 'gradient'],
    ...overrides,
  }
}

function createFakePack(
  packsDir: string,
  packName: string,
  opts: {
    manifest?: Partial<DKPManifest>
    overview?: string
    entries?: KnowledgeEntry[]
    datasets?: unknown[]
    benchmarks?: unknown[]
    codebases?: unknown[]
  } = {},
): void {
  const packDir = join(packsDir, packName)

  mkdirSync(join(packDir, 'knowledge', 'entries'), { recursive: true })
  mkdirSync(join(packDir, 'knowledge', 'directions'), { recursive: true })
  mkdirSync(join(packDir, 'registries'), { recursive: true })
  mkdirSync(join(packDir, 'index'), { recursive: true })

  const manifest = makeManifest({
    id: packName,
    name: packName,
    ...opts.manifest,
  })
  writeJSON(join(packDir, DKP_PATHS.manifest), manifest)

  writeFileSync(
    join(packDir, DKP_PATHS.knowledge.overview),
    opts.overview ??
      '# Test Domain\n\nThis domain covers optimization and convergence theory.',
    'utf-8',
  )

  writeJSON(join(packDir, 'knowledge', 'directions', 'directions.json'), [
    {
      id: 'opt',
      name: 'Optimization',
      summary: 'Optimization methods.',
      entry_count: 3,
      key_entries: ['thm-001'],
    },
  ])

  const entries = opts.entries ?? [
    makeEntry({ id: 'thm-001' }),
    makeEntry({
      id: 'thm-002',
      label: 'Strong Convexity Bound',
      tags: ['convexity', 'optimization'],
    }),
    makeEntry({
      id: 'def-001',
      type: 'definition',
      label: 'L-Smoothness',
      tags: ['smoothness', 'optimization'],
    }),
  ]
  for (const entry of entries) {
    writeJSON(join(packDir, 'knowledge', 'entries', `${entry.id}.json`), entry)
  }
  writeJSON(join(packDir, 'knowledge', 'entries', '.counters.json'), {
    thm: 2,
    def: 1,
  })

  writeJSON(join(packDir, DKP_PATHS.knowledge.connections), { edges: [] })

  // Build indices
  writeJSON(join(packDir, DKP_PATHS.index.byType), {
    theorem: entries.filter(e => e.type === 'theorem').map(e => e.id),
    proposition: [],
    lemma: [],
    corollary: [],
    definition: entries.filter(e => e.type === 'definition').map(e => e.id),
    algorithm: [],
    result: [],
  })

  // Build topic index from tags
  const byTopic: Record<string, string[]> = {}
  for (const e of entries) {
    for (const tag of e.tags) {
      const key = tag.toLowerCase()
      if (!byTopic[key]) byTopic[key] = []
      byTopic[key].push(e.id)
    }
  }
  writeJSON(join(packDir, DKP_PATHS.index.byTopic), byTopic)
  writeJSON(join(packDir, DKP_PATHS.index.bySource), {
    'test-book': entries.map(e => e.id),
  })

  // Build full-text index
  const fullText: Record<string, string[]> = {}
  for (const e of entries) {
    const words = e.statement
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
    for (const w of words) {
      if (!fullText[w]) fullText[w] = []
      if (!fullText[w].includes(e.id)) fullText[w].push(e.id)
    }
  }
  writeJSON(join(packDir, DKP_PATHS.index.fullText), fullText)

  // Registries
  writeJSON(
    join(packDir, DKP_PATHS.registries.datasets),
    opts.datasets ?? [
      { name: 'MNIST', description: 'Handwritten digits', access: 'free' },
      { name: 'CIFAR-10', description: 'Object images', access: 'free' },
    ],
  )
  writeJSON(
    join(packDir, DKP_PATHS.registries.benchmarks),
    opts.benchmarks ?? [
      {
        name: 'MLPerf',
        description: 'ML benchmark',
        standard_metrics: ['throughput'],
        standard_baselines: ['SGD'],
        source: 'mlperf.org',
      },
    ],
  )
  writeJSON(
    join(packDir, DKP_PATHS.registries.codebases),
    opts.codebases ?? [
      {
        name: 'PyTorch',
        repo_url: 'https://github.com/pytorch/pytorch',
        language: 'Python',
        implements: 'Deep learning framework',
      },
    ],
  )
}

function writeJSON(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

// ── Tests ────────────────────────────────────────────────

describe('DKP Context Injection — PromptAssembler', () => {
  let tempDir: string
  let packsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dkp-ctx-test-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('buildDomainKnowledgeContext returns empty when no DKPLoader', () => {
    const state = makeMinimalState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)

    const pa = new PromptAssembler(graph, pool, state, 2)
    const prompt = pa.assembleBuilder()

    // Should not contain Domain Knowledge section
    expect(prompt).not.toContain('## Domain Knowledge')
  })

  test('buildDomainKnowledgeContext returns empty when no packs loaded', () => {
    const state = makeMinimalState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)
    const loader = new DKPLoader(packsDir)

    const pa = new PromptAssembler(graph, pool, state, 2, loader)
    const prompt = pa.assembleBuilder()

    expect(prompt).not.toContain('## Domain Knowledge')
  })

  test('buildDomainKnowledgeContext injects overview when pack loaded', () => {
    createFakePack(packsDir, 'test-pack', {
      overview:
        '# Optimization\n\nThis domain covers gradient methods and convergence theory.',
    })

    const state = makeMinimalState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')

    const pa = new PromptAssembler(graph, pool, state, 2, loader)
    const prompt = pa.assembleBuilder()

    expect(prompt).toContain('## Domain Knowledge')
    expect(prompt).toContain('gradient methods')
    expect(prompt).toContain('knowledge entries available')
  })

  test('buildDomainKnowledgeContext includes registry summary', () => {
    createFakePack(packsDir, 'test-pack')

    const state = makeMinimalState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')

    const pa = new PromptAssembler(graph, pool, state, 2, loader)
    const prompt = pa.assembleBuilder()

    expect(prompt).toContain('MNIST')
    expect(prompt).toContain('MLPerf')
    expect(prompt).toContain('PyTorch')
  })

  test('DKP context stays within token budget', () => {
    // Create a pack with a long overview
    const longOverview =
      '# Big Domain\n\n' + 'This is a comprehensive overview. '.repeat(200)
    createFakePack(packsDir, 'big-pack', { overview: longOverview })

    const state = makeMinimalState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)
    const loader = new DKPLoader(packsDir)
    loader.load('big-pack')

    const pa = new PromptAssembler(graph, pool, state, 2, loader)
    const prompt = pa.assembleBuilder()

    // Total prompt should not exceed MAX_PROMPT_TOKENS (12000)
    const totalTokens = estimateTokens(prompt)
    expect(totalTokens).toBeLessThanOrEqual(12000)
  })

  test('update() can set new DKPLoader', () => {
    const state = makeMinimalState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)

    // Start with no loader
    const pa = new PromptAssembler(graph, pool, state, 2)
    let prompt = pa.assembleBuilder()
    expect(prompt).not.toContain('## Domain Knowledge')

    // Now create a loader and update
    createFakePack(packsDir, 'test-pack')
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')
    pa.update(graph, pool, state, 2, loader)

    prompt = pa.assembleBuilder()
    expect(prompt).toContain('## Domain Knowledge')
  })

  test('multiple packs inject context from all', () => {
    createFakePack(packsDir, 'pack-a', {
      manifest: { name: 'Pack Alpha' },
      overview: '# Alpha Domain\n\nAlpha-specific knowledge about widgets.',
      datasets: [
        { name: 'AlphaDS', description: 'alpha data', access: 'free' },
      ],
      benchmarks: [],
      codebases: [],
    })
    createFakePack(packsDir, 'pack-b', {
      manifest: { name: 'Pack Beta' },
      overview: '# Beta Domain\n\nBeta-specific knowledge about gadgets.',
      datasets: [{ name: 'BetaDS', description: 'beta data', access: 'free' }],
      benchmarks: [],
      codebases: [],
    })

    const state = makeMinimalState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)
    const loader = new DKPLoader(packsDir)
    loader.load('pack-a')
    loader.load('pack-b')

    const pa = new PromptAssembler(graph, pool, state, 2, loader)
    const prompt = pa.assembleBuilder()

    expect(prompt).toContain('AlphaDS')
    expect(prompt).toContain('BetaDS')
  })
})

describe('DKP Context Injection — K8: token budget enforcement', () => {
  let tempDir: string
  let packsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dkp-k8-budget-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('DKP context section is under 800 tokens', () => {
    createFakePack(packsDir, 'test-pack')

    const state = makeMinimalState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')

    const pa = new PromptAssembler(graph, pool, state, 2, loader)
    const prompt = pa.assembleBuilder()

    // Extract the Domain Knowledge section
    const dkStart = prompt.indexOf('## Domain Knowledge')
    if (dkStart === -1) {
      // If no section at all, budget is trivially satisfied
      return
    }
    // Find the next ## heading or end of string
    const nextSection = prompt.indexOf('\n## ', dkStart + 1)
    const dkSection =
      nextSection === -1
        ? prompt.slice(dkStart)
        : prompt.slice(dkStart, nextSection)

    const tokens = estimateTokens(dkSection)
    expect(tokens).toBeLessThanOrEqual(800)
  })

  test('DKP context under 800 tokens even with large overview', () => {
    // Create pack with 5000+ token overview
    const longOverview =
      '# Comprehensive Optimization Theory\n\n' +
      'This is a very detailed overview of optimization theory covering gradient descent, ' +
      'stochastic gradient descent, Adam, RMSProp, and many other methods. '.repeat(
        100,
      )

    createFakePack(packsDir, 'big-pack', {
      overview: longOverview,
    })

    const state = makeMinimalState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)
    const loader = new DKPLoader(packsDir)
    loader.load('big-pack')

    const pa = new PromptAssembler(graph, pool, state, 2, loader)
    const prompt = pa.assembleBuilder()

    // Extract DKP section
    const dkStart = prompt.indexOf('## Domain Knowledge')
    if (dkStart === -1) return

    const nextSection = prompt.indexOf('\n## ', dkStart + 1)
    const dkSection =
      nextSection === -1
        ? prompt.slice(dkStart)
        : prompt.slice(dkStart, nextSection)

    const tokens = estimateTokens(dkSection)
    expect(tokens).toBeLessThanOrEqual(800)
  })
})
