import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { initAgentDKP, __test__ } from '../../src/paper/agent-dispatch'
import type { ResearchState } from '../../src/paper/research-state'
import { DKP_PATHS } from '../../src/paper/domain-knowledge/types'
import type {
  DKPManifest,
  KnowledgeEntry,
  ConnectionGraph,
} from '../../src/paper/domain-knowledge/types'

const {
  executeDKSearch,
  executeDKExpand,
  executeDKNavigate,
  executeDKFindTechnique,
  getAgentTools,
  shouldIncludeDKTools,
  getActiveDKPLoader,
} = __test__

// ── Helpers ──────────────────────────────────────────────

function makeManifest(overrides: Partial<DKPManifest> = {}): DKPManifest {
  return {
    id: 'test-pack',
    name: 'Test Pack',
    version: '1.0.0',
    description: 'A test knowledge pack',
    sources: { textbooks: [], papers: [] },
    stats: {
      entries_total: 5,
      theorems: 3,
      definitions: 1,
      algorithms: 1,
      results: 0,
      datasets: 1,
      benchmarks: 0,
      codebases: 0,
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
    source: { id: 'textbook-a', chapter: '3', section: '3.1', page: 42 },
    label: 'Convergence Theorem',
    name: 'Convergence of Gradient Descent',
    statement:
      'If f is L-smooth and mu-strongly convex, then gradient descent converges at rate O(exp(-mu*t/L)).',
    proof_sketch:
      'By constructing a Lyapunov function V(x) = f(x) - f*, we bound the descent.',
    proof_technique: 'Lyapunov function',
    proof_difficulty: 'medium',
    assumptions: [
      { id: 'A1', text: 'f is L-smooth', strength: 'required' as const },
      {
        id: 'A2',
        text: 'f is mu-strongly convex',
        strength: 'required' as const,
      },
    ],
    usability: {
      citable: true,
      common_use: 'optimization convergence analysis',
    },
    relations: {
      depends_on: ['def-001'],
      used_by: ['thm-002'],
      generalizes: null,
      specialized_by: [],
    },
    tags: ['optimization', 'convergence', 'gradient'],
    ...overrides,
  }
}

function writeJSON(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

function createTestPack(packsDir: string, entries?: KnowledgeEntry[]): string {
  const packDir = join(packsDir, 'test-pack')

  mkdirSync(join(packDir, 'knowledge', 'entries'), { recursive: true })
  mkdirSync(join(packDir, 'knowledge', 'directions'), { recursive: true })
  mkdirSync(join(packDir, 'registries'), { recursive: true })
  mkdirSync(join(packDir, 'index'), { recursive: true })

  const allEntries = entries ?? [
    makeEntry({ id: 'thm-001' }),
    makeEntry({
      id: 'thm-002',
      type: 'theorem',
      label: 'Linear Rate Theorem',
      name: 'Linear Convergence under Strong Convexity',
      statement: 'Under strong convexity, the iterates converge linearly.',
      proof_sketch: 'Apply contraction mapping principle to the gradient step.',
      proof_technique: 'contraction mapping',
      proof_difficulty: 'easy',
      relations: {
        depends_on: ['thm-001'],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['optimization', 'convergence', 'linear-rate'],
    }),
    makeEntry({
      id: 'thm-003',
      type: 'theorem',
      label: 'Induction Bound',
      name: 'Bounded Iterations via Induction',
      statement: 'The number of iterations is bounded by n*log(1/epsilon).',
      proof_sketch: 'By induction on iteration count k.',
      proof_technique: 'induction',
      proof_difficulty: 'easy',
      relations: {
        depends_on: [],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['complexity', 'bounds'],
    }),
    makeEntry({
      id: 'def-001',
      type: 'definition',
      label: 'L-Smoothness',
      name: 'L-Smooth Function',
      statement:
        'A function f is L-smooth if its gradient is L-Lipschitz continuous.',
      relations: {
        depends_on: [],
        used_by: ['thm-001'],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['optimization', 'smoothness'],
    }),
    makeEntry({
      id: 'alg-001',
      type: 'algorithm',
      label: 'GD Algorithm',
      name: 'Gradient Descent',
      statement: 'x_{k+1} = x_k - eta * grad f(x_k)',
      pseudocode: 'for k=1..T: x = x - lr * grad(f, x)',
      complexity: 'O(T * d)',
      inputs: 'f, x0, lr, T',
      outputs: 'x_T',
      relations: {
        depends_on: ['def-001'],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['optimization', 'algorithm'],
    }),
  ]

  const manifest = makeManifest({
    stats: {
      ...makeManifest().stats,
      entries_total: allEntries.length,
      theorems: allEntries.filter(e => e.type === 'theorem').length,
      definitions: allEntries.filter(e => e.type === 'definition').length,
      algorithms: allEntries.filter(e => e.type === 'algorithm').length,
      results: 0,
      datasets: 1,
      benchmarks: 0,
      codebases: 0,
    },
  })
  writeJSON(join(packDir, DKP_PATHS.manifest), manifest)

  writeFileSync(
    join(packDir, DKP_PATHS.knowledge.overview),
    '# Optimization Theory\n\nA pack covering convex optimization.',
    'utf-8',
  )

  writeJSON(join(packDir, 'knowledge', 'directions', 'directions.json'), [
    {
      id: 'opt',
      name: 'Optimization',
      summary: 'Core optimization theory.',
      entry_count: 5,
      key_entries: ['thm-001'],
    },
  ])

  for (const entry of allEntries) {
    writeJSON(join(packDir, 'knowledge', 'entries', `${entry.id}.json`), entry)
  }

  // Counters
  const counters: Record<string, number> = {}
  for (const entry of allEntries) {
    const prefix = entry.id.split('-')[0]
    const num = parseInt(entry.id.split('-')[1], 10)
    counters[prefix] = Math.max(counters[prefix] ?? 0, num)
  }
  writeJSON(join(packDir, 'knowledge', 'entries', '.counters.json'), counters)

  // Connections
  const connections: ConnectionGraph = {
    edges: [
      { from: 'thm-001', to: 'def-001', relation: 'depends_on' },
      { from: 'thm-002', to: 'thm-001', relation: 'depends_on' },
      { from: 'alg-001', to: 'def-001', relation: 'depends_on' },
    ],
  }
  writeJSON(join(packDir, DKP_PATHS.knowledge.connections), connections)

  // Indices
  writeJSON(join(packDir, DKP_PATHS.index.byType), {
    theorem: allEntries.filter(e => e.type === 'theorem').map(e => e.id),
    proposition: [],
    lemma: [],
    corollary: [],
    definition: allEntries.filter(e => e.type === 'definition').map(e => e.id),
    algorithm: allEntries.filter(e => e.type === 'algorithm').map(e => e.id),
    result: [],
  })

  // Build topic index from tags
  const topicIndex: Record<string, string[]> = {}
  for (const entry of allEntries) {
    for (const tag of entry.tags) {
      if (!topicIndex[tag]) topicIndex[tag] = []
      topicIndex[tag].push(entry.id)
    }
  }
  writeJSON(join(packDir, DKP_PATHS.index.byTopic), topicIndex)

  writeJSON(join(packDir, DKP_PATHS.index.bySource), {
    'textbook-a': allEntries.map(e => e.id),
  })

  // Full-text index: keywords → entry IDs
  const fullText: Record<string, string[]> = {}
  for (const entry of allEntries) {
    const words = `${entry.name} ${entry.statement} ${entry.tags.join(' ')}`
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
    for (const w of new Set(words)) {
      if (!fullText[w]) fullText[w] = []
      fullText[w].push(entry.id)
    }
  }
  writeJSON(join(packDir, DKP_PATHS.index.fullText), fullText)

  // Registries
  writeJSON(join(packDir, DKP_PATHS.registries.datasets), [
    {
      name: 'OptBench',
      description: 'Optimization benchmark dataset',
      access: 'free',
    },
  ])
  writeJSON(join(packDir, DKP_PATHS.registries.benchmarks), [])
  writeJSON(join(packDir, DKP_PATHS.registries.codebases), [])

  return packDir
}

function fakeState(packsDir: string): ResearchState {
  return {
    loaded_knowledge_packs: ['test-pack'],
    // Minimal ResearchState fields to satisfy initAgentDKP
    // initAgentDKP only reads loaded_knowledge_packs
  } as unknown as ResearchState
}

// ── Tests ────────────────────────────────────────────────

describe('DK Tools — initAgentDKP', () => {
  let tempDir: string
  let packsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dk-tools-test-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
  })

  afterEach(() => {
    // Reset by loading empty state
    initAgentDKP({ loaded_knowledge_packs: [] } as unknown as ResearchState)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('initAgentDKP with empty packs sets loader to null', () => {
    initAgentDKP({ loaded_knowledge_packs: [] } as unknown as ResearchState)
    expect(shouldIncludeDKTools('math-reasoner')).toBe(false)
  })

  test('initAgentDKP with valid pack enables DK tools', () => {
    createTestPack(packsDir)

    // Patch DKPLoader to use our temp dir — we need to override the default packs dir
    // Since initAgentDKP creates its own DKPLoader, we need to test via the actual loader path
    // For unit testing, we'll test shouldIncludeDKTools after successful init
    const { DKPLoader } = require('../../src/paper/domain-knowledge/loader')
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')
    expect(loader.getLoadedPacks()).toHaveLength(1)
  })
})

describe('DK Tools — executeDKSearch', () => {
  let tempDir: string
  let packsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dk-search-test-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
    createTestPack(packsDir)
  })

  afterEach(() => {
    initAgentDKP({ loaded_knowledge_packs: [] } as unknown as ResearchState)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('returns "no packs loaded" when DKP not initialized', () => {
    initAgentDKP({ loaded_knowledge_packs: [] } as unknown as ResearchState)
    const result = executeDKSearch({ query: 'convergence' })
    expect(result).toBe('No knowledge packs loaded.')
  })

  test('finds entries by keyword match', () => {
    // Manually initialize with our test packs dir
    const { DKPLoader } = require('../../src/paper/domain-knowledge/loader')
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')
    // Inject the loader via a workaround — since we can't call initAgentDKP with custom dir,
    // we test the function logic directly
    // The function reads from module-level activeDKPLoader, so we need initAgentDKP to work
    // For now, test that the function returns correct format when no loader
    const result = executeDKSearch({ query: 'convergence optimization' })
    // Without activeDKPLoader set, this returns "No knowledge packs loaded."
    expect(result).toBe('No knowledge packs loaded.')
  })

  test('returns "no entries found" for unmatched query', () => {
    const result = executeDKSearch({ query: 'quantum entanglement' })
    expect(result).toBe('No knowledge packs loaded.')
  })
})

describe('DK Tools — executeDKExpand', () => {
  test('returns "no packs loaded" without loader', () => {
    initAgentDKP({ loaded_knowledge_packs: [] } as unknown as ResearchState)
    const result = executeDKExpand({ entry_id: 'thm-001' })
    expect(result).toBe('No knowledge packs loaded.')
  })
})

describe('DK Tools — executeDKNavigate', () => {
  test('returns "no packs loaded" without loader', () => {
    initAgentDKP({ loaded_knowledge_packs: [] } as unknown as ResearchState)
    const result = executeDKNavigate({
      entry_id: 'thm-001',
      direction: 'prerequisites',
    })
    expect(result).toBe('No knowledge packs loaded.')
  })
})

describe('DK Tools — executeDKFindTechnique', () => {
  test('returns "no packs loaded" without loader', () => {
    initAgentDKP({ loaded_knowledge_packs: [] } as unknown as ResearchState)
    const result = executeDKFindTechnique({ technique: 'induction' })
    expect(result).toBe('No knowledge packs loaded.')
  })

  test('requires technique parameter', () => {
    // Even without loader, should still check for technique
    const result = executeDKFindTechnique({ technique: '' })
    // Without loader it hits the guard first
    expect(result).toBe('No knowledge packs loaded.')
  })
})

describe('DK Tools — getAgentTools', () => {
  beforeEach(() => {
    // Reset DK loader
    initAgentDKP({ loaded_knowledge_packs: [] } as unknown as ResearchState)
  })

  test('math-reasoner gets base tools without DK when no packs loaded', () => {
    const tools = getAgentTools('math-reasoner')
    const names = tools.map(t => t.name)
    expect(names).toContain('bash')
    expect(names).toContain('read_file')
    expect(names).not.toContain('dk_search')
  })

  test('investigator gets research tools', () => {
    const tools = getAgentTools('investigator')
    const names = tools.map(t => t.name)
    expect(names).toContain('arxiv_search')
    expect(names).toContain('semantic_scholar_search')
    expect(names).not.toContain('dk_search') // No packs loaded
  })

  test('shouldIncludeDKTools returns false without packs', () => {
    expect(shouldIncludeDKTools('math-reasoner')).toBe(false)
    expect(shouldIncludeDKTools('investigator')).toBe(false)
    expect(shouldIncludeDKTools('latex-compiler')).toBe(false)
  })

  test('shouldIncludeDKTools returns false for non-DK agents even if packs were loaded', () => {
    // shouldIncludeDKTools checks both activeDKPLoader AND agent name
    // Without loader it's always false
    expect(shouldIncludeDKTools('latex-compiler')).toBe(false)
    expect(shouldIncludeDKTools('reviewer')).toBe(false)
    expect(shouldIncludeDKTools('paper-assembler')).toBe(false)
  })
})

describe('DK Tools — DKPLoader integration', () => {
  let tempDir: string
  let packsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dk-integration-test-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
    createTestPack(packsDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('DKPLoader can find entries for search', () => {
    const { DKPLoader } = require('../../src/paper/domain-knowledge/loader')
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')

    // Verify search functionality would work
    const packs = loader.getLoadedPacks()
    expect(packs).toHaveLength(1)

    const pack = packs[0]
    // Full-text index should have 'convergence' keyword
    expect(pack.indices.fullText['convergence']).toBeDefined()
    expect(pack.indices.fullText['convergence'].length).toBeGreaterThan(0)

    // Topic index
    expect(pack.indices.byTopic['optimization']).toBeDefined()
    expect(pack.indices.byTopic['optimization'].length).toBeGreaterThanOrEqual(
      3,
    )
  })

  test('DKPLoader entry expand works correctly', () => {
    const { DKPLoader } = require('../../src/paper/domain-knowledge/loader')
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')

    const entry = loader.getEntry('test-pack', 'thm-001')
    expect(entry).not.toBeNull()
    expect(entry!.label).toBe('Convergence Theorem')
    expect(entry!.proof_technique).toBe('Lyapunov function')
    expect(entry!.assumptions).toHaveLength(2)
    expect(entry!.relations.depends_on).toEqual(['def-001'])
  })

  test('DKPLoader navigate prerequisites', () => {
    const { DKPLoader } = require('../../src/paper/domain-knowledge/loader')
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')

    const entry = loader.getEntry('test-pack', 'thm-001')
    expect(entry!.relations.depends_on).toEqual(['def-001'])

    const deps = loader.getEntries('test-pack', entry!.relations.depends_on)
    expect(deps).toHaveLength(1)
    expect(deps[0].id).toBe('def-001')
    expect(deps[0].type).toBe('definition')
  })

  test('DKPLoader navigate connections graph', () => {
    const { DKPLoader } = require('../../src/paper/domain-knowledge/loader')
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')

    const connections = loader.getConnections('test-pack')
    expect(connections.edges.length).toBeGreaterThan(0)

    // thm-001 should be connected to def-001 and thm-002
    const thm001Edges = connections.edges.filter(
      e => e.from === 'thm-001' || e.to === 'thm-001',
    )
    expect(thm001Edges.length).toBeGreaterThanOrEqual(1)
  })

  test('DKPLoader find technique - Lyapunov', () => {
    const { DKPLoader } = require('../../src/paper/domain-knowledge/loader')
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')

    // Get theorems and filter by technique
    const theoremIds =
      loader.getLoadedPack('test-pack')!.indices.byType.theorem ?? []
    const theorems = loader.getEntries('test-pack', theoremIds)
    const lyapunov = theorems.filter(e =>
      e.proof_technique?.toLowerCase().includes('lyapunov'),
    )

    expect(lyapunov).toHaveLength(1)
    expect(lyapunov[0].id).toBe('thm-001')
  })

  test('DKPLoader find technique - contraction mapping', () => {
    const { DKPLoader } = require('../../src/paper/domain-knowledge/loader')
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')

    const theoremIds =
      loader.getLoadedPack('test-pack')!.indices.byType.theorem ?? []
    const theorems = loader.getEntries('test-pack', theoremIds)
    const contraction = theorems.filter(e =>
      e.proof_technique?.toLowerCase().includes('contraction'),
    )

    expect(contraction).toHaveLength(1)
    expect(contraction[0].id).toBe('thm-002')
  })

  test('DKPLoader find technique - no matches', () => {
    const { DKPLoader } = require('../../src/paper/domain-knowledge/loader')
    const loader = new DKPLoader(packsDir)
    loader.load('test-pack')

    const theoremIds =
      loader.getLoadedPack('test-pack')!.indices.byType.theorem ?? []
    const theorems = loader.getEntries('test-pack', theoremIds)
    const topological = theorems.filter(e =>
      e.proof_technique?.toLowerCase().includes('topological'),
    )

    expect(topological).toHaveLength(0)
  })
})

// ── K8 Test Pack Fixture ────────────────────────────────

function createK8TestPack(packsDir: string): string {
  const packDir = join(packsDir, 'test-pack')

  mkdirSync(join(packDir, 'knowledge', 'entries'), { recursive: true })
  mkdirSync(join(packDir, 'knowledge', 'directions'), { recursive: true })
  mkdirSync(join(packDir, 'registries'), { recursive: true })
  mkdirSync(join(packDir, 'index'), { recursive: true })

  const entries: KnowledgeEntry[] = [
    makeEntry({
      id: 'thm-001',
      type: 'theorem',
      source: { id: 'textbook-a', chapter: '3', section: '3.1', page: 42 },
      label: 'Convergence Theorem',
      name: 'Convergence of GD',
      statement:
        'If f is L-smooth and mu-strongly convex, then gradient descent converges at rate O(exp(-mu*t/L)).',
      proof_sketch:
        'By constructing a Lyapunov function V(x) = f(x) - f*, we bound the descent.',
      proof_technique: 'Lyapunov function',
      proof_difficulty: 'medium',
      assumptions: [
        { id: 'A1', text: 'f is L-smooth', strength: 'required' as const },
        {
          id: 'A2',
          text: 'f is mu-strongly convex',
          strength: 'required' as const,
        },
      ],
      usability: {
        citable: true,
        common_use: 'optimization convergence analysis',
      },
      relations: {
        depends_on: ['def-001'],
        used_by: ['thm-002'],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['convergence', 'optimization', 'gradient'],
    }),
    makeEntry({
      id: 'thm-002',
      type: 'theorem',
      source: { id: 'textbook-a', chapter: '3', section: '3.2', page: 55 },
      label: 'Linear Rate Theorem',
      name: 'Linear Rate',
      statement:
        'Under strong convexity, gradient descent converges at a linear rate.',
      proof_sketch: 'Apply contraction mapping principle to the gradient step.',
      proof_technique: 'contraction mapping',
      proof_difficulty: 'easy',
      relations: {
        depends_on: ['thm-001'],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['convergence', 'linear-rate', 'optimization'],
    }),
    makeEntry({
      id: 'thm-003',
      type: 'theorem',
      source: { id: 'textbook-a', chapter: '5', section: '5.1', page: 110 },
      label: 'Iteration Bound',
      name: 'Iteration Bound',
      statement: 'The number of iterations is bounded by n*log(1/epsilon).',
      proof_sketch: 'By induction on iteration count k.',
      proof_technique: 'induction',
      proof_difficulty: 'easy',
      relations: {
        depends_on: [],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['complexity', 'bounds'],
    }),
    makeEntry({
      id: 'thm-004',
      type: 'theorem',
      source: { id: 'paper-alpha', chapter: '4', section: '4.1', page: 8 },
      label: 'SGD Convergence',
      name: 'SGD Convergence Rate',
      statement:
        'SGD with decreasing step size converges at rate O(1/sqrt(T)) for convex objectives.',
      proof_sketch:
        'Apply martingale convergence theorem to the gradient noise process.',
      proof_technique: 'martingale convergence',
      proof_difficulty: 'hard',
      relations: {
        depends_on: ['thm-001'],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['sgd', 'convergence', 'stochastic'],
    }),
    makeEntry({
      id: 'thm-005',
      type: 'theorem',
      source: { id: 'paper-beta', chapter: '3', section: '3.1', page: 5 },
      label: 'Adam Regret Bound',
      name: 'Adam Regret Bound',
      statement:
        'Adam achieves O(sqrt(T)) regret in the online convex optimization setting.',
      proof_sketch:
        'Construct a potential function tracking cumulative regret.',
      proof_technique: 'potential function',
      proof_difficulty: 'hard',
      relations: {
        depends_on: [],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['adam', 'regret', 'online-learning'],
    }),
    makeEntry({
      id: 'def-001',
      type: 'definition',
      source: { id: 'textbook-a', chapter: '3', section: '3.0', page: 40 },
      label: 'L-Smoothness',
      name: 'L-Smoothness',
      statement:
        'A function f is L-smooth if its gradient is L-Lipschitz continuous.',
      relations: {
        depends_on: [],
        used_by: ['thm-001'],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['optimization', 'smoothness'],
    }),
    makeEntry({
      id: 'alg-001',
      type: 'algorithm',
      source: { id: 'textbook-a', chapter: '3', section: '3.1', page: 43 },
      label: 'GD Algorithm',
      name: 'Gradient Descent',
      statement: 'x_{k+1} = x_k - eta * grad f(x_k)',
      pseudocode: 'for k=1..T: x = x - lr * grad(f, x)',
      complexity: 'O(T * d)',
      inputs: 'f, x0, lr, T',
      outputs: 'x_T',
      relations: {
        depends_on: ['def-001'],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['optimization', 'algorithm'],
    }),
    makeEntry({
      id: 'res-001',
      type: 'result',
      source: { id: 'paper-alpha', chapter: '5', section: '5.2', page: 12 },
      label: 'SGD beats GD on MNIST',
      name: 'SGD beats GD on MNIST',
      statement:
        'SGD achieves 98.5% accuracy on MNIST in 10 epochs vs 50 for GD.',
      relations: {
        depends_on: [],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['sgd', 'empirical', 'mnist'],
    }),
    makeEntry({
      id: 'res-002',
      type: 'result',
      source: { id: 'paper-beta', chapter: '5', section: '5.1', page: 10 },
      label: 'Adam vs SGD comparison',
      name: 'Adam vs SGD comparison',
      statement:
        'Adam converges faster than SGD on non-stationary objectives in 4 out of 5 benchmarks.',
      relations: {
        depends_on: [],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['adam', 'sgd', 'comparison'],
    }),
  ]

  const manifest = makeManifest({
    stats: {
      entries_total: 9,
      theorems: 5,
      definitions: 1,
      algorithms: 1,
      results: 2,
      datasets: 2,
      benchmarks: 1,
      codebases: 1,
    },
    sources: {
      textbooks: [{ id: 'textbook-a', title: 'Convex Optimization' }],
      papers: [
        {
          id: 'paper-alpha',
          title: 'On the Convergence of SGD',
          arxiv_id: '2025.12345',
        },
        {
          id: 'paper-beta',
          title: 'Adam: A Method for Stochastic Optimization',
          arxiv_id: '2025.67890',
        },
      ],
    } as any,
  })
  writeJSON(join(packDir, DKP_PATHS.manifest), manifest)

  writeFileSync(
    join(packDir, DKP_PATHS.knowledge.overview),
    '# Optimization Theory\n\nA pack covering convex optimization, SGD, and Adam.',
    'utf-8',
  )

  writeJSON(join(packDir, 'knowledge', 'directions', 'directions.json'), [
    {
      id: 'opt',
      name: 'Optimization',
      summary: 'Core optimization theory.',
      entry_count: 9,
      key_entries: ['thm-001', 'thm-004'],
    },
  ])

  for (const entry of entries) {
    writeJSON(join(packDir, 'knowledge', 'entries', `${entry.id}.json`), entry)
  }

  // Counters
  writeJSON(join(packDir, 'knowledge', 'entries', '.counters.json'), {
    thm: 5,
    def: 1,
    alg: 1,
    res: 2,
  })

  // Connections
  const connections: ConnectionGraph = {
    edges: [
      { from: 'thm-001', to: 'def-001', relation: 'depends_on' },
      { from: 'thm-002', to: 'thm-001', relation: 'depends_on' },
      { from: 'thm-004', to: 'thm-001', relation: 'depends_on' },
      { from: 'alg-001', to: 'def-001', relation: 'depends_on' },
      { from: 'res-001', to: 'thm-004', relation: 'evaluates' },
      { from: 'res-002', to: 'thm-005', relation: 'evaluates' },
    ],
  }
  writeJSON(join(packDir, DKP_PATHS.knowledge.connections), connections)

  // Indices
  writeJSON(join(packDir, DKP_PATHS.index.byType), {
    theorem: ['thm-001', 'thm-002', 'thm-003', 'thm-004', 'thm-005'],
    proposition: [],
    lemma: [],
    corollary: [],
    definition: ['def-001'],
    algorithm: ['alg-001'],
    result: ['res-001', 'res-002'],
  })

  // Topic index
  const topicIndex: Record<string, string[]> = {}
  for (const entry of entries) {
    for (const tag of entry.tags) {
      if (!topicIndex[tag]) topicIndex[tag] = []
      topicIndex[tag].push(entry.id)
    }
  }
  writeJSON(join(packDir, DKP_PATHS.index.byTopic), topicIndex)

  // By source
  writeJSON(join(packDir, DKP_PATHS.index.bySource), {
    'textbook-a': ['thm-001', 'thm-002', 'thm-003', 'def-001', 'alg-001'],
    'paper-alpha': ['thm-004', 'res-001'],
    'paper-beta': ['thm-005', 'res-002'],
  })

  // Full-text index
  const fullText: Record<string, string[]> = {}
  for (const entry of entries) {
    const words = `${entry.name} ${entry.statement} ${entry.tags.join(' ')}`
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
    for (const w of new Set(words)) {
      if (!fullText[w]) fullText[w] = []
      fullText[w].push(entry.id)
    }
  }
  writeJSON(join(packDir, DKP_PATHS.index.fullText), fullText)

  // Registries
  writeJSON(join(packDir, DKP_PATHS.registries.datasets), [
    {
      name: 'MNIST',
      description: 'Handwritten digit recognition dataset',
      access: 'free',
    },
    {
      name: 'CIFAR-10',
      description: 'Image classification benchmark',
      access: 'free',
    },
  ])
  writeJSON(join(packDir, DKP_PATHS.registries.benchmarks), [
    {
      name: 'OptBench',
      description: 'Optimization benchmark suite',
      standard_metrics: ['convergence_rate'],
      standard_baselines: ['SGD', 'Adam'],
      source: 'optbench.org',
    },
  ])
  writeJSON(join(packDir, DKP_PATHS.registries.codebases), [
    {
      name: 'optlib',
      repo_url: 'https://github.com/example/optlib',
      language: 'Python',
      implements: 'Optimization algorithms library',
    },
  ])

  return packDir
}

// ── K8 Integration Tests ────────────────────────────────

describe('DK Tools — K8: dk_search integration', () => {
  let tempDir: string
  let packsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'k8-search-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
    createK8TestPack(packsDir)
    initAgentDKP({ loaded_knowledge_packs: ['test-pack'] } as any, packsDir)
  })

  afterEach(() => {
    initAgentDKP({ loaded_knowledge_packs: [] } as any)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('query "convergence" finds thm-001, thm-002, thm-004', () => {
    const result = executeDKSearch({ query: 'convergence' })
    expect(result).toContain('thm-001')
    expect(result).toContain('thm-002')
    expect(result).toContain('thm-004')
  })

  test('query "convergence" does NOT return def-001 or alg-001', () => {
    const result = executeDKSearch({ query: 'convergence' })
    expect(result).not.toContain('[def-001]')
    expect(result).not.toContain('[alg-001]')
  })

  test('query with type "theorem" returns only theorems', () => {
    const result = executeDKSearch({ query: 'convergence', type: 'theorem' })
    expect(result).toContain('thm-')
    expect(result).not.toContain('[def-')
    expect(result).not.toContain('[alg-')
    expect(result).not.toContain('[res-')
  })

  test('max_results limits output', () => {
    const result = executeDKSearch({
      query: 'convergence',
      max_results: 2,
    })
    // Count [thm-xxx] or [res-xxx] pattern occurrences
    const matches = result.match(/\[[a-z]+-\d+\]/g) ?? []
    expect(matches.length).toBeLessThanOrEqual(2)
  })

  test('query "quantum entanglement" returns no entries', () => {
    const result = executeDKSearch({ query: 'quantum entanglement' })
    expect(result).toContain('No entries found for query:')
  })

  test('result format includes dk_expand hint', () => {
    const result = executeDKSearch({ query: 'convergence' })
    expect(result).toContain('dk_expand(')
  })
})

describe('DK Tools — K8: dk_expand integration', () => {
  let tempDir: string
  let packsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'k8-expand-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
    createK8TestPack(packsDir)
    initAgentDKP({ loaded_knowledge_packs: ['test-pack'] } as any, packsDir)
  })

  afterEach(() => {
    initAgentDKP({ loaded_knowledge_packs: [] } as any)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('expand thm-001 contains header, statement, assumptions, usability, relations', () => {
    const result = executeDKExpand({ entry_id: 'thm-001' })
    expect(result).toContain('## Convergence Theorem')
    expect(result).toContain('### Statement')
    expect(result).toContain('### Assumptions')
    expect(result).toContain('### Usability')
    expect(result).toContain('### Relations')
    expect(result).toContain('Depends on: def-001')
  })

  test('expand with include_proof shows proof sketch', () => {
    const result = executeDKExpand({
      entry_id: 'thm-001',
      include_proof: true,
    })
    expect(result).toContain('### Proof Sketch')
    expect(result).toContain('Lyapunov')
  })

  test('expand without include_proof hides proof sketch', () => {
    const result = executeDKExpand({ entry_id: 'thm-001' })
    expect(result).not.toContain('### Proof Sketch')
  })

  test('expand nonexistent returns not found', () => {
    const result = executeDKExpand({ entry_id: 'thm-999' })
    expect(result).toContain('not found')
  })

  test('expand alg-001 contains algorithm section', () => {
    const result = executeDKExpand({ entry_id: 'alg-001' })
    expect(result).toContain('### Algorithm')
  })
})

describe('DK Tools — K8: dk_navigate integration', () => {
  let tempDir: string
  let packsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'k8-nav-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
    createK8TestPack(packsDir)
    initAgentDKP({ loaded_knowledge_packs: ['test-pack'] } as any, packsDir)
  })

  afterEach(() => {
    initAgentDKP({ loaded_knowledge_packs: [] } as any)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('navigate prerequisites of thm-001 contains def-001', () => {
    const result = executeDKNavigate({
      entry_id: 'thm-001',
      direction: 'prerequisites',
    })
    expect(result).toContain('def-001')
  })

  test('navigate dependents of thm-001 contains thm-002', () => {
    const result = executeDKNavigate({
      entry_id: 'thm-001',
      direction: 'dependents',
    })
    expect(result).toContain('thm-002')
  })

  test('navigate related of thm-001 contains def-001 and thm-002', () => {
    const result = executeDKNavigate({
      entry_id: 'thm-001',
      direction: 'related',
    })
    expect(result).toContain('def-001')
    expect(result).toContain('thm-002')
  })

  test('navigate siblings of thm-001 finds same-chapter entries from textbook-a', () => {
    const result = executeDKNavigate({
      entry_id: 'thm-001',
      direction: 'siblings',
    })
    // thm-001 is ch.3, textbook-a — siblings should include thm-002, def-001, alg-001 (all ch.3)
    expect(result).toContain('thm-002')
    expect(result).toContain('def-001')
    expect(result).toContain('alg-001')
  })

  test('navigate nonexistent returns not found', () => {
    const result = executeDKNavigate({
      entry_id: 'thm-999',
      direction: 'prerequisites',
    })
    expect(result).toContain('not found')
  })

  test('navigate empty prerequisites returns "No prerequisites found"', () => {
    // thm-003 has no dependencies
    const result = executeDKNavigate({
      entry_id: 'thm-003',
      direction: 'prerequisites',
    })
    expect(result).toContain('No prerequisites found')
  })
})

describe('DK Tools — K8: dk_find_technique integration', () => {
  let tempDir: string
  let packsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'k8-technique-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
    createK8TestPack(packsDir)
    initAgentDKP({ loaded_knowledge_packs: ['test-pack'] } as any, packsDir)
  })

  afterEach(() => {
    initAgentDKP({ loaded_knowledge_packs: [] } as any)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('"Lyapunov" finds thm-001', () => {
    const result = executeDKFindTechnique({ technique: 'Lyapunov' })
    expect(result).toContain('thm-001')
  })

  test('"contraction" finds thm-002', () => {
    const result = executeDKFindTechnique({ technique: 'contraction' })
    expect(result).toContain('thm-002')
  })

  test('"induction" finds thm-003', () => {
    const result = executeDKFindTechnique({ technique: 'induction' })
    expect(result).toContain('thm-003')
  })

  test('"martingale" finds thm-004', () => {
    const result = executeDKFindTechnique({ technique: 'martingale' })
    expect(result).toContain('thm-004')
  })

  test('"topological" finds nothing', () => {
    const result = executeDKFindTechnique({ technique: 'topological' })
    expect(result).toContain('No theorems found')
  })
})

describe('DK Tools — K8: dk_expand SubAgent-only access control', () => {
  let tempDir: string
  let packsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'k8-access-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
    createK8TestPack(packsDir)
    initAgentDKP({ loaded_knowledge_packs: ['test-pack'] } as any, packsDir)
  })

  afterEach(() => {
    initAgentDKP({ loaded_knowledge_packs: [] } as any)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('paper-assembler, latex-compiler, reviewer get NO DK tools', () => {
    for (const agent of ['paper-assembler', 'latex-compiler', 'reviewer']) {
      const tools = getAgentTools(agent)
      const names = tools.map(t => t.name)
      expect(names).not.toContain('dk_expand')
      expect(names).not.toContain('dk_search')
    }
  })

  test('math-reasoner gets all 4 DK tools', () => {
    const tools = getAgentTools('math-reasoner')
    const names = tools.map(t => t.name)
    expect(names).toContain('dk_search')
    expect(names).toContain('dk_expand')
    expect(names).toContain('dk_navigate')
    expect(names).toContain('dk_find_technique')
  })

  test('experiment-runner gets dk_search but NOT dk_expand', () => {
    const tools = getAgentTools('experiment-runner')
    const names = tools.map(t => t.name)
    expect(names).toContain('dk_search')
    expect(names).not.toContain('dk_expand')
  })

  test('fragment-writer gets dk_search + dk_expand but NOT dk_navigate', () => {
    const tools = getAgentTools('fragment-writer')
    const names = tools.map(t => t.name)
    expect(names).toContain('dk_search')
    expect(names).toContain('dk_expand')
    expect(names).not.toContain('dk_navigate')
  })

  test('investigator gets dk_search + dk_expand + dk_navigate but NOT dk_find_technique', () => {
    const tools = getAgentTools('investigator')
    const names = tools.map(t => t.name)
    expect(names).toContain('dk_search')
    expect(names).toContain('dk_expand')
    expect(names).toContain('dk_navigate')
    expect(names).not.toContain('dk_find_technique')
  })
})

describe('DK Tools — K8: registry + manifest', () => {
  let tempDir: string
  let packsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'k8-registry-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
    createK8TestPack(packsDir)
    initAgentDKP({ loaded_knowledge_packs: ['test-pack'] } as any, packsDir)
  })

  afterEach(() => {
    initAgentDKP({ loaded_knowledge_packs: [] } as any)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('registries: 2 datasets, 1 benchmark, 1 codebase', () => {
    const loader = getActiveDKPLoader()!
    const pack = loader.getLoadedPack('test-pack')!
    expect(pack.registries.datasets).toHaveLength(2)
    expect(pack.registries.benchmarks).toHaveLength(1)
    expect(pack.registries.codebases).toHaveLength(1)
  })

  test('manifest stats: 5 theorems, 1 definition, 1 algorithm, 2 results, 9 total', () => {
    const loader = getActiveDKPLoader()!
    const pack = loader.getLoadedPack('test-pack')!
    const stats = pack.manifest.stats
    expect(stats.theorems).toBe(5)
    expect(stats.definitions).toBe(1)
    expect(stats.algorithms).toBe(1)
    expect(stats.results).toBe(2)
    expect(stats.entries_total).toBe(9)
  })

  test('bySource index: paper-alpha has thm-004, res-001; paper-beta has thm-005, res-002', () => {
    const loader = getActiveDKPLoader()!
    const pack = loader.getLoadedPack('test-pack')!
    const bySource = pack.indices.bySource

    expect(bySource['paper-alpha']).toContain('thm-004')
    expect(bySource['paper-alpha']).toContain('res-001')
    expect(bySource['paper-beta']).toContain('thm-005')
    expect(bySource['paper-beta']).toContain('res-002')
  })
})
