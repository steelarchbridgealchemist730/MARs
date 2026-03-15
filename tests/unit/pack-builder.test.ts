import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EntryStore } from '../../src/paper/domain-knowledge/entry-store'
import {
  DKPBuilder,
  buildConnectionGraph,
  buildIndices,
} from '../../src/paper/domain-knowledge/pack-builder'
import { RegistryBuilder } from '../../src/paper/domain-knowledge/registry-builder'
import type { PDFExtractResult } from '../../src/paper/pdf-extractor'
import type { PDFExtractor } from '../../src/paper/pdf-extractor'
import type {
  KnowledgeEntry,
  DKPBuildConfig,
  ConnectionGraph,
} from '../../src/paper/domain-knowledge/types'
import { DKP_PATHS } from '../../src/paper/domain-knowledge/types'

// ── Mock Helpers ────────────────────────────────────────

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

function makeMockPDFExtractor(): PDFExtractor {
  return {
    extract: mock(async () => ({
      paper_id: 'mock',
      text: {
        markdown: '# Mock\nContent here.',
        full_text: '',
        sections: [{ title: 'Mock', level: 1, char_offset: 0 }],
        tables: [],
      },
      figures: [],
      references: [],
      metadata: {
        title: 'Mock',
        authors: ['Author'],
        abstract: '',
        year: 2024,
      },
      chunks: [],
      page_count: 10,
    })),
    analyzeFiguresWithVision: mock(async (r: PDFExtractResult) => r),
    buildEnrichedText: mock(() => ''),
    writeIndexableOutput: mock(async () => ({
      enrichedPath: '',
      chunksPath: '',
    })),
    isAvailable: mock(async () => true),
    isPymupdf4llmAvailable: mock(async () => true),
  } as unknown as PDFExtractor
}

// ── Tests: buildConnectionGraph ─────────────────────────

describe('buildConnectionGraph()', () => {
  test('creates depends_on edges', () => {
    const entries = [
      makeEntry({
        id: 'thm-001',
        relations: {
          depends_on: ['def-001'],
          used_by: [],
          generalizes: null,
          specialized_by: [],
        },
      }),
      makeEntry({
        id: 'def-001',
        type: 'definition',
        relations: {
          depends_on: [],
          used_by: [],
          generalizes: null,
          specialized_by: [],
        },
      }),
    ]

    const graph = buildConnectionGraph(entries)

    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toEqual({
      from: 'thm-001',
      to: 'def-001',
      relation: 'depends_on',
    })
  })

  test('creates reverse depends_on from used_by', () => {
    const entries = [
      makeEntry({
        id: 'def-001',
        type: 'definition',
        relations: {
          depends_on: [],
          used_by: ['thm-001'],
          generalizes: null,
          specialized_by: [],
        },
      }),
      makeEntry({
        id: 'thm-001',
        relations: {
          depends_on: [],
          used_by: [],
          generalizes: null,
          specialized_by: [],
        },
      }),
    ]

    const graph = buildConnectionGraph(entries)

    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toEqual({
      from: 'thm-001',
      to: 'def-001',
      relation: 'depends_on',
    })
  })

  test('creates generalized_by edges', () => {
    const entries = [
      makeEntry({
        id: 'thm-001',
        relations: {
          depends_on: [],
          used_by: [],
          generalizes: 'thm-002',
          specialized_by: [],
        },
      }),
      makeEntry({
        id: 'thm-002',
        relations: {
          depends_on: [],
          used_by: [],
          generalizes: null,
          specialized_by: [],
        },
      }),
    ]

    const graph = buildConnectionGraph(entries)

    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toEqual({
      from: 'thm-001',
      to: 'thm-002',
      relation: 'generalized_by',
    })
  })

  test('creates specializes edges', () => {
    const entries = [
      makeEntry({
        id: 'thm-001',
        relations: {
          depends_on: [],
          used_by: [],
          generalizes: null,
          specialized_by: ['thm-003'],
        },
      }),
      makeEntry({
        id: 'thm-003',
        relations: {
          depends_on: [],
          used_by: [],
          generalizes: null,
          specialized_by: [],
        },
      }),
    ]

    const graph = buildConnectionGraph(entries)

    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toEqual({
      from: 'thm-003',
      to: 'thm-001',
      relation: 'specializes',
    })
  })

  test('skips edges with missing targets', () => {
    const entries = [
      makeEntry({
        id: 'thm-001',
        relations: {
          depends_on: ['nonexistent-001'],
          used_by: ['nonexistent-002'],
          generalizes: 'nonexistent-003',
          specialized_by: ['nonexistent-004'],
        },
      }),
    ]

    const graph = buildConnectionGraph(entries)
    expect(graph.edges).toHaveLength(0)
  })

  test('handles empty entries', () => {
    const graph = buildConnectionGraph([])
    expect(graph.edges).toHaveLength(0)
  })

  test('creates multiple edge types', () => {
    const entries = [
      makeEntry({
        id: 'thm-001',
        relations: {
          depends_on: ['def-001'],
          used_by: [],
          generalizes: 'thm-002',
          specialized_by: [],
        },
      }),
      makeEntry({
        id: 'def-001',
        type: 'definition',
        relations: {
          depends_on: [],
          used_by: [],
          generalizes: null,
          specialized_by: [],
        },
      }),
      makeEntry({
        id: 'thm-002',
        relations: {
          depends_on: [],
          used_by: [],
          generalizes: null,
          specialized_by: [],
        },
      }),
    ]

    const graph = buildConnectionGraph(entries)
    expect(graph.edges).toHaveLength(2)

    const relations = graph.edges.map(e => e.relation).sort()
    expect(relations).toEqual(['depends_on', 'generalized_by'])
  })
})

