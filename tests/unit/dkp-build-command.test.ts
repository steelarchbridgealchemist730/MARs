import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

// ── Config Parser Tests ──────────────────────────────────

describe('parseConfigYAML', () => {
  // Dynamic import to avoid top-level module resolution issues with mocks
  async function getParser() {
    const mod = await import('../../src/paper/domain-knowledge/config-parser')
    return mod
  }

  test('parses valid minimal config', async () => {
    const { parseConfigYAML } = await getParser()
    const yaml = `
name: volatility-modeling
description: "GARCH family, realized volatility"
`
    const config = parseConfigYAML(yaml)
    expect(config.name).toBe('volatility-modeling')
    expect(config.description).toBe('GARCH family, realized volatility')
    expect(config.textbooks).toBeUndefined()
    expect(config.papers).toBeUndefined()
  })

  test('parses full config with textbooks, papers, searches, registries', async () => {
    const { parseConfigYAML } = await getParser()
    const yaml = `
name: test-domain
description: "A test domain"

textbooks:
  - path: /tmp/book1.pdf
    id: book2024
    focus_chapters: [1, 2, 3]

papers:
  - id: smith2020
    source: semantic_scholar
  - id: jones2021
    path: /tmp/paper.pdf
  - id: arxiv2023
    source: arxiv

extra_searches:
  - query: "test query"
    max_results: 5
    year_from: 2020
  - query: "another query"

registries:
  search_datasets: true
  search_benchmarks: true
  search_codebases: false
`
    const config = parseConfigYAML(yaml)

    expect(config.name).toBe('test-domain')
    expect(config.textbooks).toHaveLength(1)
    expect(config.textbooks![0].id).toBe('book2024')
    expect(config.textbooks![0].focus_chapters).toEqual([1, 2, 3])

    expect(config.papers).toHaveLength(3)
    expect(config.papers![0].source).toBe('semantic_scholar')
    expect(config.papers![1].path).toBe('/tmp/paper.pdf')
    expect(config.papers![2].source).toBe('arxiv')

    expect(config.extra_searches).toHaveLength(2)
    expect(config.extra_searches![0].max_results).toBe(5)
    expect(config.extra_searches![0].year_from).toBe(2020)
    expect(config.extra_searches![1].max_results).toBe(10) // default

    expect(config.registries!.search_datasets).toBe(true)
    expect(config.registries!.search_codebases).toBe(false)
  })

  test('throws on missing name', async () => {
    const { parseConfigYAML, ConfigParseError } = await getParser()
    expect(() => parseConfigYAML('description: "test"')).toThrow(
      ConfigParseError,
    )
  })

  test('throws on missing description', async () => {
    const { parseConfigYAML, ConfigParseError } = await getParser()
    expect(() => parseConfigYAML('name: test')).toThrow(ConfigParseError)
  })

  test('throws on invalid YAML', async () => {
    const { parseConfigYAML, ConfigParseError } = await getParser()
    expect(() => parseConfigYAML('{{not: valid: yaml:')).toThrow(
      ConfigParseError,
    )
  })

  test('throws on invalid paper source', async () => {
    const { parseConfigYAML, ConfigParseError } = await getParser()
    const yaml = `
name: test
description: test
papers:
  - id: test
    source: invalid_source
`
    expect(() => parseConfigYAML(yaml)).toThrow(ConfigParseError)
  })
})

describe('expandPath', () => {
  test('expands ~ to home directory', async () => {
    const { expandPath } =
      await import('../../src/paper/domain-knowledge/config-parser')
    const result = expandPath('~/Documents/test.pdf')
    expect(result).toBe(join(homedir(), 'Documents', 'test.pdf'))
  })

  test('resolves relative paths to absolute', async () => {
    const { expandPath } =
      await import('../../src/paper/domain-knowledge/config-parser')
    const result = expandPath('relative/path.pdf')
    expect(result.startsWith('/')).toBe(true)
  })

  test('preserves absolute paths', async () => {
    const { expandPath } =
      await import('../../src/paper/domain-knowledge/config-parser')
    const result = expandPath('/absolute/path.pdf')
    expect(result).toBe('/absolute/path.pdf')
  })
})

