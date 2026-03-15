import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EntryStore } from '../../src/paper/domain-knowledge/entry-store'
import { TextbookParser } from '../../src/paper/domain-knowledge/textbook-parser'
import type { ChapterContent } from '../../src/paper/domain-knowledge/textbook-parser'
import type { PDFExtractResult } from '../../src/paper/pdf-extractor'
import type { PDFExtractor } from '../../src/paper/pdf-extractor'
import type { TextbookConfig } from '../../src/paper/domain-knowledge/types'

// ── Mock Helpers ────────────────────────────────────────

function makeMockExtractResult(
  overrides: Partial<PDFExtractResult> = {},
): PDFExtractResult {
  return {
    paper_id: 'test-book',
    text: {
      markdown:
        '# Chapter 1: Introduction\nSome intro text about optimization.\n\n# Chapter 2: Convex Optimization\nConvexity is fundamental.\n\n## 2.1 Definitions\nA function f is convex if...\n\n## 2.2 Theorems\nThe gradient descent theorem states...\n\n# Chapter 3: Applications\nApplications of convex optimization.',
      full_text: '',
      sections: [
        { title: 'Chapter 1: Introduction', level: 1, char_offset: 0 },
        {
          title: 'Chapter 2: Convex Optimization',
          level: 1,
          char_offset: 49,
        },
        { title: '2.1 Definitions', level: 2, char_offset: 101 },
        { title: '2.2 Theorems', level: 2, char_offset: 146 },
        { title: 'Chapter 3: Applications', level: 1, char_offset: 204 },
      ],
      tables: [],
    },
    figures: [],
    references: [],
    metadata: {
      title: 'Test Textbook',
      authors: ['Test Author'],
      abstract: '',
      year: 2024,
    },
    chunks: [],
    page_count: 100,
    ...overrides,
  }
}

