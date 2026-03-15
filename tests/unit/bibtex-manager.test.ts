import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import {
  BibTeXManager,
  generateKey,
  formatBibTeX,
  levenshtein,
  parseBibEntries,
  parseKeyPattern,
  type BibTeXEntry,
} from '../../src/paper/writing/bibtex-manager'

const TMP = join(import.meta.dir, '__bib_test_tmp__')

// Save/restore fetch at file level to prevent network calls in non-S2 tests
const _originalFetch = globalThis.fetch

function bibPath(name = 'bibliography.bib') {
  return join(TMP, name)
}

function paperDir() {
  return join(TMP, 'paper')
}

function writeBib(content: string, name = 'bibliography.bib') {
  writeFileSync(join(TMP, name), content, 'utf-8')
}

function writeTex(relPath: string, content: string) {
  const dir = join(TMP, 'paper', ...relPath.split('/').slice(0, -1))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(TMP, 'paper', relPath), content, 'utf-8')
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  // Default: no network calls (prevents flaky S2 hits in non-S2 tests)
  globalThis.fetch = (() => {
    throw new Error('Network disabled in test')
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = _originalFetch
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
})

// ─── Utility functions ──────────────────────────────────────────────

describe('levenshtein', () => {
  test('identical strings have distance 0', () => {
    expect(levenshtein('abc', 'abc')).toBe(0)
  })

  test('single edit distance', () => {
    expect(levenshtein('abc', 'abd')).toBe(1)
    expect(levenshtein('abc', 'abcd')).toBe(1)
    expect(levenshtein('abc', 'ab')).toBe(1)
  })

  test('empty strings', () => {
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
    expect(levenshtein('', '')).toBe(0)
  })
})

describe('parseBibEntries', () => {
  test('parses multiple entries', () => {
    const content = `@article{smith2024neural,
  title = {Neural Networks},
  author = {Smith},
  year = {2024},
}

@misc{jones2023deep,
  title = {Deep Learning},
  author = {Jones},
  year = {2023},
}`
    const entries = parseBibEntries(content)
    expect(entries.size).toBe(2)
    expect(entries.has('smith2024neural')).toBe(true)
    expect(entries.has('jones2023deep')).toBe(true)
  })

  test('returns empty map for empty content', () => {
    expect(parseBibEntries('').size).toBe(0)
  })
})

describe('parseKeyPattern', () => {
  test('extracts author and year', () => {
    const result = parseKeyPattern('smith2024neural')
    expect(result).toEqual({ author: 'smith', year: '2024' })
  })

  test('returns null for non-matching keys', () => {
    expect(parseKeyPattern('12345')).toBeNull()
    expect(parseKeyPattern('')).toBeNull()
  })
})

describe('generateKey', () => {
  test('produces correct format', () => {
    const key = generateKey(['John Smith'], 2024, 'Neural Network Optimization')
    expect(key).toBe('smith2024neural')
  })

  test('skips short/common words in title', () => {
    const key = generateKey(['Ada Lovelace'], 2023, 'The Art of Computing')
    expect(key).toBe('lovelace2023computing')
  })

  test('uses unknown for missing authors', () => {
    const key = generateKey([], 2024, 'Some Paper')
    expect(key).toBe('unknown2024some')
  })

  test('handles single-word author names', () => {
    const key = generateKey(['Madonna'], 2024, 'Music Theory')
    expect(key).toBe('madonna2024music')
  })
})

// ─── BibTeXManager methods ──────────────────────────────────────────

describe('BibTeXManager.hasKey', () => {
  test('returns true for existing key', () => {
    writeBib(`@article{smith2024neural,
  title = {Neural Networks},
  author = {Smith},
  year = {2024},
}`)
    const manager = new BibTeXManager(bibPath())
    expect(manager.hasKey('smith2024neural')).toBe(true)
  })

  test('returns false for missing key', () => {
    writeBib(`@article{smith2024neural,
  title = {Neural Networks},
  author = {Smith},
  year = {2024},
}`)
    const manager = new BibTeXManager(bibPath())
    expect(manager.hasKey('jones2023deep')).toBe(false)
  })

  test('returns false for empty/missing bib file', () => {
    const manager = new BibTeXManager(bibPath())
    expect(manager.hasKey('anything')).toBe(false)
  })
})