describe('parseConfigFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkp-config-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('reads and parses YAML file', async () => {
    const { parseConfigFile } =
      await import('../../src/paper/domain-knowledge/config-parser')
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(
      configPath,
      'name: test-pack\ndescription: "A test"\n',
      'utf-8',
    )
    const config = parseConfigFile(configPath)
    expect(config.name).toBe('test-pack')
  })

  test('throws on missing file', async () => {
    const { parseConfigFile, ConfigParseError } =
      await import('../../src/paper/domain-knowledge/config-parser')
    expect(() => parseConfigFile(join(tmpDir, 'nonexistent.yaml'))).toThrow(
      ConfigParseError,
    )
  })
})

// ── Planner Tests ────────────────────────────────────────

describe('DKPPlanner', () => {
  describe('parsePlanResponse (via planToConfig)', () => {
    test('planToConfig produces valid DKPBuildConfig', async () => {
      const { DKPPlanner } =
        await import('../../src/paper/domain-knowledge/planner')
      const planner = new DKPPlanner()

      const plan = {
        domain: 'test-domain',
        description: 'A test domain',
        sub_directions: ['direction-a', 'direction-b'],
        recommended_textbooks: [
          {
            id: 'author2020',
            title: 'A Book',
            authors: ['Author'],
            year: 2020,
            reason: 'Important',
          },
        ],
        recommended_papers: [
          {
            id: 'smith2021',
            title: 'A Paper',
            authors: ['Smith'],
            year: 2021,
            arxiv_id: '2101.12345',
            reason: 'Seminal',
          },
          {
            id: 'jones2022',
            title: 'Another Paper',
            authors: ['Jones'],
            year: 2022,
            reason: 'Recent',
          },
        ],
        search_queries: [{ query: 'test query', max_results: 10 }],
      }

      const config = planner.planToConfig(plan)

      expect(config.name).toBe('test-domain')
      expect(config.description).toBe('A test domain')
      // Textbooks not included (need manual paths)
      expect(config.textbooks).toEqual([])
      // Papers use appropriate sources
      expect(config.papers).toHaveLength(2)
      expect(config.papers![0].source).toBe('arxiv') // has arxiv_id
      expect(config.papers![1].source).toBe('semantic_scholar') // no arxiv_id
      // Search queries passed through
      expect(config.extra_searches).toHaveLength(1)
      // Registries default to true
      expect(config.registries!.search_datasets).toBe(true)
    })
  })
})

// ── Pack Builder Phase Numbering ─────────────────────────

