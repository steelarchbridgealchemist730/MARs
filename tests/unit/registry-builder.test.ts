import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RegistryBuilder } from '../../src/paper/domain-knowledge/registry-builder'
import type {
  DatasetEntry,
  BenchmarkEntry,
} from '../../src/paper/domain-knowledge/types'
import { DKP_PATHS } from '../../src/paper/domain-knowledge/types'

// ── Tests ───────────────────────────────────────────────

describe('RegistryBuilder', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'registry-builder-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('addFromPaperParse()', () => {
    test('accumulates datasets from multiple papers', () => {
      const builder = new RegistryBuilder(tempDir)

      builder.addFromPaperParse({
        datasets: [{ name: 'DS1', description: 'First', access: 'url1' }],
        benchmarks: [],
      })

      builder.addFromPaperParse({
        datasets: [{ name: 'DS2', description: 'Second', access: 'url2' }],
        benchmarks: [],
      })

      // Access internal state via build with mocked LLM
      const collected = (builder as any).collectedDatasets
      expect(collected).toHaveLength(2)
      expect(collected[0].name).toBe('DS1')
      expect(collected[1].name).toBe('DS2')
    })

    test('accumulates benchmarks from multiple papers', () => {
      const builder = new RegistryBuilder(tempDir)

      builder.addFromPaperParse({
        datasets: [],
        benchmarks: [
          {
            name: 'BM1',
            description: 'First',
            standard_metrics: ['acc'],
            standard_baselines: ['random'],
            source: 'paper1',
          },
        ],
      })

      builder.addFromPaperParse({
        datasets: [],
        benchmarks: [
          {
            name: 'BM2',
            description: 'Second',
            standard_metrics: ['f1'],
            standard_baselines: ['majority'],
            source: 'paper2',
          },
        ],
      })

      const collected = (builder as any).collectedBenchmarks
      expect(collected).toHaveLength(2)
    })
  })

  describe('deduplication', () => {
    test('deduplicates datasets by name (case-insensitive)', () => {
      const builder = new RegistryBuilder(tempDir)

      builder.addFromPaperParse({
        datasets: [
          { name: 'ImageNet', description: 'From paper 1', access: 'url1' },
          { name: 'imagenet', description: 'From paper 2', access: 'url2' },
          { name: 'CIFAR-10', description: 'Another dataset', access: 'url3' },
        ],
        benchmarks: [],
      })

      const result = (builder as any).deduplicateDatasets(
        (builder as any).collectedDatasets,
      )
      expect(result).toHaveLength(2)
      // First occurrence wins
      expect(result[0].name).toBe('ImageNet')
      expect(result[1].name).toBe('CIFAR-10')
    })

    test('deduplicates benchmarks by name (case-insensitive)', () => {
      const builder = new RegistryBuilder(tempDir)

      builder.addFromPaperParse({
        datasets: [],
        benchmarks: [
          {
            name: 'GLUE',
            description: 'First',
            standard_metrics: ['acc'],
            standard_baselines: [],
            source: 'paper1',
          },
          {
            name: 'glue',
            description: 'Duplicate',
            standard_metrics: ['f1'],
            standard_baselines: [],
            source: 'paper2',
          },
        ],
      })

      const result = (builder as any).deduplicateBenchmarks(
        (builder as any).collectedBenchmarks,
      )
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('GLUE')
    })
  })

  describe('saveAll()', () => {
    test('writes files to correct paths', () => {
      const builder = new RegistryBuilder(tempDir)

      builder.saveAll({
        datasets: [{ name: 'DS1', description: 'Test', access: '' }],
        benchmarks: [
          {
            name: 'BM1',
            description: 'Test',
            standard_metrics: [],
            standard_baselines: [],
            source: '',
          },
        ],
        codebases: [
          {
            name: 'CB1',
            repo_url: 'url',
            language: 'Python',
            implements: 'algo',
          },
        ],
      })

      const datasetsPath = join(tempDir, DKP_PATHS.registries.datasets)
      const benchmarksPath = join(tempDir, DKP_PATHS.registries.benchmarks)
      const codebasesPath = join(tempDir, DKP_PATHS.registries.codebases)

      expect(existsSync(datasetsPath)).toBe(true)
      expect(existsSync(benchmarksPath)).toBe(true)
      expect(existsSync(codebasesPath)).toBe(true)

      const datasets = JSON.parse(readFileSync(datasetsPath, 'utf-8'))
      expect(datasets).toHaveLength(1)
      expect(datasets[0].name).toBe('DS1')

      const benchmarks = JSON.parse(readFileSync(benchmarksPath, 'utf-8'))
      expect(benchmarks).toHaveLength(1)
      expect(benchmarks[0].name).toBe('BM1')

      const codebases = JSON.parse(readFileSync(codebasesPath, 'utf-8'))
      expect(codebases).toHaveLength(1)
      expect(codebases[0].name).toBe('CB1')
    })
  })

  describe('build() with mocked LLM', () => {
    test('full build merges contributions + LLM results + saves', async () => {
      const builder = new RegistryBuilder(tempDir)

      // Add paper contributions
      builder.addFromPaperParse({
        datasets: [
          { name: 'Paper-DS', description: 'From paper', access: 'url' },
        ],
        benchmarks: [
          {
            name: 'Paper-BM',
            description: 'From paper',
            standard_metrics: ['acc'],
            standard_baselines: [],
            source: 'paper1',
          },
        ],
      })

      // Mock all LLM calls to return empty
      ;(builder as any).callLLMForDatasets = async () => ({
        items: [{ name: 'LLM-DS', description: 'From LLM', access: 'url' }],
        cost: 0.01,
      })
      ;(builder as any).callLLMForBenchmarks = async () => ({
        items: [
          {
            name: 'LLM-BM',
            description: 'From LLM',
            standard_metrics: ['f1'],
            standard_baselines: [],
            source: 'llm',
          },
        ],
        cost: 0.01,
      })
      ;(builder as any).callLLMForCodebases = async () => ({
        items: [
          {
            name: 'LLM-CB',
            repo_url: 'url',
            language: 'Python',
            implements: 'algo',
          },
        ],
        cost: 0.01,
      })

      const result = await builder.build('Test domain')

      expect(result.datasets).toBe(2) // Paper-DS + LLM-DS
      expect(result.benchmarks).toBe(2) // Paper-BM + LLM-BM
      expect(result.codebases).toBe(1) // LLM-CB

      // Verify files saved
      expect(existsSync(join(tempDir, DKP_PATHS.registries.datasets))).toBe(
        true,
      )
      expect(existsSync(join(tempDir, DKP_PATHS.registries.benchmarks))).toBe(
        true,
      )
      expect(existsSync(join(tempDir, DKP_PATHS.registries.codebases))).toBe(
        true,
      )
    })

    test('build with search disabled skips LLM calls', async () => {
      const builder = new RegistryBuilder(tempDir)

      let datasetsLLMCalled = false
      let benchmarksLLMCalled = false
      let codebasesLLMCalled = false

      ;(builder as any).callLLMForDatasets = async () => {
        datasetsLLMCalled = true
        return { items: [], cost: 0 }
      }
      ;(builder as any).callLLMForBenchmarks = async () => {
        benchmarksLLMCalled = true
        return { items: [], cost: 0 }
      }
      ;(builder as any).callLLMForCodebases = async () => {
        codebasesLLMCalled = true
        return { items: [], cost: 0 }
      }

      await builder.build('Test domain', {
        search_datasets: false,
        search_benchmarks: false,
        search_codebases: false,
      })

      expect(datasetsLLMCalled).toBe(false)
      expect(benchmarksLLMCalled).toBe(false)
      expect(codebasesLLMCalled).toBe(false)
    })
  })

  describe('parseJSONArray()', () => {
    test('parses valid JSON array', () => {
      const builder = new RegistryBuilder(tempDir)
      const result = (builder as any).parseJSONArray('[{"name":"Test"}]')
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Test')
    })

    test('handles markdown-fenced JSON', () => {
      const builder = new RegistryBuilder(tempDir)
      const result = (builder as any).parseJSONArray(
        '```json\n[{"name":"Test"}]\n```',
      )
      expect(result).toHaveLength(1)
    })

    test('returns empty for invalid JSON', () => {
      const builder = new RegistryBuilder(tempDir)
      const result = (builder as any).parseJSONArray('not json')
      expect(result).toHaveLength(0)
    })
  })
})