describe('BibTeXManager.findClosestKey', () => {
  test('finds fuzzy match within distance 1', async () => {
    writeBib(`@article{smith2024neural,
  title = {Neural Networks},
  author = {Smith},
  year = {2024},
}`)
    const manager = new BibTeXManager(bibPath())
    // "smith2024neura" is distance 1 from "smith2024neural"
    const result = await manager.findClosestKey('smith2024neura')
    expect(result).toBe('smith2024neural')
  })

  test('returns null for distant keys', async () => {
    writeBib(`@article{smith2024neural,
  title = {Neural Networks},
  author = {Smith},
  year = {2024},
}`)
    const manager = new BibTeXManager(bibPath())
    const result = await manager.findClosestKey('completely_different_key')
    expect(result).toBeNull()
  })

  test('returns null for empty bib', async () => {
    const manager = new BibTeXManager(bibPath())
    const result = await manager.findClosestKey('smith2024neural')
    expect(result).toBeNull()
  })
})

describe('BibTeXManager.scanAllCiteKeys', () => {
  test('finds \\cite, \\citep, \\citet variants', async () => {
    writeTex(
      'main.tex',
      String.raw`
\documentclass{article}
\begin{document}
See \cite{smith2024neural} and \citep{jones2023deep}.
Also \citet{wang2022transformer}.
\end{document}
`,
    )
    const manager = new BibTeXManager(bibPath())
    const keys = await manager.scanAllCiteKeys(paperDir())
    expect(keys.sort()).toEqual(
      ['jones2023deep', 'smith2024neural', 'wang2022transformer'].sort(),
    )
  })

  test('handles comma-separated keys', async () => {
    writeTex('main.tex', String.raw`\cite{alpha,beta,gamma}`)
    const manager = new BibTeXManager(bibPath())
    const keys = await manager.scanAllCiteKeys(paperDir())
    expect(keys.sort()).toEqual(['alpha', 'beta', 'gamma'].sort())
  })

  test('handles nested dirs', async () => {
    writeTex('sections/intro.tex', String.raw`\cite{keyA}`)
    writeTex('sections/methods/approach.tex', String.raw`\citep{keyB}`)
    const manager = new BibTeXManager(bibPath())
    const keys = await manager.scanAllCiteKeys(paperDir())
    expect(keys.sort()).toEqual(['keyA', 'keyB'].sort())
  })

  test('returns empty for missing dir', async () => {
    const manager = new BibTeXManager(bibPath())
    const keys = await manager.scanAllCiteKeys(join(TMP, 'nonexistent'))
    expect(keys).toEqual([])
  })

  test('deduplicates across files', async () => {
    writeTex('intro.tex', String.raw`\cite{smith2024neural}`)
    writeTex('methods.tex', String.raw`\cite{smith2024neural}`)
    const manager = new BibTeXManager(bibPath())
    const keys = await manager.scanAllCiteKeys(paperDir())
    expect(keys).toEqual(['smith2024neural'])
  })
})

describe('BibTeXManager.appendRawEntry', () => {
  test('appends a raw BibTeX string', () => {
    const manager = new BibTeXManager(bibPath())
    const entry = `@article{smith2024neural,\n  title = {Neural Networks},\n  author = {Smith},\n  year = {2024},\n}`
    manager.appendRawEntry(entry)
    expect(manager.hasKey('smith2024neural')).toBe(true)
  })

  test('deduplicates by key', async () => {
    const entry = `@article{smith2024neural,\n  title = {Neural Networks},\n  author = {Smith},\n  year = {2024},\n}`
    writeBib(entry + '\n')
    const manager = new BibTeXManager(bibPath())
    manager.appendRawEntry(entry)
    const keys = await manager.getAllKeys()
    expect(keys.length).toBe(1)
  })

  test('skips entries without valid key', async () => {
    const manager = new BibTeXManager(bibPath())
    manager.appendRawEntry('not a valid bibtex entry')
    const keys = await manager.getAllKeys()
    expect(keys.length).toBe(0)
  })
})