// ── Tests: buildIndices ─────────────────────────────────

describe('buildIndices()', () => {
  test('groups entries by type', () => {
    const entries = [
      makeEntry({ id: 'thm-001', type: 'theorem' }),
      makeEntry({ id: 'def-001', type: 'definition' }),
      makeEntry({ id: 'thm-002', type: 'theorem' }),
      makeEntry({ id: 'alg-001', type: 'algorithm' }),
    ]

    const indices = buildIndices(entries)

    expect(indices.byType.theorem).toEqual(['thm-001', 'thm-002'])
    expect(indices.byType.definition).toEqual(['def-001'])
    expect(indices.byType.algorithm).toEqual(['alg-001'])
    expect(indices.byType.result).toEqual([])
  })

  test('groups entries by topic (tags)', () => {
    const entries = [
      makeEntry({ id: 'thm-001', tags: ['optimization', 'convexity'] }),
      makeEntry({ id: 'def-001', tags: ['convexity', 'analysis'] }),
      makeEntry({ id: 'alg-001', tags: ['optimization'] }),
    ]

    const indices = buildIndices(entries)

    expect(indices.byTopic['optimization']).toEqual(['thm-001', 'alg-001'])
    expect(indices.byTopic['convexity']).toEqual(['thm-001', 'def-001'])
    expect(indices.byTopic['analysis']).toEqual(['def-001'])
  })

  test('groups entries by source', () => {
    const entries = [
      makeEntry({
        id: 'thm-001',
        source: { id: 'book-a', chapter: '1', section: '', page: 0 },
      }),
      makeEntry({
        id: 'def-001',
        source: { id: 'book-b', chapter: '2', section: '', page: 0 },
      }),
      makeEntry({
        id: 'thm-002',
        source: { id: 'book-a', chapter: '3', section: '', page: 0 },
      }),
    ]

    const indices = buildIndices(entries)

    expect(indices.bySource['book-a']).toEqual(['thm-001', 'thm-002'])
    expect(indices.bySource['book-b']).toEqual(['def-001'])
  })

  test('builds full-text index with expected keywords', () => {
    const entries = [
      makeEntry({
        id: 'thm-001',
        statement: 'Gradient descent converges for convex functions',
        label: 'GD Convergence',
        name: 'GD Convergence',
        tags: ['optimization'],
      }),
    ]

    const indices = buildIndices(entries)

    expect(indices.fullText['gradient']).toContain('thm-001')
    expect(indices.fullText['descent']).toContain('thm-001')
    expect(indices.fullText['converges']).toContain('thm-001')
    expect(indices.fullText['convex']).toContain('thm-001')
    expect(indices.fullText['optimization']).toContain('thm-001')
  })

  test('full-text index excludes stop words', () => {
    const entries = [
      makeEntry({
        id: 'thm-001',
        statement: 'For all x in the set',
        label: 'Test',
        tags: [],
      }),
    ]

    const indices = buildIndices(entries)

    // Stop words should not be indexed
    expect(indices.fullText['for']).toBeUndefined()
    expect(indices.fullText['the']).toBeUndefined()
    expect(indices.fullText['in']).toBeUndefined()
    // But "all" and "set" should be
    expect(indices.fullText['all']).toContain('thm-001')
    expect(indices.fullText['set']).toContain('thm-001')
  })

  test('handles empty entries', () => {
    const indices = buildIndices([])

    expect(indices.byType.theorem).toEqual([])
    expect(Object.keys(indices.byTopic)).toHaveLength(0)
    expect(Object.keys(indices.bySource)).toHaveLength(0)
    expect(Object.keys(indices.fullText)).toHaveLength(0)
  })

  test('normalizes tags to lowercase', () => {
    const entries = [
      makeEntry({ id: 'thm-001', tags: ['Optimization', 'CONVEX'] }),
      makeEntry({ id: 'def-001', tags: ['optimization'] }),
    ]

    const indices = buildIndices(entries)

    expect(indices.byTopic['optimization']).toEqual(['thm-001', 'def-001'])
    expect(indices.byTopic['convex']).toEqual(['thm-001'])
    // Should not have capitalized keys
    expect(indices.byTopic['Optimization']).toBeUndefined()
  })
})

