/**
 * REAL end-to-end tests — calls actual APIs (arXiv, Semantic Scholar, Anthropic).
 * These cost money and take time. Only run when REAL_E2E=true is set.
 *
 * Usage:
 *   REAL_E2E=true bun test tests/integration/paper-real-e2e.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
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

const REAL = process.env.REAL_E2E === 'true'
const describeReal = REAL ? describe : describe.skip

let tmpDir: string

describeReal('Real E2E: arXiv Search Tool', () => {
  test('searches arXiv and returns papers', async () => {
    const { ArxivSearchTool } =
      await import('../../src/tools/paper/ArxivSearchTool')
    const gen = ArxivSearchTool.call({
      query: 'rough volatility',
      max_results: 5,
      sort_by: 'relevance',
    })

    let result: any = null
    for await (const item of gen) {
      if (item.type === 'result') {
        result = item.data
      }
    }

    expect(result).not.toBeNull()
    expect(result.papers.length).toBeGreaterThan(0)
    expect(result.papers[0].title).toBeTruthy()
    expect(result.papers[0].arxiv_id).toBeTruthy()
    console.log(
      `  arXiv returned ${result.papers.length} papers, first: "${result.papers[0].title}"`,
    )
  }, 30000)
})

describeReal('Real E2E: Semantic Scholar Tool', () => {
  test('searches S2 and returns papers with citation counts', async () => {
    const { SemanticScholarTool } =
      await import('../../src/tools/paper/SemanticScholarTool')

    try {
      const gen = SemanticScholarTool.call({
        query: 'transformer attention mechanism',
        limit: 5,
      })

      let result: any = null
      for await (const item of gen) {
        if (item.type === 'result') {
          result = item.data
        }
      }

      expect(result).not.toBeNull()
      expect(result.papers.length).toBeGreaterThan(0)
      expect(result.papers[0].citationCount).toBeGreaterThanOrEqual(0)
      console.log(
        `  S2 returned ${result.papers.length} papers, top citations: ${result.papers[0].citationCount}`,
      )
    } catch (err: any) {
      if (err.message?.includes('rate limit')) {
        console.log('  S2 rate limited (429) - skipping (expected in CI)')
        return // pass the test - rate limit is not a code bug
      }
      throw err
    }
  }, 30000)
})

describeReal('Real E2E: Paper Discovery (arXiv + S2 combined)', () => {
  test('discovers and deduplicates papers from multiple sources', async () => {
    const { PaperDiscovery } =
      await import('../../src/paper/deep-research/discovery')
    const discovery = new PaperDiscovery({
      depth: 'quick',
      max_papers: 15,
      since_year: 2020,
    })

    const plan = {
      topic: 'neural network pruning',
      dimensions: [
        {
          name: 'pruning methods',
          queries: {
            precise: ['structured pruning neural networks'],
            broad: ['model compression deep learning'],
            cross_domain: [],
          },
        },
      ],
      key_authors: [],
      key_venues: [],
      completion_criteria: 'test',
      created_at: new Date().toISOString(),
    }

    const papers = await discovery.discover(plan)

    expect(papers.length).toBeGreaterThan(0)
    expect(papers.length).toBeLessThanOrEqual(15)
    // Check deduplication worked (no duplicate titles)
    const titles = papers.map(p => p.title.toLowerCase())
    const uniqueTitles = new Set(titles)
    expect(uniqueTitles.size).toBe(titles.length)

    console.log(`  Discovered ${papers.length} unique papers from arXiv + S2`)
    console.log(
      `  Top paper: "${papers[0].title}" (relevance: ${papers[0].relevance_score.toFixed(3)})`,
    )
  }, 60000)
})

describeReal('Real E2E: PDF Acquisition Chain', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-real-e2e-'))
  })
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('downloads a real arXiv PDF', async () => {
    const { PaperAcquisitionChain } =
      await import('../../src/paper/acquisition')
    const chain = new PaperAcquisitionChain({ output_dir: tmpDir })
    const result = await chain.acquire({
      title: 'Attention Is All You Need',
      arxiv_id: '1706.03762',
    })

    expect(result.success).toBe(true)
    expect(result.status).toBe('downloaded')
    expect(result.pdf_path).toBeTruthy()
    expect(existsSync(result.pdf_path!)).toBe(true)

    // Verify it's a real PDF
    const bytes = readFileSync(result.pdf_path!)
    expect(bytes[0]).toBe(0x25) // %
    expect(bytes[1]).toBe(0x50) // P
    expect(bytes[2]).toBe(0x44) // D
    expect(bytes[3]).toBe(0x46) // F

    const sizeKB = Math.round(bytes.length / 1024)
    console.log(`  Downloaded PDF: ${result.pdf_path} (${sizeKB} KB)`)
  }, 30000)
})

describeReal('Real E2E: Experiment Runner', () => {
  let projectDir: string

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'cpaper-exp-e2e-'))
  })
  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  test('runs a real Python experiment script and extracts metrics', async () => {
    const { ExperimentRunner } =
      await import('../../src/paper/experiment/runner')
    const experimentsDir = join(projectDir, 'experiments')
    mkdirSync(experimentsDir, { recursive: true })

    // Write a real Python script
    writeFileSync(
      join(experimentsDir, 'test_experiment.py'),
      `#!/usr/bin/env python3
import random
import math

random.seed(42)

# Simulate a simple experiment
n_samples = 100
predictions = [random.gauss(0, 1) for _ in range(n_samples)]
actuals = [p + random.gauss(0, 0.5) for p in predictions]

mse = sum((p - a) ** 2 for p, a in zip(predictions, actuals)) / n_samples
rmse = math.sqrt(mse)
r2 = 1 - sum((a - p) ** 2 for p, a in zip(predictions, actuals)) / sum((a - sum(actuals)/len(actuals)) ** 2 for a in actuals)

print(f"accuracy: {1 - mse:.4f}")
print(f"mse: {mse:.4f}")
print(f"rmse: {rmse:.4f}")
print(f"r2: {r2:.4f}")
print("Experiment completed successfully.")
`,
      'utf-8',
    )

    const runner = new ExperimentRunner(projectDir)
    const logs: string[] = []

    const run = await runner.run(
      {
        id: 'test-plan',
        proposal_id: 'test',
        title: 'Test Experiment',
        description: 'Simple metric extraction test',
        scripts: [
          {
            name: 'test',
            filename: 'test_experiment.py',
            description: 'Test script',
            language: 'python' as const,
          },
        ],
        dependencies: [],
        datasets: [],
        resource_estimate: {
          gpu_required: false,
          ram_gb: 1,
          disk_gb: 1,
          estimated_wall_time_hours: 0.01,
          feasible: true,
        },
        created_at: new Date().toISOString(),
      },
      line => logs.push(line),
    )

    expect(run.status).toBe('completed')
    expect(run.exit_code).toBe(0)
    expect(run.metrics).toBeDefined()
    expect(typeof run.metrics.mse).toBe('number')
    expect(typeof run.metrics.rmse).toBe('number')
    expect(typeof run.metrics.r2).toBe('number')
    expect(run.metrics.mse).toBeGreaterThan(0)

    console.log(`  Experiment completed with metrics:`)
    console.log(`    MSE: ${run.metrics.mse}`)
    console.log(`    RMSE: ${run.metrics.rmse}`)
    console.log(`    R2: ${run.metrics.r2}`)
  }, 30000)
})

describeReal('Real E2E: LaTeX Compilation', () => {
  let projectDir: string

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'cpaper-latex-e2e-'))
  })
  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  test('compiles a real LaTeX document to PDF', async () => {
    const paperDir = join(projectDir, 'paper')
    mkdirSync(paperDir, { recursive: true })

    writeFileSync(
      join(paperDir, 'main.tex'),
      `\\documentclass{article}
\\title{Test Paper for Claude Paper E2E}
\\author{Claude Paper Test}
\\begin{document}
\\maketitle
\\begin{abstract}
This is a test document compiled by the Claude Paper E2E test suite.
\\end{abstract}
\\section{Introduction}
This paper demonstrates that the LaTeX compilation pipeline works correctly.
\\section{Results}
The results show that $E = mc^2$ is still valid.
\\end{document}
`,
      'utf-8',
    )

    const { LaTeXEngine } = await import('../../src/paper/writing/latex-engine')
    const engine = new LaTeXEngine(projectDir)
    const result = await engine.compile(join(paperDir, 'main.tex'))

    expect(result.success).toBe(true)
    expect(result.pdf_path).toBeTruthy()
    expect(existsSync(result.pdf_path!)).toBe(true)

    const pdfBytes = readFileSync(result.pdf_path!)
    expect(pdfBytes.length).toBeGreaterThan(1000) // A real PDF is at least a few KB
    expect(pdfBytes[0]).toBe(0x25) // %PDF

    console.log(
      `  LaTeX compiled successfully: ${result.pdf_path} (${Math.round(pdfBytes.length / 1024)} KB)`,
    )
    if (result.warnings.length > 0) {
      console.log(`  Warnings: ${result.warnings.length}`)
    }
  }, 60000)
})

describeReal('Real E2E: LLM Proposal Generation (costs money)', () => {
  test('generates a real proposal via Claude API', async () => {
    const { ProposalGenerator } =
      await import('../../src/paper/proposal/generator')
    const tmpProject = mkdtempSync(join(tmpdir(), 'cpaper-proposal-e2e-'))
    const litDir = join(tmpProject, 'literature')
    mkdirSync(litDir, { recursive: true })

    // Write minimal survey and gaps files
    writeFileSync(
      join(litDir, 'survey.md'),
      '# Survey\n\nResearch on neural pruning methods shows that structured pruning achieves better speedups than unstructured pruning.\n\nKey papers: lottery ticket hypothesis, movement pruning.',
      'utf-8',
    )
    writeFileSync(
      join(litDir, 'gaps.md'),
      '# Gaps\n\n1. No unified framework for comparing pruning methods across architectures.\n2. Limited work on pruning for vision transformers.',
      'utf-8',
    )

    try {
      const generator = new ProposalGenerator('claude-sonnet-4-20250514')
      const proposals = await generator.generate({
        count: 1,
        research_dir: tmpProject,
      })

      expect(proposals.length).toBe(1)
      expect(proposals[0].title).toBeTruthy()
      expect(proposals[0].abstract.length).toBeGreaterThan(50)
      expect(proposals[0].innovation.length).toBeGreaterThan(0)
      expect(proposals[0].novelty_score).toBeGreaterThan(0)
      expect(proposals[0].feasibility.score).toBeGreaterThan(0)

      console.log(`  Generated proposal: "${proposals[0].title}"`)
      console.log(
        `  Novelty: ${proposals[0].novelty_score.toFixed(2)}, Feasibility: ${proposals[0].feasibility.score.toFixed(2)}`,
      )
    } finally {
      rmSync(tmpProject, { recursive: true, force: true })
    }
  }, 120000)
})

describeReal('Real E2E: System Probe (full)', () => {
  test('probes system and returns complete capabilities', async () => {
    const { probeSystem } = await import('../../src/paper/system-probe')
    const caps = await probeSystem()

    expect(caps.os.name).toBeTruthy()
    expect(caps.cpu.model).toBeTruthy()
    expect(caps.cpu.cores).toBeGreaterThan(0)
    expect(caps.memory.total_gb).toBeGreaterThan(0)
    expect(caps.disk.length).toBeGreaterThan(0)
    expect(caps.python.version).toBeTruthy()
    expect(caps.git.available).toBe(true)

    const { SystemProbe } = await import('../../src/paper/system-probe')
    const probe = new SystemProbe()
    const summary = await probe.formatSummary(caps)
    expect(summary).toContain('System Capabilities')
    expect(summary).toContain('[CPU]')
    expect(summary).toContain('[Memory]')
    expect(summary).toContain('[Network]')

    console.log(`  System: ${caps.os.name} ${caps.os.arch}`)
    console.log(`  CPU: ${caps.cpu.model} (${caps.cpu.cores} cores)`)
    console.log(
      `  RAM: ${caps.memory.total_gb} GB total, ${caps.memory.available_gb} GB available`,
    )
    console.log(
      `  Python: ${caps.python.version}, uv: ${caps.python.uv_available}`,
    )
    console.log(
      `  Network: ${caps.network.download_mbps ? caps.network.download_mbps + ' Mbps' : 'not tested'}`,
    )
  }, 30000)
})
