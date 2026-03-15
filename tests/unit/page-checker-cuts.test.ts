import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import type {
  VenueConstraints,
  CutSuggestion,
} from '../../src/paper/writing/types'

const TMP = join(import.meta.dir, '__page_checker_cuts_tmp__')

// ── Mock LLM client ────────────────────────────────────────

let llmMockFn: (opts: any) => Promise<any> = async () => ({
  text: '[]',
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  stop_reason: 'end_turn',
})

mock.module('../../src/paper/llm-client', () => ({
  chatCompletion: async (opts: any) => llmMockFn(opts),
  loadModelAssignments: () => ({}),
}))

// Import AFTER mock
const { PageChecker } = await import('../../src/paper/writing/page-checker')

// ── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  llmMockFn = async () => ({
    text: '[]',
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    stop_reason: 'end_turn',
  })
})

afterEach(() => {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
})

// ── Helper ──────────────────────────────────────────────────

function makeConstraints(mainBody: number): VenueConstraints {
  return {
    page_limits: {
      main_body: mainBody,
      references: 'unlimited',
      appendix: 'unlimited',
    },
    structure: {
      required_sections: [],
      optional_sections: [],
      abstract_word_limit: 250,
    },
    formatting: { columns: 2, font_size: '10pt' },
    writing_guidelines: {
      main_body_strategy: 'concise',
      page_budget: {},
    },
    common_pitfalls: [],
  }
}

function loremWords(n: number): string {
  const words =
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris'.split(
      ' ',
    )
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push(words[i % words.length]!)
  }
  return out.join(' ')
}

// ── suggestCuts with LLM mock ───────────────────────────────

describe('suggestCuts — with LLM mock', () => {
  test('returns structured CutSuggestion array', async () => {
    const sectionsDir = join(TMP, 'sections')
    mkdirSync(sectionsDir, { recursive: true })
    writeFileSync(join(sectionsDir, 'intro.tex'), loremWords(500), 'utf-8')
    writeFileSync(join(sectionsDir, 'methods.tex'), loremWords(800), 'utf-8')

    const mockCuts: CutSuggestion[] = [
      {
        section: 'intro',
        action: 'tighten prose',
        estimated_savings_words: 100,
        risk_level: 'low',
      },
      {
        section: 'methods',
        action: 'move_to_appendix: detailed proof',
        estimated_savings_words: 200,
        risk_level: 'medium',
      },
    ]

    llmMockFn = async () => ({
      text: JSON.stringify(mockCuts),
      input_tokens: 100,
      output_tokens: 200,
      cost_usd: 0.01,
      stop_reason: 'end_turn',
    })

    const checker = new PageChecker('test-model')
    const result = await checker.suggestCuts(TMP, 2, makeConstraints(8))

    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(2)
    expect(result[0].section).toBe('intro')
    expect(result[1].risk_level).toBe('medium')
  })

  test('returns empty array when LLM returns invalid JSON', async () => {
    const sectionsDir = join(TMP, 'sections')
    mkdirSync(sectionsDir, { recursive: true })
    writeFileSync(join(sectionsDir, 'intro.tex'), loremWords(500), 'utf-8')

    llmMockFn = async () => ({
      text: 'this is not valid JSON at all',
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.01,
      stop_reason: 'end_turn',
    })

    const checker = new PageChecker('test-model')
    const result = await checker.suggestCuts(TMP, 1, makeConstraints(8))
    expect(result).toEqual([])
  })

  test('returns empty array when LLM throws', async () => {
    const sectionsDir = join(TMP, 'sections')
    mkdirSync(sectionsDir, { recursive: true })
    writeFileSync(join(sectionsDir, 'intro.tex'), loremWords(500), 'utf-8')

    llmMockFn = async () => {
      throw new Error('API error')
    }

    const checker = new PageChecker('test-model')
    const result = await checker.suggestCuts(TMP, 1, makeConstraints(8))
    expect(result).toEqual([])
  })
})

// ── applyCuts — compress action ─────────────────────────────