// ── Tests: DKPBuilder.build() ───────────────────────────

describe('DKPBuilder', () => {
  let tempDir: string
  let packsDir: string
  let mockExtractor: PDFExtractor

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pack-builder-test-'))
    packsDir = join(tempDir, 'packs')
    mkdirSync(packsDir, { recursive: true })
    mockExtractor = makeMockPDFExtractor()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('creates pack directory structure', async () => {
    const builder = new DKPBuilder(mockExtractor, packsDir)

    // Mock all LLM-dependent methods
    mockDKPBuilder(builder)

    const config: DKPBuildConfig = {
      name: 'Test Pack',
      description: 'A test knowledge pack',
    }

    const result = await builder.build(config)

    expect(result.packDir).toBe(join(packsDir, 'test-pack'))
    expect(existsSync(join(result.packDir, 'knowledge', 'entries'))).toBe(true)
    expect(existsSync(join(result.packDir, 'knowledge', 'directions'))).toBe(
      true,
    )
    expect(existsSync(join(result.packDir, 'registries'))).toBe(true)
    expect(existsSync(join(result.packDir, 'index'))).toBe(true)
    expect(existsSync(join(result.packDir, 'sources'))).toBe(true)
  })

  test('writes manifest with correct structure', async () => {
    const builder = new DKPBuilder(mockExtractor, packsDir)
    mockDKPBuilder(builder)

    const config: DKPBuildConfig = {
      name: 'My Domain Pack',
      description: 'Convex optimization knowledge',
    }

    const result = await builder.build(config)

    const manifestPath = join(result.packDir, DKP_PATHS.manifest)
    expect(existsSync(manifestPath)).toBe(true)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(manifest.id).toBe('my-domain-pack')
    expect(manifest.name).toBe('My Domain Pack')
    expect(manifest.description).toBe('Convex optimization knowledge')
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.built_with).toBe('claude-paper')
    expect(manifest.built_at).toBeTruthy()
    expect(manifest.stats).toBeDefined()
    expect(manifest.context_sizes).toBeDefined()
    expect(manifest.sources).toBeDefined()
  })

  test('manifest stats match actual entry counts', async () => {
    const builder = new DKPBuilder(mockExtractor, packsDir)
    mockDKPBuilder(builder)

    // Override createTextbookParser to inject known entries
    ;(builder as any).createTextbookParser = (store: EntryStore) => ({
      parse: async () => {
        // Create entries directly in the shared EntryStore
        store.saveEntry(
          makeEntry({ id: store.nextId('theorem'), type: 'theorem' }),
        )
        store.saveEntry(
          makeEntry({ id: store.nextId('theorem'), type: 'theorem' }),
        )
        store.saveEntry(
          makeEntry({ id: store.nextId('definition'), type: 'definition' }),
        )
        store.saveEntry(
          makeEntry({ id: store.nextId('algorithm'), type: 'algorithm' }),
        )
        return {
          sourceId: 'test-book',
          chapters_parsed: 1,
          entries_created: 4,
          cost_usd: 0.1,
          errors: [],
        }
      },
    })

    const config: DKPBuildConfig = {
      name: 'Stats Test',
      description: 'Test stats accuracy',
      textbooks: [{ path: '/fake/book.pdf', id: 'test-book' }],
    }

    const result = await builder.build(config)

    expect(result.manifest.stats.entries_total).toBe(4)
    expect(result.manifest.stats.theorems).toBe(2)
    expect(result.manifest.stats.definitions).toBe(1)
    expect(result.manifest.stats.algorithms).toBe(1)
    expect(result.manifest.stats.results).toBe(0)
  })

  test('writes connection graph', async () => {
    const builder = new DKPBuilder(mockExtractor, packsDir)
    mockDKPBuilder(builder)

    const config: DKPBuildConfig = {
      name: 'Connection Test',
      description: 'Test connections',
    }

    const result = await builder.build(config)

    const connPath = join(result.packDir, DKP_PATHS.knowledge.connections)
    expect(existsSync(connPath)).toBe(true)

    const connGraph = JSON.parse(readFileSync(connPath, 'utf-8'))
    expect(connGraph).toHaveProperty('edges')
    expect(Array.isArray(connGraph.edges)).toBe(true)
  })

  test('writes index files', async () => {
    const builder = new DKPBuilder(mockExtractor, packsDir)
    mockDKPBuilder(builder)

    const config: DKPBuildConfig = {
      name: 'Index Test',
      description: 'Test index generation',
    }

    const result = await builder.build(config)

    expect(existsSync(join(result.packDir, DKP_PATHS.index.byType))).toBe(true)
    expect(existsSync(join(result.packDir, DKP_PATHS.index.byTopic))).toBe(true)
    expect(existsSync(join(result.packDir, DKP_PATHS.index.bySource))).toBe(
      true,
    )
    expect(existsSync(join(result.packDir, DKP_PATHS.index.fullText))).toBe(
      true,
    )
  })

  test('writes directions.json', async () => {
    const builder = new DKPBuilder(mockExtractor, packsDir)
    mockDKPBuilder(builder)

    const config: DKPBuildConfig = {
      name: 'Directions JSON Test',
      description: 'Test directions.json output',
    }

    const result = await builder.build(config)

    const djPath = join(
      result.packDir,
      DKP_PATHS.knowledge.directions,
      'directions.json',
    )
    expect(existsSync(djPath)).toBe(true)

    const directions = JSON.parse(readFileSync(djPath, 'utf-8'))
    expect(Array.isArray(directions)).toBe(true)
    expect(directions).toHaveLength(1)
    expect(directions[0].id).toBe('test-direction')
    expect(directions[0].name).toBe('Test Direction')
  })

  test('writes overview file', async () => {
    const builder = new DKPBuilder(mockExtractor, packsDir)
    mockDKPBuilder(builder)

    const config: DKPBuildConfig = {
      name: 'Overview Test',
      description: 'Test overview generation',
    }

    const result = await builder.build(config)

    const overviewPath = join(result.packDir, DKP_PATHS.knowledge.overview)
    expect(existsSync(overviewPath)).toBe(true)
  })

  test('error accumulation: failing textbook still allows papers', async () => {
    const builder = new DKPBuilder(mockExtractor, packsDir)
    mockDKPBuilder(builder)

    const config: DKPBuildConfig = {
      name: 'Error Test',
      description: 'Test error handling',
      textbooks: [{ path: '/nonexistent/book.pdf', id: 'bad-book' }],
      papers: [{ id: 'no-path-paper' }], // No path -> warning
    }

    const result = await builder.build(config)

    // Should have errors but not crash
    expect(result.errors.length).toBeGreaterThan(0)
    // Should still produce a valid pack
    expect(existsSync(join(result.packDir, DKP_PATHS.manifest))).toBe(true)
  })

  test('empty config produces valid empty pack', async () => {
    const builder = new DKPBuilder(mockExtractor, packsDir)
    mockDKPBuilder(builder)

    const config: DKPBuildConfig = {
      name: 'Empty Pack',
      description: 'No sources at all',
    }

    const result = await builder.build(config)

    expect(result.total_entries).toBe(0)
    expect(result.manifest.stats.entries_total).toBe(0)
    expect(existsSync(join(result.packDir, DKP_PATHS.manifest))).toBe(true)
    expect(
      existsSync(join(result.packDir, DKP_PATHS.knowledge.connections)),
    ).toBe(true)
  })

  test('progress events are emitted', async () => {
    const builder = new DKPBuilder(mockExtractor, packsDir)
    mockDKPBuilder(builder)

    const events: any[] = []
    const config: DKPBuildConfig = {
      name: 'Progress Test',
      description: 'Test progress events',
    }

    await builder.build(config, event => events.push(event))

    const phases = events.filter(e => e.type === 'phase')
    expect(phases.length).toBe(8) // 8 build phases (incl. download)
    expect(phases[0].phase).toBe(1)
    expect(phases[7].phase).toBe(8)
  })

  test('papers without path are skipped with warning', async () => {
    const builder = new DKPBuilder(mockExtractor, packsDir)
    mockDKPBuilder(builder)

    const config: DKPBuildConfig = {
      name: 'Skip Test',
      description: 'Test paper skip',
      papers: [
        { id: 'paper-no-path', source: 'arxiv' },
        { id: 'paper-no-path-2', source: 'semantic_scholar' },
      ],
    }

    const result = await builder.build(config)

    const skipErrors = result.errors.filter(e => e.includes('no local path'))
    expect(skipErrors).toHaveLength(2)
  })

  test('slugify produces correct pack directory name', async () => {
    const builder = new DKPBuilder(mockExtractor, packsDir)
    mockDKPBuilder(builder)

    const config: DKPBuildConfig = {
      name: 'Convex Optimization & Analysis (2024)',
      description: 'Test slugify',
    }

    const result = await builder.build(config)

    expect(result.packDir).toBe(
      join(packsDir, 'convex-optimization-analysis-2024'),
    )
  })
})

