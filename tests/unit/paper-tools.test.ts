import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Test ResultInsertTool (doesn't need network)
import { ResultInsertTool } from '../../src/tools/paper/ResultInsertTool'

describe('ResultInsertTool', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-paper-tools-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('converts CSV to LaTeX table', async () => {
    const csvPath = join(tempDir, 'results.csv')
    writeFileSync(
      csvPath,
      'Method,Accuracy,F1\nBaseline,0.85,0.82\nOurs,0.92,0.90\n',
    )

    const outputPath = join(tempDir, 'table.tex')

    const gen = ResultInsertTool.call(
      {
        action: 'table',
        source_path: csvPath,
        output_path: outputPath,
        caption: 'Comparison of methods',
        label: 'tab:comparison',
        highlight_best: true,
      },
      {} as any,
    )

    // Consume the generator
    let result: any
    for await (const item of gen) {
      if (item.type === 'result') result = item.data
    }

    expect(result.success).toBe(true)
    const content = readFileSync(outputPath, 'utf-8')
    expect(content).toContain('\\begin{table}')
    expect(content).toContain('\\caption{Comparison of methods}')
    expect(content).toContain('\\label{tab:comparison}')
    expect(content).toContain('\\textbf{0.92}') // Best accuracy
    expect(content).toContain('\\textbf{0.90}') // Best F1
    expect(content).toContain('\\toprule')
    expect(content).toContain('\\bottomrule')
  })

  test('generates LaTeX figure environment', async () => {
    const outputPath = join(tempDir, 'figure.tex')

    const gen = ResultInsertTool.call(
      {
        action: 'figure',
        source_path: 'figures/result.png',
        output_path: outputPath,
        caption: 'Training curve',
        label: 'fig:training',
        width: '0.9\\textwidth',
      },
      {} as any,
    )

    let result: any
    for await (const item of gen) {
      if (item.type === 'result') result = item.data
    }

    expect(result.success).toBe(true)
    const content = readFileSync(outputPath, 'utf-8')
    expect(content).toContain('\\begin{figure}')
    expect(content).toContain('\\includegraphics[width=0.9\\textwidth]')
    expect(content).toContain('figures/result.png')
    expect(content).toContain('\\caption{Training curve}')
    expect(content).toContain('\\label{fig:training}')
  })
})

// Test tool registration
import { getAllTools } from '../../src/tools/index'

describe('Tool registration', () => {
  test('all paper tools are registered', () => {
    const tools = getAllTools()
    const toolNames = tools.map(t => t.name)

    expect(toolNames).toContain('ArxivSearch')
    expect(toolNames).toContain('SemanticScholarSearch')
    expect(toolNames).toContain('SSRNSearch')
    expect(toolNames).toContain('PaperDownload')
    expect(toolNames).toContain('PaperQA')
    expect(toolNames).toContain('LatexCompile')
    expect(toolNames).toContain('ResultInsert')
  })
})