function makeMockPDFExtractor(result?: PDFExtractResult): PDFExtractor {
  return {
    extract: mock(async () => result ?? makeMockExtractResult()),
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

const MOCK_LLM_RESPONSE = JSON.stringify([
  {
    type: 'definition',
    label: 'Convex Function',
    name: 'Convex Function',
    statement:
      'A function $f: \\mathbb{R}^n \\to \\mathbb{R}$ is convex if $f(\\lambda x + (1-\\lambda)y) \\leq \\lambda f(x) + (1-\\lambda) f(y)$.',
    usability: {
      citable: true,
      cite_as: 'Boyd & Vandenberghe (2004)',
      common_use: 'Foundation for convex optimization',
    },
    relations: {
      depends_on: [],
      used_by: [],
      generalizes: null,
      specialized_by: [],
    },
    tags: ['convexity', 'optimization'],
    source: { section: '2.1', page: 10 },
  },
  {
    type: 'theorem',
    label: 'Gradient Descent Convergence',
    name: 'Gradient Descent Convergence Theorem',
    statement:
      'For L-smooth convex functions, gradient descent with step size $1/L$ converges at rate $O(1/k)$.',
    assumptions: [
      {
        id: 'A1',
        text: 'f is L-smooth',
        strength: 'standard',
      },
      {
        id: 'A2',
        text: 'f is convex',
        strength: 'standard',
      },
    ],
    proof_sketch: 'By descent lemma and telescoping sum.',
    proof_technique: 'descent lemma',
    proof_difficulty: 'moderate',
    usability: {
      citable: true,
      common_use: 'Convergence analysis of first-order methods',
    },
    relations: {
      depends_on: [],
      used_by: [],
      generalizes: null,
      specialized_by: [],
    },
    tags: ['gradient descent', 'convergence', 'optimization'],
    source: { section: '2.2', page: 15 },
  },
])

// ── Tests ───────────────────────────────────────────────

describe('TextbookParser', () => {
  let tempDir: string
  let store: EntryStore
  let mockExtractor: PDFExtractor

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'textbook-parser-test-'))
    store = new EntryStore(tempDir)
    store.init()
    mockExtractor = makeMockPDFExtractor()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('identifyChapters()', () => {
    test('splits text at level-1 headings', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const extracted = makeMockExtractResult()
      const chapters = parser.identifyChapters(extracted)

      expect(chapters).toHaveLength(3)
      expect(chapters[0].number).toBe(1)
      expect(chapters[0].title).toBe('Chapter 1: Introduction')
      expect(chapters[1].number).toBe(2)
      expect(chapters[1].title).toBe('Chapter 2: Convex Optimization')
      expect(chapters[2].number).toBe(3)
      expect(chapters[2].title).toBe('Chapter 3: Applications')
    })

    test('collects sub-sections within chapter', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const extracted = makeMockExtractResult()
      const chapters = parser.identifyChapters(extracted)

      // Chapter 2 should have sub-sections
      expect(chapters[1].sections).toHaveLength(2)
      expect(chapters[1].sections[0].title).toBe('2.1 Definitions')
      expect(chapters[1].sections[1].title).toBe('2.2 Theorems')
    })

    test('falls back to level-2 headings when no level-1', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const extracted = makeMockExtractResult({
        text: {
          markdown: '## Section A\nText A\n\n## Section B\nText B',
          full_text: '',
          sections: [
            { title: 'Section A', level: 2, char_offset: 0 },
            { title: 'Section B', level: 2, char_offset: 22 },
          ],
          tables: [],
        },
      })

      const chapters = parser.identifyChapters(extracted)
      expect(chapters).toHaveLength(2)
      expect(chapters[0].title).toBe('Section A')
      expect(chapters[1].title).toBe('Section B')
    })

    test('treats entire text as one chapter when no headings', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const extracted = makeMockExtractResult({
        text: {
          markdown: 'Just plain text with no headings at all.',
          full_text: '',
          sections: [],
          tables: [],
        },
      })

      const chapters = parser.identifyChapters(extracted)
      expect(chapters).toHaveLength(1)
      expect(chapters[0].number).toBe(1)
      expect(chapters[0].title).toBe('Full Text')
      expect(chapters[0].text).toBe('Just plain text with no headings at all.')
    })

    test('returns empty for empty text', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const extracted = makeMockExtractResult({
        text: { markdown: '', full_text: '', sections: [], tables: [] },
      })

      const chapters = parser.identifyChapters(extracted)
      expect(chapters).toHaveLength(0)
    })
  })

  describe('parse() with mocked LLM', () => {
    // We need to mock chatCompletion at the module level
    let originalModule: any

    beforeEach(async () => {
      // Mock the llm-client module
      originalModule = await import('../../src/paper/llm-client')
    })

    test('chapter filtering with focus_chapters', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const extracted = makeMockExtractResult()
      const chapters = parser.identifyChapters(extracted)

      // Simulate filtering
      const filtered = chapters.filter(ch => [1, 3].includes(ch.number))
      expect(filtered).toHaveLength(2)
      expect(filtered[0].number).toBe(1)
      expect(filtered[1].number).toBe(3)
    })

    test('progress events are emitted', async () => {
      // Mock chatCompletion
      const { chatCompletion } = await import('../../src/paper/llm-client')
      const mockChat = mock(async () => ({
        text: MOCK_LLM_RESPONSE,
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: 0.05,
        stop_reason: 'end_turn',
      }))

      // Create parser with mock
      const parser = new TextbookParser(store, mockExtractor)
      // Override the private callLLM via prototype
      ;(parser as any).callLLM = async () => {
        const result = mockChat()
        const entries = (parser as any).parseEntries((await result).text)
        return { entries, cost: 0.05 }
      }

      const events: any[] = []
      const config: TextbookConfig = {
        path: '/fake/book.pdf',
        id: 'test-book',
      }

      await parser.parse(config, tempDir, event => events.push(event))

      // Should have phase, chapter_start, chapter_done events
      const phases = events.filter(e => e.type === 'phase')
      const starts = events.filter(e => e.type === 'chapter_start')
      const dones = events.filter(e => e.type === 'chapter_done')

      expect(phases.length).toBeGreaterThan(0)
      expect(starts.length).toBe(3) // 3 chapters
      expect(dones.length).toBe(3)
    })
  })

  describe('parseEntries() (JSON parsing)', () => {
    test('parses valid JSON array', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const entries = (parser as any).parseEntries(MOCK_LLM_RESPONSE)

      expect(entries).toHaveLength(2)
      expect(entries[0].type).toBe('definition')
      expect(entries[0].label).toBe('Convex Function')
      expect(entries[1].type).toBe('theorem')
      expect(entries[1].label).toBe('Gradient Descent Convergence')
    })

    test('handles markdown-fenced JSON', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const fenced = '```json\n' + MOCK_LLM_RESPONSE + '\n```'
      const entries = (parser as any).parseEntries(fenced)

      expect(entries).toHaveLength(2)
    })

    test('repairs truncated JSON array', () => {
      const parser = new TextbookParser(store, mockExtractor)
      // Truncated after first entry
      const truncated =
        '[{"type":"definition","label":"Test","name":"Test","statement":"A test.","usability":{"citable":true,"common_use":"testing"},"relations":{"depends_on":[],"used_by":[],"generalizes":null,"specialized_by":[]},"tags":["test"]},{"type":"theorem","label":"Trunc'

      const entries = (parser as any).parseEntries(truncated)
      // Should get at least the first complete entry
      expect(entries.length).toBeGreaterThanOrEqual(1)
      expect(entries[0].type).toBe('definition')
      expect(entries[0].label).toBe('Test')
    })

    test('skips malformed entries', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const withBad = JSON.stringify([
        {
          type: 'definition',
          label: 'Good',
          name: 'Good',
          statement: 'Valid.',
          usability: { citable: true, common_use: 'test' },
          relations: {
            depends_on: [],
            used_by: [],
            generalizes: null,
            specialized_by: [],
          },
          tags: [],
        },
        { type: 'invalid_type', label: 'Bad' }, // invalid type
        { statement: 'Missing type and label' }, // missing required fields
        {
          type: 'theorem',
          label: 'Also Good',
          name: 'Also Good',
          statement: 'Also valid.',
          usability: { citable: true, common_use: '' },
          relations: {
            depends_on: [],
            used_by: [],
            generalizes: null,
            specialized_by: [],
          },
          tags: [],
        },
      ])

      const entries = (parser as any).parseEntries(withBad)
      expect(entries).toHaveLength(2)
      expect(entries[0].label).toBe('Good')
      expect(entries[1].label).toBe('Also Good')
    })

    test('returns empty array for unparseable response', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const entries = (parser as any).parseEntries(
        'This is not JSON at all, just text.',
      )
      expect(entries).toHaveLength(0)
    })

    test('provides defaults for missing optional fields', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const minimal = JSON.stringify([
        {
          type: 'theorem',
          label: 'Minimal Theorem',
          statement: 'x > 0',
          // Missing: name, usability, relations, tags
        },
      ])

      const entries = (parser as any).parseEntries(minimal)
      expect(entries).toHaveLength(1)
      expect(entries[0].name).toBe('Minimal Theorem') // defaults to label
      expect(entries[0].usability.citable).toBe(true)
      expect(entries[0].relations.depends_on).toEqual([])
      expect(entries[0].tags).toEqual([])
    })
  })

  describe('validateEntries()', () => {
    test('preserves theorem-specific fields', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const raw = [
        {
          type: 'theorem',
          label: 'Test',
          name: 'Test',
          statement: 'x > 0',
          assumptions: [{ id: 'A1', text: 'x is real', strength: 'standard' }],
          proof_sketch: 'By contradiction.',
          proof_technique: 'contradiction',
          proof_difficulty: 'elementary',
          usability: { citable: true, common_use: 'test' },
          relations: {
            depends_on: [],
            used_by: [],
            generalizes: null,
            specialized_by: [],
          },
          tags: ['test'],
        },
      ]

      const entries = (parser as any).validateEntries(raw)
      expect(entries[0].assumptions).toHaveLength(1)
      expect(entries[0].proof_sketch).toBe('By contradiction.')
      expect(entries[0].proof_technique).toBe('contradiction')
      expect(entries[0].proof_difficulty).toBe('elementary')
    })

    test('preserves algorithm-specific fields', () => {
      const parser = new TextbookParser(store, mockExtractor)
      const raw = [
        {
          type: 'algorithm',
          label: 'SGD',
          name: 'Stochastic Gradient Descent',
          statement: 'Iterative optimization algorithm',
          pseudocode: '1. Sample mini-batch\n2. Compute gradient\n3. Update',
          complexity: 'O(n)',
          inputs: 'Initial parameters, learning rate',
          outputs: 'Optimized parameters',
          usability: { citable: true, common_use: 'training' },
          relations: {
            depends_on: [],
            used_by: [],
            generalizes: null,
            specialized_by: [],
          },
          tags: ['optimization'],
        },
      ]

      const entries = (parser as any).validateEntries(raw)
      expect(entries[0].pseudocode).toContain('Sample mini-batch')
      expect(entries[0].complexity).toBe('O(n)')
      expect(entries[0].inputs).toContain('learning rate')
      expect(entries[0].outputs).toContain('Optimized parameters')
    })
  })

  describe('integration: identifyChapters + parseEntries', () => {
    test('end-to-end with mocked LLM', async () => {
      const parser = new TextbookParser(store, mockExtractor)

      // Override callLLM to return mock data
      ;(parser as any).callLLM = async () => {
        const entries = (parser as any).parseEntries(MOCK_LLM_RESPONSE)
        return { entries, cost: 0.05 }
      }

      const config: TextbookConfig = {
        path: '/fake/book.pdf',
        id: 'test-book',
        focus_chapters: [2], // Only parse chapter 2
      }

      const result = await parser.parse(config, tempDir)

      expect(result.sourceId).toBe('test-book')
      expect(result.chapters_parsed).toBe(1)
      expect(result.entries_created).toBe(2)
      expect(result.cost_usd).toBeCloseTo(0.05)
      expect(result.errors).toHaveLength(0)

      // Verify entries were saved to disk
      const ids = store.listEntryIds()
      expect(ids).toHaveLength(2)

      const entry = store.getEntry(ids[0])
      expect(entry).not.toBeNull()
      expect(entry!.source.id).toBe('test-book')
      expect(entry!.source.chapter).toBe('2')
    })

    test('error accumulation: failing chapters still produce partial results', async () => {
      const parser = new TextbookParser(store, mockExtractor)

      let callCount = 0
      ;(parser as any).callLLM = async (
        _text: string,
        _sourceId: string,
        chapterNum: number,
      ) => {
        callCount++
        if (chapterNum === 2) {
          throw new Error('LLM call failed for chapter 2')
        }
        const entries = (parser as any).parseEntries(MOCK_LLM_RESPONSE)
        return { entries, cost: 0.03 }
      }

      const config: TextbookConfig = {
        path: '/fake/book.pdf',
        id: 'test-book',
      }

      const result = await parser.parse(config, tempDir)

      // Chapters 1 and 3 should succeed, chapter 2 should fail
      expect(result.entries_created).toBe(4) // 2 per successful chapter
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('Chapter 2')
    })
  })
})