describe('DKPBuilder phase numbering', () => {
  test('build emits 8 phases with no textbooks/papers', async () => {
    const { DKPBuilder } =
      await import('../../src/paper/domain-knowledge/pack-builder')

    const mockExtractor = {
      extract: mock(async () => ({
        paper_id: 'test',
        text: { markdown: '', full_text: '', sections: [], tables: [] },
        figures: [],
        references: [],
        metadata: { title: '', authors: [], abstract: '', year: 0 },
        chunks: [],
        page_count: 0,
      })),
    } as any

    const tmpDir = mkdtempSync(join(tmpdir(), 'dkp-build-'))

    // Subclass that stubs LLM-dependent methods + registry builder
    class TestableBuilder extends DKPBuilder {
      // @ts-expect-error override private
      async generateOverview() {
        return { text: '# Overview', cost: 0 }
      }
      // @ts-expect-error override private
      async generateDirections() {
        return { directions: [], cost: 0 }
      }
      // Override factory methods to avoid LLM in registries
      protected override createRegistryBuilder(packDir: string) {
        return {
          addFromPaperParse: () => {},
          build: async () => ({ cost_usd: 0 }),
        } as any
      }
    }

    const builder = new TestableBuilder(mockExtractor, tmpDir)

    const phases: number[] = []
    const totalPhases: number[] = []

    // No textbooks, no papers → skips download/parse but still emits all phases
    const result = await builder.build(
      { name: 'test-pack', description: 'Test' },
      event => {
        if (event.type === 'phase') {
          phases.push(event.phase)
          totalPhases.push(event.total)
        }
      },
    )

    // Should report 8 total phases
    expect(phases.length).toBe(8)
    expect(totalPhases[0]).toBe(8)
    expect(phases).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(result.total_entries).toBe(0)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ── PackBuildProgress types ──────────────────────────────

describe('PackBuildProgress download events', () => {
  test('paper_downloaded event has correct shape', () => {
    const event = {
      type: 'paper_downloaded' as const,
      id: 'test-paper',
      source: 'arxiv',
    }
    expect(event.type).toBe('paper_downloaded')
    expect(event.id).toBe('test-paper')
    expect(event.source).toBe('arxiv')
  })

  test('paper_download_failed event has correct shape', () => {
    const event = {
      type: 'paper_download_failed' as const,
      id: 'test-paper',
      reason: 'Not found',
    }
    expect(event.type).toBe('paper_download_failed')
    expect(event.reason).toBe('Not found')
  })
})

// ── Incremental Index Rebuild ────────────────────────────

describe('incremental index rebuild', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkp-incr-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('buildIndices includes new entries after adding', async () => {
    const { buildIndices, buildConnectionGraph } =
      await import('../../src/paper/domain-knowledge/pack-builder')
    const { EntryStore } =
      await import('../../src/paper/domain-knowledge/entry-store')
    const { DKP_PATHS } = await import('../../src/paper/domain-knowledge/types')

    // Create pack directory structure
    const packDir = join(tmpDir, 'test-pack')
    mkdirSync(join(packDir, DKP_PATHS.knowledge.entries), { recursive: true })

    const store = new EntryStore(packDir)
    store.init()

    // Add an entry
    const id = store.nextId('theorem')
    store.saveEntry({
      id,
      type: 'theorem',
      source: { id: 'book1', chapter: '1', section: '1', page: 1 },
      label: 'Theorem 1.1',
      name: 'Test Theorem',
      statement: 'If X then Y',
      tags: ['analysis', 'convergence'],
      usability: { citable: true, common_use: 'Testing' },
      relations: {
        depends_on: [],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
    })

    // Build indices
    const allEntries = store.loadAllEntries()
    expect(allEntries).toHaveLength(1)

    const indices = buildIndices(allEntries)
    expect(indices.byType.theorem).toContain(id)
    expect(indices.byTopic['analysis']).toContain(id)
    expect(indices.bySource['book1']).toContain(id)

    // Add another entry
    const id2 = store.nextId('definition')
    store.saveEntry({
      id: id2,
      type: 'definition',
      source: { id: 'book1', chapter: '1', section: '2', page: 5 },
      label: 'Definition 1.2',
      name: 'Test Definition',
      statement: 'X is defined as Y',
      tags: ['analysis'],
      usability: { citable: true, common_use: 'Testing' },
      relations: {
        depends_on: [],
        used_by: [id],
        generalizes: null,
        specialized_by: [],
      },
    })

    // Rebuild indices — should include both
    const allEntries2 = store.loadAllEntries()
    expect(allEntries2).toHaveLength(2)

    const indices2 = buildIndices(allEntries2)
    expect(indices2.byType.theorem).toContain(id)
    expect(indices2.byType.definition).toContain(id2)
    expect(indices2.byTopic['analysis']).toContain(id)
    expect(indices2.byTopic['analysis']).toContain(id2)

    // Connection graph should link them
    const graph = buildConnectionGraph(allEntries2)
    expect(graph.edges.length).toBeGreaterThan(0)
  })
})
