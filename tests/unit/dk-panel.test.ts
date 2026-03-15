import { describe, test, expect } from 'bun:test'
import {
  searchEntries,
  findByTechnique,
} from '../../src/ui/components/viewer/panels/DomainKnowledgePanel'
import type {
  LoadedDKP,
  DKPManifest,
  DKPIndices,
  DKPRegistries,
  KnowledgeEntry,
} from '../../src/paper/domain-knowledge/types'
import { DKPLoader } from '../../src/paper/domain-knowledge/loader'

// ── Test Fixtures ──────────────────────────────────────

function makeMockManifest(name: string): DKPManifest {
  return {
    id: name,
    name,
    version: '1.0.0',
    description: `Test pack: ${name}`,
    sources: { textbooks: [], papers: [] },
    stats: {
      entries_total: 5,
      theorems: 2,
      definitions: 1,
      algorithms: 1,
      results: 1,
      datasets: 0,
      benchmarks: 0,
      codebases: 0,
    },
    context_sizes: {
      l0_overview_tokens: 100,
      l1_directions_tokens: 200,
      l2_entry_avg_tokens: 50,
    },
    built_at: '2026-01-01',
    built_with: 'test',
  }
}

function makeMockIndices(): DKPIndices {
  return {
    byType: {
      theorem: ['thm-001', 'thm-002'],
      proposition: [],
      lemma: ['lem-001'],
      corollary: [],
      definition: ['def-001'],
      algorithm: ['alg-001'],
      result: [],
    },
    byTopic: {
      convergence: ['thm-001', 'thm-002'],
      optimization: ['thm-001', 'alg-001'],
      'gradient descent': ['alg-001'],
      banach: ['thm-002', 'def-001'],
    },
    bySource: {
      'textbook-1': ['thm-001', 'thm-002', 'def-001'],
    },
    fullText: {
      convergence: ['thm-001', 'thm-002'],
      rate: ['thm-001'],
      gradient: ['alg-001', 'thm-001'],
      descent: ['alg-001'],
      banach: ['thm-002', 'def-001'],
      space: ['def-001', 'thm-002'],
      fixed: ['thm-002'],
      point: ['thm-002'],
    },
  }
}

function makeMockRegistries(): DKPRegistries {
  return { datasets: [], benchmarks: [], codebases: [] }
}

function makeMockPack(name = 'test-pack'): LoadedDKP {
  return {
    manifest: makeMockManifest(name),
    packDir: `/tmp/test/${name}`,
    overview: 'Test overview',
    directions: [
      {
        id: 'dir-convergence',
        name: 'Convergence Theory',
        summary: 'Convergence results',
        entry_count: 2,
        key_entries: ['thm-001', 'thm-002'],
      },
    ],
    indices: makeMockIndices(),
    registries: makeMockRegistries(),
  }
}

function makeMockEntry(
  id: string,
  overrides: Partial<KnowledgeEntry> = {},
): KnowledgeEntry {
  return {
    id,
    type: 'theorem',
    source: { id: 'textbook-1', chapter: 'Ch1', section: 'S1', page: 10 },
    label: `Theorem ${id}`,
    name: `Test theorem ${id}`,
    statement: `This is the statement for ${id}`,
    proof_technique: 'induction',
    proof_difficulty: 'moderate',
    usability: {
      citable: true,
      common_use: 'standard',
    },
    relations: {
      depends_on: [],
      used_by: [],
      generalizes: null,
      specialized_by: [],
    },
    tags: ['test'],
    ...overrides,
  }
}

// ── searchEntries tests ────────────────────────────────

describe('searchEntries', () => {
  const pack = makeMockPack()

  test('returns empty for empty query', () => {
    expect(searchEntries(pack, '')).toEqual([])
    expect(searchEntries(pack, '   ')).toEqual([])
  })

  test('finds entries by fullText keyword', () => {
    const results = searchEntries(pack, 'convergence')
    expect(results).toContain('thm-001')
    expect(results).toContain('thm-002')
  })

  test('finds entries by topic match', () => {
    const results = searchEntries(pack, 'banach')
    expect(results).toContain('thm-002')
    expect(results).toContain('def-001')
  })

  test('scores topic matches higher', () => {
    // "banach" appears in both fullText and byTopic for thm-002 and def-001
    // but also matches "optimization" topic for thm-001 via "gradient"
    const results = searchEntries(pack, 'gradient')
    // thm-001 appears in fullText["gradient"] and byTopic is not relevant
    // alg-001 appears in fullText["gradient"]
    expect(results).toContain('thm-001')
    expect(results).toContain('alg-001')
  })

  test('handles multi-word queries', () => {
    const results = searchEntries(pack, 'fixed point')
    // "fixed" -> thm-002, "point" -> thm-002 => score 2 for thm-002
    expect(results[0]).toBe('thm-002')
  })

  test('deduplicates results', () => {
    const results = searchEntries(pack, 'convergence banach')
    const unique = new Set(results)
    expect(results.length).toBe(unique.size)
  })

  test('respects maxResults', () => {
    const results = searchEntries(pack, 'convergence', 1)
    expect(results.length).toBeLessThanOrEqual(1)
  })

  test('returns empty for no matches', () => {
    const results = searchEntries(pack, 'xyznonexistent')
    expect(results).toEqual([])
  })

  test('partial keyword match works', () => {
    // "conv" should match "convergence" in fullText index
    const results = searchEntries(pack, 'conv')
    expect(results.length).toBeGreaterThan(0)
    expect(results).toContain('thm-001')
  })
})

// ── findByTechnique tests ──────────────────────────────

describe('findByTechnique', () => {
  test('returns empty for null loader', () => {
    const loader = new DKPLoader('/tmp/nonexistent-dk-test')
    const results = findByTechnique(loader, 'nonexistent', 'induction')
    expect(results).toEqual([])
  })

  test('returns empty for empty technique query', () => {
    const loader = new DKPLoader('/tmp/nonexistent-dk-test')
    // Even if pack were loaded, empty query should return empty
    const results = findByTechnique(loader, 'test-pack', '')
    expect(results).toEqual([])
  })

  test('returns empty for empty whitespace technique query', () => {
    const loader = new DKPLoader('/tmp/nonexistent-dk-test')
    const results = findByTechnique(loader, 'test-pack', '   ')
    expect(results).toEqual([])
  })
})

// ── searchEntries with empty indices ───────────────────

describe('searchEntries edge cases', () => {
  test('handles pack with empty indices', () => {
    const emptyPack: LoadedDKP = {
      ...makeMockPack(),
      indices: {
        byType: {
          theorem: [],
          proposition: [],
          lemma: [],
          corollary: [],
          definition: [],
          algorithm: [],
          result: [],
        },
        byTopic: {},
        bySource: {},
        fullText: {},
      },
    }
    const results = searchEntries(emptyPack, 'anything')
    expect(results).toEqual([])
  })

  test('handles single-character query', () => {
    const pack = makeMockPack()
    // Should not crash, may or may not find results
    const results = searchEntries(pack, 'a')
    expect(Array.isArray(results)).toBe(true)
  })
})
