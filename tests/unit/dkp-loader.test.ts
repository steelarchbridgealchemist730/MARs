import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DKPLoader } from '../../src/paper/domain-knowledge/loader'
import { DKP_PATHS } from '../../src/paper/domain-knowledge/types'
import type {
  DKPManifest,
  KnowledgeEntry,
  DirectionSummary,
  ConnectionGraph,
} from '../../src/paper/domain-knowledge/types'

// ── Test Helpers ────────────────────────────────────────

function makeManifest(overrides: Partial<DKPManifest> = {}): DKPManifest {
  return {
    id: 'test-pack',
    name: 'Test Pack',
    version: '1.0.0',
    description: 'A test knowledge pack',
    sources: { textbooks: [], papers: [] },
    stats: {
      entries_total: 3,
      theorems: 2,
      definitions: 1,
      algorithms: 0,
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
    source: { id: 'test-book', chapter: '1', section: '1.1', page: 5 },
    label: 'Test Theorem',
    name: 'Test Theorem',
    statement: 'For all x, f(x) > 0.',
    usability: { citable: true, common_use: 'testing' },
    relations: {
      depends_on: [],
      used_by: [],
      generalizes: null,
      specialized_by: [],
    },
    tags: ['test', 'optimization'],
    ...overrides,
  }
}

interface FakePackOptions {
  manifest?: Partial<DKPManifest>
  overview?: string
  directions?: DirectionSummary[]
  entries?: KnowledgeEntry[]
  connections?: ConnectionGraph
  datasets?: unknown[]
  benchmarks?: unknown[]
  codebases?: unknown[]
}

function createFakePack(
  packsDir: string,
  packName: string,
  opts: FakePackOptions = {},
): string {
  const packDir = join(packsDir, packName)

  // Create directories
  mkdirSync(join(packDir, 'knowledge', 'entries'), { recursive: true })
  mkdirSync(join(packDir, 'knowledge', 'directions'), { recursive: true })
  mkdirSync(join(packDir, 'registries'), { recursive: true })
  mkdirSync(join(packDir, 'index'), { recursive: true })

  // Write manifest
  const manifest = makeManifest({
    id: packName,
    name: packName,
    ...opts.manifest,
  })
  writeJSON(join(packDir, DKP_PATHS.manifest), manifest)

  // Write overview
  writeFileSync(
    join(packDir, DKP_PATHS.knowledge.overview),
    opts.overview ?? '# Test Overview\n\nThis is a test pack.',
    'utf-8',
  )

  // Write directions
  const directions = opts.directions ?? [
    {
      id: 'dir-1',
      name: 'Direction 1',
      summary: 'First research direction.',
      entry_count: 1,
      key_entries: ['thm-001'],
    },
  ]
  writeJSON(
    join(packDir, 'knowledge', 'directions', 'directions.json'),
    directions,
  )

  // Write entries
  const entries = opts.entries ?? [
    makeEntry({ id: 'thm-001' }),
    makeEntry({ id: 'thm-002', label: 'Second Theorem' }),
    makeEntry({ id: 'def-001', type: 'definition', label: 'Test Def' }),
  ]
  for (const entry of entries) {
    writeJSON(join(packDir, 'knowledge', 'entries', `${entry.id}.json`), entry)
  }
  // Write counters for EntryStore
  const counters: Record<string, number> = {}
  for (const entry of entries) {
    const prefix = entry.id.split('-')[0]
    const num = parseInt(entry.id.split('-')[1], 10)
    counters[prefix] = Math.max(counters[prefix] ?? 0, num)
  }
  writeJSON(join(packDir, 'knowledge', 'entries', '.counters.json'), counters)

  // Write connections
  writeJSON(
    join(packDir, DKP_PATHS.knowledge.connections),
    opts.connections ?? {
      edges: [{ from: 'thm-001', to: 'def-001', relation: 'depends_on' }],
    },
  )

  // Write indices
  writeJSON(join(packDir, DKP_PATHS.index.byType), {
    theorem: entries.filter(e => e.type === 'theorem').map(e => e.id),
    proposition: [],
    lemma: [],
    corollary: [],
    definition: entries.filter(e => e.type === 'definition').map(e => e.id),
    algorithm: [],
    result: [],
  })
  writeJSON(join(packDir, DKP_PATHS.index.byTopic), {
    test: entries.map(e => e.id),
    optimization: entries.map(e => e.id),
  })
  writeJSON(join(packDir, DKP_PATHS.index.bySource), {
    'test-book': entries.map(e => e.id),
  })
  writeJSON(join(packDir, DKP_PATHS.index.fullText), {
    theorem: ['thm-001', 'thm-002'],
    definition: ['def-001'],
  })

  // Write registries
  writeJSON(
    join(packDir, DKP_PATHS.registries.datasets),
    opts.datasets ?? [{ name: 'TestDS', description: 'test', access: 'free' }],
  )
  writeJSON(
    join(packDir, DKP_PATHS.registries.benchmarks),
    opts.benchmarks ?? [],
  )
  writeJSON(join(packDir, DKP_PATHS.registries.codebases), opts.codebases ?? [])

  return packDir
}

function writeJSON(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

// ── Tests ───────────────────────────────────────────────

describe('DKPLoader', () => {
  let tempDir: string
  let packsDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dkp-loader-test-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('load() reads manifest', () => {
    createFakePack(packsDir, 'my-pack', {
      manifest: { name: 'My Pack', description: 'Testing manifest' },
    })

    const loader = new DKPLoader(packsDir)
    const loaded = loader.load('my-pack')

    expect(loaded.manifest.id).toBe('my-pack')
    expect(loaded.manifest.name).toBe('My Pack')
    expect(loaded.manifest.description).toBe('Testing manifest')
    expect(loaded.manifest.version).toBe('1.0.0')
  })

  test('load() reads overview', () => {
    createFakePack(packsDir, 'my-pack', {
      overview: '# Domain Overview\n\nThis is the overview content.',
    })

    const loader = new DKPLoader(packsDir)
    const loaded = loader.load('my-pack')

    expect(loaded.overview).toBe(
      '# Domain Overview\n\nThis is the overview content.',
    )
  })

  test('load() reads directions from JSON', () => {
    const dirs: DirectionSummary[] = [
      {
        id: 'opt',
        name: 'Optimization',
        summary: 'Optimization research direction.',
        entry_count: 2,
        key_entries: ['thm-001', 'alg-001'],
      },
      {
        id: 'approx',
        name: 'Approximation',
        summary: 'Approximation theory.',
        entry_count: 1,
        key_entries: ['thm-002'],
      },
    ]
    createFakePack(packsDir, 'my-pack', { directions: dirs })

    const loader = new DKPLoader(packsDir)
    const loaded = loader.load('my-pack')

    expect(loaded.directions).toHaveLength(2)
    expect(loaded.directions[0].id).toBe('opt')
    expect(loaded.directions[0].name).toBe('Optimization')
    expect(loaded.directions[1].id).toBe('approx')
  })

  test('load() reads indices', () => {
    createFakePack(packsDir, 'my-pack')

    const loader = new DKPLoader(packsDir)
    const loaded = loader.load('my-pack')

    expect(loaded.indices.byType.theorem).toEqual(['thm-001', 'thm-002'])
    expect(loaded.indices.byType.definition).toEqual(['def-001'])
    expect(loaded.indices.byTopic['test']).toBeDefined()
    expect(loaded.indices.bySource['test-book']).toBeDefined()
    expect(loaded.indices.fullText['theorem']).toBeDefined()
  })

  test('load() reads registries', () => {
    createFakePack(packsDir, 'my-pack', {
      datasets: [
        { name: 'MNIST', description: 'digits', access: 'free' },
        { name: 'CIFAR', description: 'images', access: 'free' },
      ],
      benchmarks: [
        {
          name: 'ImageNet',
          description: 'classification',
          standard_metrics: ['top-1'],
          standard_baselines: ['ResNet'],
          source: 'ILSVRC',
        },
      ],
    })

    const loader = new DKPLoader(packsDir)
    const loaded = loader.load('my-pack')

    expect(loaded.registries.datasets).toHaveLength(2)
    expect(loaded.registries.benchmarks).toHaveLength(1)
    expect(loaded.registries.codebases).toHaveLength(0)
  })

  test('load() throws for missing pack', () => {
    const loader = new DKPLoader(packsDir)

    expect(() => loader.load('nonexistent')).toThrow('nonexistent')
  })

  test('unload() removes from cache', () => {
    createFakePack(packsDir, 'my-pack')

    const loader = new DKPLoader(packsDir)
    loader.load('my-pack')
    expect(loader.getLoadedPack('my-pack')).not.toBeNull()

    loader.unload('my-pack')
    expect(loader.getLoadedPack('my-pack')).toBeNull()
  })

  test('getLoadedPacks() returns all loaded packs', () => {
    createFakePack(packsDir, 'pack-a', { manifest: { name: 'Pack A' } })
    createFakePack(packsDir, 'pack-b', { manifest: { name: 'Pack B' } })

    const loader = new DKPLoader(packsDir)
    loader.load('pack-a')
    loader.load('pack-b')

    const packs = loader.getLoadedPacks()
    expect(packs).toHaveLength(2)

    const names = packs.map(p => p.manifest.name).sort()
    expect(names).toEqual(['Pack A', 'Pack B'])
  })

  test('getEntry() reads on demand', () => {
    const entries = [
      makeEntry({
        id: 'thm-001',
        statement: 'Convergence theorem.',
      }),
    ]
    createFakePack(packsDir, 'my-pack', { entries })

    const loader = new DKPLoader(packsDir)
    loader.load('my-pack')

    const entry = loader.getEntry('my-pack', 'thm-001')
    expect(entry).not.toBeNull()
    expect(entry!.statement).toBe('Convergence theorem.')
  })

  test('getEntry() returns null for missing entry', () => {
    createFakePack(packsDir, 'my-pack')

    const loader = new DKPLoader(packsDir)
    loader.load('my-pack')

    const entry = loader.getEntry('my-pack', 'nonexistent-999')
    expect(entry).toBeNull()
  })

  test('getEntries() batch read', () => {
    const entries = [
      makeEntry({ id: 'thm-001' }),
      makeEntry({ id: 'thm-002' }),
      makeEntry({ id: 'def-001', type: 'definition' }),
    ]
    createFakePack(packsDir, 'my-pack', { entries })

    const loader = new DKPLoader(packsDir)
    loader.load('my-pack')

    const result = loader.getEntries('my-pack', ['thm-001', 'def-001'])
    expect(result).toHaveLength(2)
    expect(result.map(e => e.id).sort()).toEqual(['def-001', 'thm-001'])
  })

  test('getEntriesByType() uses index', () => {
    const entries = [
      makeEntry({ id: 'thm-001', type: 'theorem' }),
      makeEntry({ id: 'thm-002', type: 'theorem' }),
      makeEntry({ id: 'def-001', type: 'definition' }),
    ]
    createFakePack(packsDir, 'my-pack', { entries })

    const loader = new DKPLoader(packsDir)
    loader.load('my-pack')

    const theorems = loader.getEntriesByType('my-pack', 'theorem')
    expect(theorems).toHaveLength(2)
    expect(theorems.every(e => e.type === 'theorem')).toBe(true)

    const definitions = loader.getEntriesByType('my-pack', 'definition')
    expect(definitions).toHaveLength(1)

    const algorithms = loader.getEntriesByType('my-pack', 'algorithm')
    expect(algorithms).toHaveLength(0)
  })

  test('getConnections() reads and caches', () => {
    const connections: ConnectionGraph = {
      edges: [
        { from: 'thm-001', to: 'def-001', relation: 'depends_on' },
        { from: 'thm-002', to: 'thm-001', relation: 'specializes' },
      ],
    }
    createFakePack(packsDir, 'my-pack', { connections })

    const loader = new DKPLoader(packsDir)
    loader.load('my-pack')

    const graph1 = loader.getConnections('my-pack')
    expect(graph1.edges).toHaveLength(2)
    expect(graph1.edges[0].relation).toBe('depends_on')

    // Second call should return cached
    const graph2 = loader.getConnections('my-pack')
    expect(graph2).toBe(graph1) // Same reference = cached
  })

  test('listAvailablePacks() scans dir', () => {
    createFakePack(packsDir, 'pack-a', {
      manifest: { name: 'Pack A' },
    })
    createFakePack(packsDir, 'pack-b', {
      manifest: { name: 'Pack B' },
    })

    const loader = new DKPLoader(packsDir)
    const manifests = loader.listAvailablePacks()

    expect(manifests).toHaveLength(2)
    const ids = manifests.map(m => m.id).sort()
    expect(ids).toEqual(['pack-a', 'pack-b'])
  })

  test('listAvailablePacks() skips dirs without manifest', () => {
    createFakePack(packsDir, 'valid-pack')

    // Create invalid dir with no manifest
    mkdirSync(join(packsDir, 'invalid-dir'), { recursive: true })
    writeFileSync(join(packsDir, 'invalid-dir', 'readme.txt'), 'no manifest')

    const loader = new DKPLoader(packsDir)
    const manifests = loader.listAvailablePacks()

    expect(manifests).toHaveLength(1)
    expect(manifests[0].id).toBe('valid-pack')
  })

  test('double load is idempotent', () => {
    createFakePack(packsDir, 'my-pack')

    const loader = new DKPLoader(packsDir)
    const first = loader.load('my-pack')
    const second = loader.load('my-pack')

    expect(second).toBe(first) // Same reference
    expect(loader.getLoadedPacks()).toHaveLength(1)
  })

  test('load() falls back to parsing .md files when directions.json missing', () => {
    createFakePack(packsDir, 'my-pack')

    // Remove directions.json to force fallback
    const djPath = join(
      packsDir,
      'my-pack',
      'knowledge',
      'directions',
      'directions.json',
    )
    rmSync(djPath)

    // Write a direction .md file
    writeFileSync(
      join(packsDir, 'my-pack', 'knowledge', 'directions', 'opt.md'),
      '# Optimization\n\nConvex optimization is great.\n\n## Key Entries\n- thm-001\n- alg-001\n',
      'utf-8',
    )

    const loader = new DKPLoader(packsDir)
    const loaded = loader.load('my-pack')

    expect(loaded.directions).toHaveLength(1)
    expect(loaded.directions[0].id).toBe('opt')
    expect(loaded.directions[0].name).toBe('Optimization')
    expect(loaded.directions[0].key_entries).toEqual(['thm-001', 'alg-001'])
  })

  test('getConnections() returns empty for unloaded pack', () => {
    const loader = new DKPLoader(packsDir)
    const graph = loader.getConnections('nonexistent')
    expect(graph.edges).toHaveLength(0)
  })

  test('getEntry() returns null for unloaded pack', () => {
    const loader = new DKPLoader(packsDir)
    const entry = loader.getEntry('nonexistent', 'thm-001')
    expect(entry).toBeNull()
  })

  test('unload() clears connections cache', () => {
    createFakePack(packsDir, 'my-pack')

    const loader = new DKPLoader(packsDir)
    loader.load('my-pack')

    // Prime connections cache
    const graph1 = loader.getConnections('my-pack')
    expect(graph1.edges.length).toBeGreaterThan(0)

    loader.unload('my-pack')

    // After unload, connections for this pack should return empty
    const graph2 = loader.getConnections('my-pack')
    expect(graph2.edges).toHaveLength(0)
  })
})