// ── Helper: mock DKPBuilder internals ───────────────────

function mockDKPBuilder(builder: DKPBuilder): void {
  // Mock the LLM-dependent methods
  ;(builder as any).generateOverview = async () => ({
    text: '# Overview\n\nTest overview content.',
    cost: 0,
  })
  ;(builder as any).generateDirections = async () => ({
    directions: [
      {
        id: 'test-direction',
        name: 'Test Direction',
        summary: 'A test direction summary.',
        entry_count: 0,
        key_entries: [],
      },
    ],
    cost: 0,
  })

  // Mock factory methods to avoid real LLM calls from parsers/registry
  ;(builder as any).createTextbookParser = (store: EntryStore) => {
    const parser = Object.create(
      (builder as any).__proto__.createTextbookParser ? {} : {},
    )
    parser.parse = async (config: any, packDir: string) => {
      throw new Error(`Mock: no real textbook parsing for ${config.id}`)
    }
    return parser
  }
  ;(builder as any).createPaperParser = (store: EntryStore) => {
    const parser = {} as any
    parser.parse = async (config: any, packDir: string) => ({
      sourceId: config.id,
      entries_created: 0,
      registry_contributions: { datasets: [], benchmarks: [] },
      cost_usd: 0,
      errors: [],
    })
    return parser
  }
  ;(builder as any).createRegistryBuilder = (packDir: string) => {
    const rb = new RegistryBuilder(packDir)
    // Mock the LLM calls
    ;(rb as any).callLLMForDatasets = async () => ({ items: [], cost: 0 })
    ;(rb as any).callLLMForBenchmarks = async () => ({ items: [], cost: 0 })
    ;(rb as any).callLLMForCodebases = async () => ({ items: [], cost: 0 })
    return rb
  }
}