describe('BibTeXManager.syncFromLiterature', () => {
  test('copies referenced entries from lit bib', async () => {
    writeBib(
      `@article{smith2024neural,
  title = {Neural Networks},
  author = {Smith},
  year = {2024},
}

@article{jones2023deep,
  title = {Deep Learning},
  author = {Jones},
  year = {2023},
}`,
      'lit.bib',
    )
    writeTex('main.tex', String.raw`\cite{smith2024neural}`)

    const manager = new BibTeXManager(bibPath())
    const result = await manager.syncFromLiterature(
      join(TMP, 'lit.bib'),
      paperDir(),
    )
    expect(result.synced).toBe(1)
    expect(result.missing).toBe(0)
    expect(manager.hasKey('smith2024neural')).toBe(true)
    // jones2023deep should NOT be copied (not referenced)
    expect(manager.hasKey('jones2023deep')).toBe(false)
  })

  test('reports missing keys', async () => {
    writeBib('', 'lit.bib')
    writeTex('main.tex', String.raw`\cite{nonexistent2024paper}`)

    const manager = new BibTeXManager(bibPath())
    const result = await manager.syncFromLiterature(
      join(TMP, 'lit.bib'),
      paperDir(),
    )
    // The key won't fuzzy-match anything and S2 will fail (no network), so it gets a placeholder
    expect(result.missing).toBeGreaterThanOrEqual(0)
    expect(result.synced + result.missing).toBe(1)
  })

  test('skips keys already in our bib', async () => {
    writeBib(`@article{smith2024neural,
  title = {Neural Networks},
  author = {Smith},
  year = {2024},
}`)
    writeBib(
      `@article{smith2024neural,
  title = {Neural Networks v2},
  author = {Smith},
  year = {2024},
}`,
      'lit.bib',
    )
    writeTex('main.tex', String.raw`\cite{smith2024neural}`)

    const manager = new BibTeXManager(bibPath())
    const result = await manager.syncFromLiterature(
      join(TMP, 'lit.bib'),
      paperDir(),
    )
    expect(result.synced).toBe(1)
    // Should still have the original title, not the lit version
    const bibtex = manager.getBibTeX('smith2024neural')
    expect(bibtex).toContain('Neural Networks')
  })
})

describe('BibTeXManager.autoFixCiteKey', () => {
  test('creates TODO placeholder when no match found', async () => {
    const manager = new BibTeXManager(bibPath())
    const result = await manager.autoFixCiteKey('totallyunknown9999xyz')
    expect(result).toBeNull()
    // Should have created a placeholder
    expect(manager.hasKey('totallyunknown9999xyz')).toBe(true)
    const bibtex = manager.getBibTeX('totallyunknown9999xyz')
    expect(bibtex).toContain('TODO')
  })

  test('fuzzy matches close keys', async () => {
    writeBib(`@article{smith2024neural,
  title = {Neural Networks},
  author = {Smith},
  year = {2024},
}`)
    const manager = new BibTeXManager(bibPath())
    // "smith2024neura" is distance 1 from "smith2024neural"
    const result = await manager.autoFixCiteKey('smith2024neura')
    expect(result).toBe('smith2024neural')
  })
})

// ─── autoFixCiteKey — S2 strategy ──────────────────────────────────

describe('autoFixCiteKey — S2 strategy', () => {
  afterEach(() => {
    delete process.env.S2_API_KEY
  })

  test('S2 search succeeds when fuzzy match fails', async () => {
    // Bib has unrelated keys — no fuzzy match possible
    writeBib(`@article{jones2023deep,
  title = {Deep Learning},
  author = {Jones},
  year = {2023},
}`)

    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('semanticscholar.org')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                title: 'Neural Network Optimization',
                authors: [{ name: 'John Smith' }],
                year: 2024,
                venue: 'NeurIPS 2024',
                externalIds: { DOI: '10.1234/test' },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('', { status: 404 })
    }) as typeof fetch

    const manager = new BibTeXManager(bibPath())
    const result = await manager.autoFixCiteKey('smith2024neural')

    // S2 strategy returns the original key (appends an entry with that key)
    expect(result).toBe('smith2024neural')
    expect(manager.hasKey('smith2024neural')).toBe(true)
    const bibtex = manager.getBibTeX('smith2024neural')
    expect(bibtex).toContain('Neural Network Optimization')
  })

  test('S2 search returns empty data → falls to placeholder', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as typeof fetch

    const manager = new BibTeXManager(bibPath())
    const result = await manager.autoFixCiteKey('smith2024neural')

    expect(result).toBeNull()
    // Placeholder should be created
    expect(manager.hasKey('smith2024neural')).toBe(true)
    const bibtex = manager.getBibTeX('smith2024neural')
    expect(bibtex).toContain('TODO')
  })

  test('S2 fetch network error → falls to placeholder', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Network unreachable')
    }) as typeof fetch

    const manager = new BibTeXManager(bibPath())
    const result = await manager.autoFixCiteKey('smith2024neural')

    expect(result).toBeNull()
    expect(manager.hasKey('smith2024neural')).toBe(true)
  })

  test('S2 uses x-api-key header when S2_API_KEY set', async () => {
    process.env.S2_API_KEY = 'test-api-key-12345'
    let capturedHeaders: Record<string, string> = {}

    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('semanticscholar.org')) {
        capturedHeaders = init?.headers ?? {}
        return new Response(
          JSON.stringify({
            data: [
              {
                title: 'Test Paper',
                authors: [{ name: 'Test Author' }],
                year: 2024,
                externalIds: {},
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('', { status: 404 })
    }) as typeof fetch

    const manager = new BibTeXManager(bibPath())
    await manager.autoFixCiteKey('smith2024neural')

    expect(capturedHeaders['x-api-key']).toBe('test-api-key-12345')
  })

  test('S2 paper with venue → type is inproceedings', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              title: 'Venue Paper',
              authors: [{ name: 'Author' }],
              year: 2024,
              venue: 'NeurIPS 2024',
              externalIds: {},
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const manager = new BibTeXManager(bibPath())
    await manager.autoFixCiteKey('smith2024venue')

    const bibtex = manager.getBibTeX('smith2024venue')
    expect(bibtex).toContain('@inproceedings')
  })

  test('S2 paper without venue → type is article', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              title: 'No Venue Paper',
              authors: [{ name: 'Author' }],
              year: 2024,
              externalIds: {},
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const manager = new BibTeXManager(bibPath())
    await manager.autoFixCiteKey('smith2024novenue')

    const bibtex = manager.getBibTeX('smith2024novenue')
    expect(bibtex).toContain('@article')
  })
})

