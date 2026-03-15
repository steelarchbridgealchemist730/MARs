import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EntryStore } from '../../src/paper/domain-knowledge/entry-store'
import { PaperParser } from '../../src/paper/domain-knowledge/paper-parser'
import type { PDFExtractResult } from '../../src/paper/pdf-extractor'
import type { PDFExtractor } from '../../src/paper/pdf-extractor'
import type { PaperSourceConfig } from '../../src/paper/domain-knowledge/types'

// ── Mock Helpers ────────────────────────────────────────

function makeMockExtractResult(
  overrides: Partial<PDFExtractResult> = {},
): PDFExtractResult {
  return {
    paper_id: 'test-paper',
    text: {
      markdown:
        '# Neural Operator for Fast Calibration\n\nAbstract: We propose a neural operator approach...\n\n## Method\nOur method uses a DeepONet architecture...\n\n## Experiments\nWe evaluate on the stochastic volatility calibration benchmark using RMSE and MAE.\n\nDataset: SV-Calibration-2024 (synthetic, 100k samples).',
      full_text: '',
      sections: [
        {
          title: 'Neural Operator for Fast Calibration',
          level: 1,
          char_offset: 0,
        },
        { title: 'Method', level: 2, char_offset: 70 },
        { title: 'Experiments', level: 2, char_offset: 120 },
      ],
      tables: [],
    },
    figures: [],
    references: [],
    metadata: {
      title: 'Neural Operator for Fast Calibration',
      authors: ['Test Author'],
      abstract: 'We propose a neural operator approach...',
      year: 2024,
    },
    chunks: [],
    page_count: 12,
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

const MOCK_LLM_RESPONSE = JSON.stringify({
  entries: [
    {
      type: 'result',
      label: 'Neural Operator Speedup',
      name: 'DeepONet Calibration Result',
      statement:
        'Neural operator achieves 100x speedup over traditional SDE solvers with <1% RMSE degradation.',
      usability: {
        citable: true,
        cite_as: 'Author et al. (2024)',
        common_use: 'Fast calibration baseline',
      },
      relations: {
        depends_on: [],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['neural operator', 'calibration', 'speedup'],
      source: { section: 'Experiments', page: 8 },
    },
    {
      type: 'algorithm',
      label: 'DeepONet Training',
      name: 'DeepONet Training Procedure',
      statement: 'Training procedure for DeepONet on calibration data.',
      pseudocode: '1. Generate training pairs\n2. Train DeepONet\n3. Fine-tune',
      complexity: 'O(n * d)',
      inputs: 'Training data pairs',
      outputs: 'Trained operator',
      usability: {
        citable: true,
        common_use: 'Operator learning',
      },
      relations: {
        depends_on: [],
        used_by: [],
        generalizes: null,
        specialized_by: [],
      },
      tags: ['deeponet', 'training'],
      source: { section: 'Method', page: 4 },
    },
  ],
  datasets: [
    {
      name: 'SV-Calibration-2024',
      description: 'Synthetic stochastic volatility calibration dataset',
      access: 'Generated via code in repo',
      source_paper: 'test-paper',
      format: 'CSV',
      size: '100k samples',
    },
  ],
  benchmarks: [
    {
      name: 'SV Calibration Benchmark',
      description: 'Standard calibration accuracy benchmark',
      standard_metrics: ['RMSE', 'MAE'],
      standard_baselines: ['Traditional SDE solver', 'MC simulation'],
      source: 'test-paper',
    },
  ],
})

// ── Tests ───────────────────────────────────────────────

describe('PaperParser', () => {
  let tempDir: string
  let store: EntryStore
  let mockExtractor: PDFExtractor

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'paper-parser-test-'))
    store = new EntryStore(tempDir)
    store.init()
    mockExtractor = makeMockPDFExtractor()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('parse() with mocked LLM', () => {
    test('extracts entries and registry contributions', async () => {
      const parser = new PaperParser(store, mockExtractor)

      // Override callLLM
      ;(parser as any).callLLM = async () => {
        const result = (parser as any).parseResponse(MOCK_LLM_RESPONSE)
        return { ...result, cost: 0.03 }
      }

      const config: PaperSourceConfig = {
        id: 'test-paper',
        path: '/fake/paper.pdf',
      }

      const result = await parser.parse(config, tempDir)

      expect(result.sourceId).toBe('test-paper')
      expect(result.entries_created).toBe(2)
      expect(result.cost_usd).toBeCloseTo(0.03)
      expect(result.errors).toHaveLength(0)

      // Registry contributions
      expect(result.registry_contributions.datasets).toHaveLength(1)
      expect(result.registry_contributions.datasets[0].name).toBe(
        'SV-Calibration-2024',
      )
      expect(result.registry_contributions.benchmarks).toHaveLength(1)
      expect(result.registry_contributions.benchmarks[0].name).toBe(
        'SV Calibration Benchmark',
      )
    })

    test('entries have correct source.id from config', async () => {
      const parser = new PaperParser(store, mockExtractor)

      ;(parser as any).callLLM = async () => {
        const result = (parser as any).parseResponse(MOCK_LLM_RESPONSE)
        return { ...result, cost: 0.02 }
      }

      const config: PaperSourceConfig = {
        id: 'my-custom-paper-id',
        path: '/fake/paper.pdf',
      }

      await parser.parse(config, tempDir)

      const entries = store.loadAllEntries()
      expect(entries).toHaveLength(2)
      for (const entry of entries) {
        expect(entry.source.id).toBe('my-custom-paper-id')
      }
    })

    test('entries are saved to EntryStore', async () => {
      const parser = new PaperParser(store, mockExtractor)

      ;(parser as any).callLLM = async () => {
        const result = (parser as any).parseResponse(MOCK_LLM_RESPONSE)
        return { ...result, cost: 0.02 }
      }

      const config: PaperSourceConfig = {
        id: 'test-paper',
        path: '/fake/paper.pdf',
      }

      await parser.parse(config, tempDir)

      const ids = store.listEntryIds()
      expect(ids).toHaveLength(2)

      const entry = store.getEntry(ids[0])
      expect(entry).not.toBeNull()
      expect(entry!.source.id).toBe('test-paper')
    })

    test('handles missing path gracefully', async () => {
      const parser = new PaperParser(store, mockExtractor)

      const config: PaperSourceConfig = {
        id: 'no-path-paper',
        // No path!
      }

      const result = await parser.parse(config, tempDir)

      expect(result.entries_created).toBe(0)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('no local path')
    })

    test('handles LLM failure gracefully', async () => {
      const parser = new PaperParser(store, mockExtractor)

      ;(parser as any).callLLM = async () => {
        throw new Error('LLM service unavailable')
      }

      const config: PaperSourceConfig = {
        id: 'test-paper',
        path: '/fake/paper.pdf',
      }

      const result = await parser.parse(config, tempDir)

      expect(result.entries_created).toBe(0)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('LLM extraction failed')
    })

    test('handles PDF extraction failure gracefully', async () => {
      const failExtractor = {
        extract: mock(async () => {
          throw new Error('PDF corrupted')
        }),
      } as unknown as PDFExtractor

      const parser = new PaperParser(store, failExtractor)

      const config: PaperSourceConfig = {
        id: 'bad-pdf',
        path: '/fake/corrupted.pdf',
      }

      const result = await parser.parse(config, tempDir)

      expect(result.entries_created).toBe(0)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('PDF extraction failed')
    })

    test('progress events are emitted', async () => {
      const parser = new PaperParser(store, mockExtractor)

      ;(parser as any).callLLM = async () => {
        const result = (parser as any).parseResponse(MOCK_LLM_RESPONSE)
        return { ...result, cost: 0.02 }
      }

      const events: any[] = []
      const config: PaperSourceConfig = {
        id: 'test-paper',
        path: '/fake/paper.pdf',
      }

      await parser.parse(config, tempDir, event => events.push(event))

      const phases = events.filter(e => e.type === 'phase')
      const dones = events.filter(e => e.type === 'done')

      expect(phases.length).toBeGreaterThan(0)
      expect(dones).toHaveLength(1)
      expect(dones[0].entries).toBe(2)
    })
  })

  describe('parseResponse() (JSON parsing)', () => {
    test('parses valid response with entries + datasets + benchmarks', () => {
      const parser = new PaperParser(store, mockExtractor)
      const result = (parser as any).parseResponse(MOCK_LLM_RESPONSE)

      expect(result.entries).toHaveLength(2)
      expect(result.paperDatasets).toHaveLength(1)
      expect(result.paperBenchmarks).toHaveLength(1)
    })

    test('handles markdown-fenced JSON', () => {
      const parser = new PaperParser(store, mockExtractor)
      const fenced = '```json\n' + MOCK_LLM_RESPONSE + '\n```'
      const result = (parser as any).parseResponse(fenced)

      expect(result.entries).toHaveLength(2)
      expect(result.paperDatasets).toHaveLength(1)
    })

    test('returns empty for unparseable response', () => {
      const parser = new PaperParser(store, mockExtractor)
      const result = (parser as any).parseResponse('Not JSON at all.')

      expect(result.entries).toHaveLength(0)
      expect(result.paperDatasets).toHaveLength(0)
      expect(result.paperBenchmarks).toHaveLength(0)
    })

    test('handles response with only entries, no datasets', () => {
      const parser = new PaperParser(store, mockExtractor)
      const response = JSON.stringify({
        entries: [
          {
            type: 'theorem',
            label: 'Test',
            name: 'Test',
            statement: 'x > 0',
            tags: [],
          },
        ],
      })

      const result = (parser as any).parseResponse(response)
      expect(result.entries).toHaveLength(1)
      expect(result.paperDatasets).toHaveLength(0)
      expect(result.paperBenchmarks).toHaveLength(0)
    })

    test('skips invalid entries', () => {
      const parser = new PaperParser(store, mockExtractor)
      const response = JSON.stringify({
        entries: [
          { type: 'result', label: 'Good', statement: 'Valid.', tags: [] },
          { type: 'invalid_type', label: 'Bad' },
          { label: 'Missing type' },
        ],
        datasets: [],
        benchmarks: [],
      })

      const result = (parser as any).parseResponse(response)
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].label).toBe('Good')
    })

    test('validates dataset entries', () => {
      const parser = new PaperParser(store, mockExtractor)
      const response = JSON.stringify({
        entries: [],
        datasets: [
          { name: 'Valid DS', description: 'A dataset', access: 'URL' },
          { description: 'Missing name' }, // should be skipped
          { name: 'Minimal DS' }, // should work with defaults
        ],
        benchmarks: [],
      })

      const result = (parser as any).parseResponse(response)
      expect(result.paperDatasets).toHaveLength(2)
      expect(result.paperDatasets[0].name).toBe('Valid DS')
      expect(result.paperDatasets[1].name).toBe('Minimal DS')
    })

    test('validates benchmark entries', () => {
      const parser = new PaperParser(store, mockExtractor)
      const response = JSON.stringify({
        entries: [],
        datasets: [],
        benchmarks: [
          {
            name: 'Valid BM',
            description: 'A benchmark',
            standard_metrics: ['acc'],
            standard_baselines: ['random'],
            source: 'paper',
          },
          { description: 'Missing name' }, // should be skipped
        ],
      })

      const result = (parser as any).parseResponse(response)
      expect(result.paperBenchmarks).toHaveLength(1)
      expect(result.paperBenchmarks[0].standard_metrics).toEqual(['acc'])
    })
  })

  describe('text truncation', () => {
    test('truncates long paper text', async () => {
      // Create extractor that returns very long text
      const longText = 'A'.repeat(100_000)
      const longExtractor = makeMockPDFExtractor(
        makeMockExtractResult({
          text: {
            markdown: longText,
            full_text: '',
            sections: [],
            tables: [],
          },
        }),
      )

      const parser = new PaperParser(store, longExtractor)

      let capturedText = ''
      ;(parser as any).callLLM = async (text: string) => {
        capturedText = text
        return {
          entries: [],
          paperDatasets: [],
          paperBenchmarks: [],
          cost: 0,
        }
      }

      const config: PaperSourceConfig = {
        id: 'long-paper',
        path: '/fake/long.pdf',
      }

      await parser.parse(config, tempDir)

      // Should be truncated to MAX_PAPER_CHARS (60k)
      expect(capturedText.length).toBeLessThanOrEqual(60_000)
    })
  })
})
