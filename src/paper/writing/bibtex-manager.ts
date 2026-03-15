import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'

export interface BibTeXEntry {
  key: string
  type: 'article' | 'inproceedings' | 'misc' | 'techreport'
  title: string
  authors: string[]
  year: number
  journal?: string
  booktitle?: string
  url?: string
  doi?: string
  arxiv_id?: string
}

export interface SyncResult {
  synced: number
  missing: number
  fixed: string[] // e.g., ["oldKey -> correctedKey"]
}

function sanitizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20)
}

export function generateKey(
  authors: string[],
  year: number,
  title: string,
): string {
  const firstAuthor = authors[0] ?? 'unknown'
  // Extract last name: take the last token when split by space
  const parts = firstAuthor.trim().split(/\s+/)
  const lastName = parts[parts.length - 1] ?? firstAuthor
  const cleanLast = sanitizeKey(lastName)

  const firstWord =
    title
      .split(/\s+/)
      .find(
        w =>
          w.length > 3 &&
          !/^(the|and|for|with|from|that|this|are|was)$/i.test(w),
      ) ??
    title.split(/\s+/)[0] ??
    'paper'
  const cleanWord = sanitizeKey(firstWord)

  return `${cleanLast}${year}${cleanWord}`
}

export function formatBibTeX(entry: BibTeXEntry): string {
  const lines: string[] = []
  lines.push(`@${entry.type}{${entry.key},`)
  lines.push(`  title     = {${entry.title}},`)
  lines.push(`  author    = {${entry.authors.join(' and ')}},`)
  lines.push(`  year      = {${entry.year}},`)
  if (entry.journal) lines.push(`  journal   = {${entry.journal}},`)
  if (entry.booktitle) lines.push(`  booktitle = {${entry.booktitle}},`)
  if (entry.doi) lines.push(`  doi       = {${entry.doi}},`)
  if (entry.arxiv_id) lines.push(`  eprint    = {${entry.arxiv_id}},`)
  if (entry.url) lines.push(`  url       = {${entry.url}},`)
  lines.push('}')
  return lines.join('\n')
}

/** Standard Levenshtein edit distance (DP). */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  )
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      )
    }
  }
  return dp[m][n]
}

/** Parse a .bib file into a Map<key, rawEntryText>. */
export function parseBibEntries(content: string): Map<string, string> {
  const entries = new Map<string, string>()
  const pattern = /@(\w+)\{([^,\s]+),[\s\S]*?\n\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    const key = match[2]?.trim()
    if (key) {
      entries.set(key, match[0])
    }
  }
  return entries
}

/** Extract author + year from keys like "smith2024neural". */
export function parseKeyPattern(
  key: string,
): { author: string; year: string } | null {
  const m = key.match(/^([a-z]+)(\d{4})/)
  if (!m) return null
  return { author: m[1], year: m[2] }
}

export class BibTeXManager {
  private bibPath: string

  constructor(bibPath: string) {
    this.bibPath = bibPath
  }

  private readBib(): string {
    if (!existsSync(this.bibPath)) return ''
    return readFileSync(this.bibPath, 'utf-8')
  }

  private writeBib(content: string): void {
    writeFileSync(this.bibPath, content, 'utf-8')
  }

  private appendEntry(entry: BibTeXEntry): string {
    const bibtex = formatBibTeX(entry)
    const existing = this.readBib()
    const separator = existing.endsWith('\n') || existing === '' ? '' : '\n'
    this.writeBib(existing + separator + bibtex + '\n')
    return entry.key
  }

  async addFromArxiv(arxivId: string): Promise<string> {
    const url = `https://export.arxiv.org/api/query?id_list=${arxivId}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `arXiv API request failed: ${response.status} ${response.statusText}`,
      )
    }
    const xml = await response.text()

    // Parse title
    const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/)
    // First <title> is feed title; second is the paper title
    const titleMatches = [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)]
    const rawTitle =
      titleMatches.length >= 2
        ? titleMatches[1][1].trim()
        : (titleMatch?.[1]?.trim() ?? 'Unknown Title')
    const title = rawTitle.replace(/\s+/g, ' ')

    // Parse authors
    const authorMatches = [...xml.matchAll(/<name>([\s\S]*?)<\/name>/g)]
    const authors = authorMatches.map(m => m[1].trim()).filter(Boolean)

    // Parse year from published date
    const publishedMatch = xml.match(/<published>([\s\S]*?)<\/published>/)
    const publishedStr = publishedMatch?.[1]?.trim() ?? ''
    const year = publishedStr
      ? parseInt(publishedStr.slice(0, 4), 10)
      : new Date().getFullYear()

    const key = generateKey(
      authors.length > 0 ? authors : ['unknown'],
      year,
      title,
    )

    const entry: BibTeXEntry = {
      key,
      type: 'misc',
      title,
      authors: authors.length > 0 ? authors : ['Unknown'],
      year,
      arxiv_id: arxivId,
      url: `https://arxiv.org/abs/${arxivId}`,
    }