describe('applyCuts — compress action', () => {
  test('compress action rewrites section via LLM', async () => {
    const sectionsDir = join(TMP, 'sections')
    mkdirSync(sectionsDir, { recursive: true })
    const originalText = loremWords(500)
    writeFileSync(join(sectionsDir, 'intro.tex'), originalText, 'utf-8')

    const shorterText = loremWords(350)
    llmMockFn = async () => ({
      text: shorterText,
      input_tokens: 500,
      output_tokens: 350,
      cost_usd: 0.02,
      stop_reason: 'end_turn',
    })

    const checker = new PageChecker('test-model')
    const result = await checker.applyCuts(
      TMP,
      [
        {
          section: 'intro',
          action: 'compress: tighten prose',
          estimated_savings_words: 150,
          risk_level: 'low',
        },
      ],
      makeConstraints(8),
    )

    expect(result.applied).toBe(1)
    expect(result.wordsSaved).toBeGreaterThan(0)

    const written = readFileSync(join(sectionsDir, 'intro.tex'), 'utf-8')
    expect(written).toBe(shorterText)
  })

  test('move_to_appendix creates appendix file and updates main.tex', async () => {
    const sectionsDir = join(TMP, 'sections')
    mkdirSync(sectionsDir, { recursive: true })
    const originalContent =
      'This section has detailed ablation tables with comprehensive results across all benchmark datasets and additional analysis of variance across multiple experimental runs and hyperparameter configurations.'
    writeFileSync(
      join(sectionsDir, 'experiments.tex'),
      originalContent,
      'utf-8',
    )
    // Create main.tex
    writeFileSync(
      join(TMP, 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\n\\input{sections/experiments}\n\\end{document}\n',
    )

    // Mock LLM to return split content — remaining is shorter than original
    llmMockFn = async () => ({
      text: JSON.stringify({
        remaining:
          'This section has main results. See Appendix~\\ref{app:experiments} for details.',
        extracted:
          'Detailed ablation tables with comprehensive results across all benchmark datasets and additional analysis.',
      }),
      input_tokens: 100,
      output_tokens: 200,
      cost_usd: 0.01,
      stop_reason: 'end_turn',
    })

    const checker = new PageChecker('test-model')
    const result = await checker.applyCuts(
      TMP,
      [
        {
          section: 'experiments',
          action: 'move_to_appendix: detailed ablation tables',
          estimated_savings_words: 50,
          risk_level: 'low',
        },
      ],
      null,
    )

    expect(result.applied).toBe(1)
    expect(result.wordsSaved).toBeGreaterThan(0)

    // Verify original section was updated with back-reference
    const remaining = readFileSync(
      join(sectionsDir, 'experiments.tex'),
      'utf-8',
    )
    expect(remaining).toContain('Appendix')
    expect(remaining).not.toContain(
      'Detailed ablation tables with comprehensive',
    )

    // Verify appendix file was created
    const appendixFile = join(sectionsDir, 'appendix-experiments.tex')
    expect(existsSync(appendixFile)).toBe(true)
    const appendixContent = readFileSync(appendixFile, 'utf-8')
    expect(appendixContent).toContain(
      'Detailed ablation tables with comprehensive',
    )
    expect(appendixContent).toContain('\\label{app:experiments}')

    // Verify main.tex has \appendix and \input{sections/appendix-experiments}
    const mainTex = readFileSync(join(TMP, 'main.tex'), 'utf-8')
    expect(mainTex).toContain('\\appendix')
    expect(mainTex).toContain('\\input{sections/appendix-experiments}')
  })

  test('move_to_appendix LLM failure falls back gracefully', async () => {
    const sectionsDir = join(TMP, 'sections')
    mkdirSync(sectionsDir, { recursive: true })
    const originalContent = 'Original content stays unchanged.'
    writeFileSync(
      join(sectionsDir, 'experiments.tex'),
      originalContent,
      'utf-8',
    )

    // Mock LLM to return invalid JSON
    llmMockFn = async () => ({
      text: 'not valid json',
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.01,
      stop_reason: 'end_turn',
    })

    const checker = new PageChecker('test-model')
    const result = await checker.applyCuts(
      TMP,
      [
        {
          section: 'experiments',
          action: 'move_to_appendix: ablation tables',
          estimated_savings_words: 100,
          risk_level: 'low',
        },
      ],
      null,
    )

    // Should skip gracefully — no applied, no crash
    expect(result.applied).toBe(0)
    expect(result.wordsSaved).toBe(0)

    // Original content unchanged
    const content = readFileSync(join(sectionsDir, 'experiments.tex'), 'utf-8')
    expect(content).toBe(originalContent)
  })

  test('caps at 2 compression rounds per section', async () => {
    const sectionsDir = join(TMP, 'sections')
    mkdirSync(sectionsDir, { recursive: true })
    writeFileSync(join(sectionsDir, 'intro.tex'), loremWords(500), 'utf-8')

    let callCount = 0
    llmMockFn = async () => {
      callCount++
      // Each compression removes some words
      return {
        text: loremWords(500 - callCount * 50),
        input_tokens: 100,
        output_tokens: 100,
        cost_usd: 0.01,
        stop_reason: 'end_turn',
      }
    }

    const checker = new PageChecker('test-model')
    const result = await checker.applyCuts(
      TMP,
      [
        {
          section: 'intro',
          action: 'compress: first pass',
          estimated_savings_words: 50,
          risk_level: 'low',
        },
        {
          section: 'intro',
          action: 'compress: second pass',
          estimated_savings_words: 50,
          risk_level: 'low',
        },
        {
          section: 'intro',
          action: 'compress: third pass (should be skipped)',
          estimated_savings_words: 50,
          risk_level: 'low',
        },
      ],
      makeConstraints(8),
    )

    // Only 2 compression rounds should be applied (third skipped)
    expect(result.applied).toBeLessThanOrEqual(2)
  })
})
