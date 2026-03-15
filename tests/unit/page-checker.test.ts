import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { PageChecker } from '../../src/paper/writing/page-checker'
import type {
  VenueConstraints,
  PageCheckResult,
} from '../../src/paper/writing/types'

const TMP = join(import.meta.dir, '__page_checker_test_tmp__')

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
})

// ─── getPageCount ───────────────────────────────────────────

describe('getPageCount', () => {
  test('returns 0 for non-existent file', async () => {
    const checker = new PageChecker()
    const count = await checker.getPageCount(join(TMP, 'nonexistent.pdf'))
    expect(count).toBe(0)
  })

  test('extracts page count from /Type /Page markers in PDF bytes', async () => {
    // Create a minimal fake PDF with page markers
    // Real PDFs have these markers for each page
    const fakePdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R >>
endobj
4 0 obj
<< /Type /Page /Parent 2 0 R >>
endobj
5 0 obj
<< /Type /Page /Parent 2 0 R >>
endobj
`
    writeFileSync(join(TMP, 'test.pdf'), fakePdf)

    const checker = new PageChecker()
    const count = await checker.getPageCount(join(TMP, 'test.pdf'))
    expect(count).toBe(3)
  })

  test('does not count /Type /Pages (plural) as page markers', async () => {
    const fakePdf = `%PDF-1.4
1 0 obj
<< /Type /Pages /Kids [2 0 R] /Count 1 >>
endobj
2 0 obj
<< /Type /Page /Parent 1 0 R >>
endobj
`
    writeFileSync(join(TMP, 'single.pdf'), fakePdf)

    const checker = new PageChecker()
    const count = await checker.getPageCount(join(TMP, 'single.pdf'))
    expect(count).toBe(1) // Only /Type /Page, not /Type /Pages
  })
})

// ─── check ──────────────────────────────────────────────────

describe('check', () => {
  function makeFakePdf(pageCount: number): string {
    let pdf = '%PDF-1.4\n'
    for (let i = 0; i < pageCount; i++) {
      pdf += `${i + 1} 0 obj\n<< /Type /Page >>\nendobj\n`
    }
    return pdf
  }

  test('passes when under page limit', async () => {
    writeFileSync(join(TMP, 'ok.pdf'), makeFakePdf(8))
    // Create main.tex with \bibliography near the end
    mkdirSync(join(TMP, 'paper'), { recursive: true })
    // The PDF is at TMP level, so main.tex should be sibling
    writeFileSync(
      join(TMP, 'main.tex'),
      `\\documentclass{article}
\\begin{document}
content
\\bibliography{refs}
\\end{document}
`,
    )

    const checker = new PageChecker()
    const constraints: VenueConstraints = {
      page_limits: {
        main_body: 10,
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

    const result = await checker.check(join(TMP, 'ok.pdf'), constraints)
    expect(result.passed).toBe(true)
    expect(result.totalPages).toBe(8)
    expect(result.overBy).toBe(0)
  })

  test('fails when over page limit', async () => {
    writeFileSync(join(TMP, 'over.pdf'), makeFakePdf(12))

    const checker = new PageChecker()
    const constraints: VenueConstraints = {
      page_limits: {
        main_body: 8,
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

    const result = await checker.check(join(TMP, 'over.pdf'), constraints)
    expect(result.passed).toBe(false)
    expect(result.totalPages).toBe(12)
    expect(result.overBy).toBeGreaterThan(0)
    expect(result.suggestion).toBeDefined()
  })

  test('passes with unlimited limit', async () => {
    writeFileSync(join(TMP, 'any.pdf'), makeFakePdf(50))

    const checker = new PageChecker()
    const result = await checker.check(join(TMP, 'any.pdf'), null)
    expect(result.passed).toBe(true)
    expect(result.limit).toBe('unlimited')
    expect(result.overBy).toBe(0)
  })

  test('passes with constraints that have unlimited main_body', async () => {
    writeFileSync(join(TMP, 'ul.pdf'), makeFakePdf(50))

    const checker = new PageChecker()
    const constraints: VenueConstraints = {
      page_limits: {
        main_body: 'unlimited',
        references: 'unlimited',
        appendix: 'unlimited',
      },
      structure: {
        required_sections: [],
        optional_sections: [],
        abstract_word_limit: 'unlimited',
      },
      formatting: { columns: 1, font_size: '12pt' },
      writing_guidelines: {
        main_body_strategy: 'any',
        page_budget: {},
      },
      common_pitfalls: [],
    }

    const result = await checker.check(join(TMP, 'ul.pdf'), constraints)
    expect(result.passed).toBe(true)
    expect(result.limit).toBe('unlimited')
  })
})

// ─── check — boundary cases ───────────────────────────────────

describe('check — boundary cases', () => {
  function makeFakePdfBoundary(pageCount: number): string {
    let pdf = '%PDF-1.4\n'
    for (let i = 0; i < pageCount; i++) {
      pdf += `${i + 1} 0 obj\n<< /Type /Page >>\nendobj\n`
    }
    return pdf
  }

  function makeNeuripsConstraints(mainBody: number): VenueConstraints {
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

  test('exactly at page limit passes', async () => {
    const pageLimit = 8
    writeFileSync(join(TMP, 'exact.pdf'), makeFakePdfBoundary(pageLimit))

    const checker = new PageChecker()
    const result = await checker.check(
      join(TMP, 'exact.pdf'),
      makeNeuripsConstraints(pageLimit),
    )

    expect(result.passed).toBe(true)
    expect(result.overBy).toBe(0)
    expect(result.totalPages).toBe(pageLimit)
  })

  test('one page over limit', async () => {
    const pageLimit = 8
    writeFileSync(join(TMP, 'over1.pdf'), makeFakePdfBoundary(pageLimit + 1))

    const checker = new PageChecker()
    const result = await checker.check(
      join(TMP, 'over1.pdf'),
      makeNeuripsConstraints(pageLimit),
    )

    expect(result.passed).toBe(false)
    expect(result.overBy).toBeGreaterThan(0)
    expect(result.suggestion).toBeDefined()
  })

  test('estimateMainBodyPages discounts references section', async () => {
    // Create a 10-page PDF where \bibliography appears at line ~60% of file
    writeFileSync(join(TMP, 'withref.pdf'), makeFakePdfBoundary(10))
    writeFileSync(
      join(TMP, 'main.tex'),
      `\\documentclass{article}
\\begin{document}
% line 3
% line 4
% line 5
% line 6
\\bibliography{refs}
% line 8
% line 9
% line 10
\\end{document}
`,
    )

    const checker = new PageChecker()
    const result = await checker.check(
      join(TMP, 'withref.pdf'),
      makeNeuripsConstraints(8),
    )

    // Main body pages should be estimated as less than total pages
    // because \bibliography marker appears at ~60% of the file
    expect(result.mainBodyPages).toBeLessThan(result.totalPages)
  })
})

// ─── suggestCuts ────────────────────────────────────────────

describe('suggestCuts', () => {
  test('returns empty array when not over budget', async () => {
    const checker = new PageChecker()
    const result = await checker.suggestCuts(join(TMP, 'paper'), 0, null)
    expect(result).toEqual([])
  })

  test('returns empty array when sections dir does not exist', async () => {
    const checker = new PageChecker()
    const result = await checker.suggestCuts(join(TMP, 'nonexistent'), 2, null)
    expect(result).toEqual([])
  })
})