    return this.appendEntry(entry)
  }

  async addFromS2(s2PaperId: string): Promise<string> {
    const url = `https://api.semanticscholar.org/graph/v1/paper/${s2PaperId}?fields=title,authors,year,externalIds,venue`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `Semantic Scholar API request failed: ${response.status} ${response.statusText}`,
      )
    }
    const data = (await response.json()) as {
      title?: string
      authors?: Array<{ name: string }>
      year?: number
      externalIds?: { DOI?: string; ArXiv?: string }
      venue?: string
    }

    const title = data.title ?? 'Unknown Title'
    const authors = (data.authors ?? []).map(a => a.name).filter(Boolean)
    const year = data.year ?? new Date().getFullYear()
    const doi = data.externalIds?.DOI
    const arxivId = data.externalIds?.ArXiv
    const venue = data.venue

    const key = generateKey(
      authors.length > 0 ? authors : ['unknown'],
      year,
      title,
    )

    const entry: BibTeXEntry = {
      key,
      type: venue ? 'inproceedings' : 'misc',
      title,
      authors: authors.length > 0 ? authors : ['Unknown'],
      year,
      booktitle: venue || undefined,
      doi: doi || undefined,
      arxiv_id: arxivId || undefined,
      url: arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined,
    }

    return this.appendEntry(entry)
  }

  async addEntry(entry: BibTeXEntry): Promise<string> {
    return this.appendEntry(entry)
  }

  getBibTeX(key: string): string | null {
    const content = this.readBib()
    if (!content) return null

    // Match the entry block starting with @type{key,
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`@\\w+\\{${escapedKey},[\\s\\S]*?\\n\\}`, 'g')
    const match = pattern.exec(content)
    return match ? match[0] : null
  }

  async getAllKeys(): Promise<string[]> {
    const content = this.readBib()
    if (!content) return []

    const keys: string[] = []
    const pattern = /@\w+\{([^,]+),/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      const k = match[1]?.trim()
      if (k) keys.push(k)
    }
    return keys
  }

  /** Synchronous check if a key exists in the bib file. */
  hasKey(key: string): boolean {
    const content = this.readBib()
    if (!content) return false
    const pattern = /@\w+\{([^,]+),/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]?.trim() === key) return true
    }
    return false
  }

  /** Find the closest existing key by Levenshtein distance. */
  async findClosestKey(
    key: string,
    maxDist: number = 3,
  ): Promise<string | null> {
    const allKeys = await this.getAllKeys()
    let bestKey: string | null = null
    let bestDist = maxDist + 1
    for (const candidate of allKeys) {
      const dist = levenshtein(key.toLowerCase(), candidate.toLowerCase())
      if (dist < bestDist) {
        bestDist = dist
        bestKey = candidate
      }
    }
    return bestDist <= maxDist ? bestKey : null
  }

  /** Recursively scan .tex files in paperDir for all \\cite variants. */
  async scanAllCiteKeys(paperDir: string): Promise<string[]> {
    if (!existsSync(paperDir)) return []
    const keys = new Set<string>()
    let files: string[]
    try {
      files = (
        readdirSync(paperDir, { recursive: true }) as unknown as string[]
      ).filter(f => f.endsWith('.tex'))
    } catch {
      return []
    }
    const citePattern = /\\(?:cite|citep|citet|citeauthor|citeyear)\{([^}]+)\}/g
    for (const relPath of files) {
      const fullPath = join(paperDir, relPath)
      try {
        const content = readFileSync(fullPath, 'utf-8')
        let match: RegExpExecArray | null
        while ((match = citePattern.exec(content)) !== null) {
          const keyList = match[1]
          if (keyList) {
            for (const k of keyList.split(',')) {
              const trimmed = k.trim()
              if (trimmed) keys.add(trimmed)
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
    return [...keys]
  }

  /** Append a pre-formatted BibTeX string, deduplicating by key. */
  appendRawEntry(bibtex: string): void {
    // Extract key from the raw bibtex
    const keyMatch = bibtex.match(/@\w+\{([^,\s]+),/)
    if (!keyMatch?.[1]) return
    const key = keyMatch[1].trim()

    if (this.hasKey(key)) return

    const existing = this.readBib()
    const separator = existing.endsWith('\n') || existing === '' ? '' : '\n'
    this.writeBib(existing + separator + bibtex + '\n')
  }

  /**
   * Auto-fix a missing cite key using a 3-strategy chain:
   * 1. Fuzzy match against known keys
   * 2. S2 search by parsed author+year
   * 3. TODO placeholder
   * Returns the corrected key, or null if only a placeholder was added.
   */
  async autoFixCiteKey(
    key: string,
    litEntries?: Map<string, string>,
  ): Promise<string | null> {
    // Strategy 1: Fuzzy match against our bib + lit entries
    const ourKeys = await this.getAllKeys()
    const allCandidates = [...ourKeys]
    if (litEntries) {
      for (const litKey of litEntries.keys()) {
        if (!allCandidates.includes(litKey)) allCandidates.push(litKey)
      }
    }

    let bestKey: string | null = null
    let bestDist = 4 // threshold is <=3
    for (const candidate of allCandidates) {
      const dist = levenshtein(key.toLowerCase(), candidate.toLowerCase())
      if (dist < bestDist) {
        bestDist = dist
        bestKey = candidate
      }
    }
    if (bestKey && bestDist <= 3) {
      // If the match is from lit entries and not in our bib, copy it over
      if (!this.hasKey(bestKey) && litEntries?.has(bestKey)) {
        this.appendRawEntry(litEntries.get(bestKey)!)
      }
      return bestKey
    }

    // Strategy 2: S2 search by parsed author+year
    const parsed = parseKeyPattern(key)
    if (parsed) {
      try {
        const query = `${parsed.author} ${parsed.year}`
        const headers: Record<string, string> = {}
        const s2Key = process.env.S2_API_KEY
        if (s2Key) headers['x-api-key'] = s2Key
        const resp = await fetch(
          `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=1&fields=title,authors,year,externalIds,venue`,
          { headers },
        )
        if (resp.ok) {
          const data = (await resp.json()) as {
            data?: Array<{
              title?: string
              authors?: Array<{ name: string }>
              year?: number
              externalIds?: { DOI?: string; ArXiv?: string }
              venue?: string
            }>
          }
          const paper = data.data?.[0]
          if (paper?.title) {
            const authors = (paper.authors ?? [])
              .map(a => a.name)
              .filter(Boolean)
            const entry: BibTeXEntry = {
              key,
              type: paper.venue ? 'inproceedings' : 'article',
              title: paper.title,
              authors: authors.length > 0 ? authors : ['Unknown'],
              year: paper.year ?? parseInt(parsed.year, 10),
              booktitle: paper.venue || undefined,
              doi: paper.externalIds?.DOI || undefined,
              arxiv_id: paper.externalIds?.ArXiv || undefined,
            }
            this.appendEntry(entry)
            return key
          }
        }
      } catch {
        // S2 search failed — fall through to placeholder
      }
    }

    // Strategy 3: TODO placeholder
    const placeholder = `@misc{${key},\n  title = {TODO: Find reference for ${key}},\n  author = {Unknown},\n  year = {0},\n  note = {Auto-generated placeholder}\n}`
    this.appendRawEntry(placeholder)
    return null
  }

  /**
   * Sync bibliography from a literature bib file.
   * Scans .tex files in paperDir for cite keys, copies matching entries
   * from litBibPath, and auto-fixes missing keys.
   */
  async syncFromLiterature(
    litBibPath: string,
    paperDir: string,
  ): Promise<SyncResult> {
    const usedKeys = await this.scanAllCiteKeys(paperDir)
    const litContent = existsSync(litBibPath)
      ? readFileSync(litBibPath, 'utf-8')
      : ''
    const litEntries = parseBibEntries(litContent)

    const result: SyncResult = { synced: 0, missing: 0, fixed: [] }

    for (const key of usedKeys) {
      if (this.hasKey(key)) {
        result.synced++
        continue
      }

      if (litEntries.has(key)) {
        this.appendRawEntry(litEntries.get(key)!)
        result.synced++
        continue
      }

      // Try auto-fix
      const fixedKey = await this.autoFixCiteKey(key, litEntries)
      if (fixedKey) {
        result.fixed.push(`${key} -> ${fixedKey}`)
        result.synced++
      } else {
        result.missing++
      }
    }

    return result
  }

  /** Remove duplicate keys, keeping the first occurrence. */
  async deduplicateEntries(): Promise<number> {
    const content = this.readBib()
    if (!content) return 0

    const seen = new Set<string>()
    const kept: string[] = []
    let removed = 0

    const pattern = /@(\w+)\{([^,\s]+),[\s\S]*?\n\}/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      const key = match[2]?.trim()
      if (!key) continue
      if (seen.has(key)) {
        removed++
      } else {
        seen.add(key)
        kept.push(match[0])
      }
    }

    if (removed > 0) {
      this.writeBib(kept.join('\n\n') + '\n')
    }
    return removed
  }
}