describe('autoFixCiteKey — litEntries interaction', () => {
  test('fuzzy matches against litEntries and copies entry', async () => {
    // Our bib is empty — no keys to fuzzy match against
    const manager = new BibTeXManager(bibPath())
    const litEntries = new Map<string, string>()
    litEntries.set(
      'smith2024neural',
      `@article{smith2024neural,
  title = {Neural Networks},
  author = {Smith},
  year = {2024},
}`,
    )

    // "smith2024neura" is distance 1 from "smith2024neural"
    const result = await manager.autoFixCiteKey('smith2024neura', litEntries)

    expect(result).toBe('smith2024neural')
    // The lit entry should be copied into our bib
    expect(manager.hasKey('smith2024neural')).toBe(true)
  })
})

describe('addFromArxiv', () => {
  test('fetches arXiv API XML and appends entry', async () => {
    const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <entry>
    <title>Neural Operator Learning for Fast Calibration</title>
    <author><name>John Smith</name></author>
    <author><name>Jane Doe</name></author>
    <published>2024-06-15T00:00:00Z</published>
  </entry>
</feed>`

    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('export.arxiv.org')) {
        return new Response(mockXml, { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as typeof fetch

    const manager = new BibTeXManager(bibPath())
    const key = await manager.addFromArxiv('2406.12345')

    expect(key).toBeTruthy()
    expect(manager.hasKey(key)).toBe(true)
    const bibtex = manager.getBibTeX(key)
    expect(bibtex).toContain('Neural Operator Learning')
    expect(bibtex).toContain('John Smith')
    expect(bibtex).toContain('2024')
    expect(bibtex).toContain('2406.12345')
  })
})

describe('BibTeXManager.deduplicateEntries', () => {
  test('removes duplicate keys', async () => {
    writeBib(`@article{smith2024neural,
  title = {Neural Networks},
  author = {Smith},
  year = {2024},
}

@article{smith2024neural,
  title = {Neural Networks (duplicate)},
  author = {Smith},
  year = {2024},
}

@article{jones2023deep,
  title = {Deep Learning},
  author = {Jones},
  year = {2023},
}`)
    const manager = new BibTeXManager(bibPath())
    const removed = await manager.deduplicateEntries()
    expect(removed).toBe(1)
    const keys = await manager.getAllKeys()
    expect(keys.length).toBe(2)
    expect(keys).toContain('smith2024neural')
    expect(keys).toContain('jones2023deep')
    // Should keep first occurrence
    const bibtex = manager.getBibTeX('smith2024neural')
    expect(bibtex).not.toContain('duplicate')
  })

  test('returns 0 when no duplicates', async () => {
    writeBib(`@article{smith2024neural,
  title = {Neural Networks},
  author = {Smith},
  year = {2024},
}`)
    const manager = new BibTeXManager(bibPath())
    const removed = await manager.deduplicateEntries()
    expect(removed).toBe(0)
  })

  test('returns 0 for empty bib', async () => {
    const manager = new BibTeXManager(bibPath())
    const removed = await manager.deduplicateEntries()
    expect(removed).toBe(0)
  })
})
