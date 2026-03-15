import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'fs'
import { join } from 'path'
import type { SectionChunk } from './pdf-extractor'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaperMeta {
  title: string
  authors: string[]
  year: number | null
  chunk_count: number
}

export interface IndexMeta {
  papers: Record<string, PaperMeta>
  total_chunks: number
  last_updated: string
}

export interface ScoredChunk extends SectionChunk {
  score: number
  match_terms: string[]
}

// ---------------------------------------------------------------------------
// TF-IDF helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1)
  }
  // Normalize by total tokens
  const total = tokens.length || 1
  for (const [k, v] of tf) {
    tf.set(k, v / total)
  }
  return tf
}

// ---------------------------------------------------------------------------
// ChunkSearchIndex
// ---------------------------------------------------------------------------

export class ChunkSearchIndex {
  private chunksDir: string
  private indexPath: string
  private meta: IndexMeta
  private allChunks: SectionChunk[] | null = null // lazy loaded
  private idfCache: Map<string, number> | null = null

  constructor(literatureDir: string) {
    this.chunksDir = join(literatureDir, 'chunks')
    this.indexPath = join(literatureDir, 'chunk-index.json')
    mkdirSync(this.chunksDir, { recursive: true })

    if (existsSync(this.indexPath)) {
      this.meta = JSON.parse(readFileSync(this.indexPath, 'utf-8'))
    } else {
      this.meta = { papers: {}, total_chunks: 0, last_updated: '' }
    }
  }

  /**
   * Add a paper's chunks to the index.
   */
  addPaper(
    paperId: string,
    paperMeta: PaperMeta,
    chunks: SectionChunk[],
  ): void {
    // Write chunks file
    const chunksPath = join(this.chunksDir, `${this.sanitizeId(paperId)}.json`)
    writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), 'utf-8')

    // Update meta
    this.meta.papers[paperId] = {
      ...paperMeta,
      chunk_count: chunks.length,
    }
    this.meta.total_chunks = Object.values(this.meta.papers).reduce(
      (sum, p) => sum + p.chunk_count,
      0,
    )
    this.meta.last_updated = new Date().toISOString()
    writeFileSync(this.indexPath, JSON.stringify(this.meta, null, 2), 'utf-8')

    // Invalidate caches
    this.allChunks = null
    this.idfCache = null
  }

  /**
   * Remove a paper from the index.
   */
  removePaper(paperId: string): void {
    const chunksPath = join(this.chunksDir, `${this.sanitizeId(paperId)}.json`)
    if (existsSync(chunksPath)) {
      unlinkSync(chunksPath)
    }
    delete this.meta.papers[paperId]
    this.meta.total_chunks = Object.values(this.meta.papers).reduce(
      (sum, p) => sum + p.chunk_count,
      0,
    )
    this.meta.last_updated = new Date().toISOString()
    writeFileSync(this.indexPath, JSON.stringify(this.meta, null, 2), 'utf-8')
    this.allChunks = null
    this.idfCache = null
  }

  /**
   * Search chunks by keyword query with TF-IDF scoring.
   */
  search(query: string, topK: number = 10): ScoredChunk[] {
    const chunks = this.loadAllChunks()
    if (chunks.length === 0) return []

    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return []

    const idf = this.getIDF(chunks)

    const scored: ScoredChunk[] = []
    for (const chunk of chunks) {
      const chunkTokens = tokenize(chunk.content)
      const tf = termFrequency(chunkTokens)

      let score = 0
      const matchTerms: string[] = []

      for (const qt of queryTokens) {
        const termTf = tf.get(qt) ?? 0
        if (termTf > 0) {
          const termIdf = idf.get(qt) ?? 0
          score += termTf * termIdf
          if (!matchTerms.includes(qt)) matchTerms.push(qt)
        }
      }

      // Boost for figure descriptions matching query (capped)
      if (chunk.figure_descriptions) {
        const figText = chunk.figure_descriptions.join(' ').toLowerCase()
        const figMatches = queryTokens.filter(qt => figText.includes(qt)).length
        if (figMatches > 0) {
          score *= 1.0 + 0.2 * Math.min(figMatches, 3)
        }
      }

      // Boost title matches (capped)
      const titleLower = chunk.section_title.toLowerCase()
      const titleMatches = queryTokens.filter(qt =>
        titleLower.includes(qt),
      ).length
      if (titleMatches > 0) {
        score *= 1.0 + 0.5 * Math.min(titleMatches, 3)
      }

      if (score > 0) {
        scored.push({ ...chunk, score, match_terms: matchTerms })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  /**
   * Get all chunks for a specific paper.
   */
  getByPaper(paperId: string): SectionChunk[] {
    const chunksPath = join(this.chunksDir, `${this.sanitizeId(paperId)}.json`)
    if (!existsSync(chunksPath)) return []
    return JSON.parse(readFileSync(chunksPath, 'utf-8'))
  }

  /**
   * Get index metadata (paper count, total chunks, etc.)
   */
  getMeta(): IndexMeta {
    return { ...this.meta }
  }

  /**
   * List all indexed paper IDs.
   */
  listPapers(): string[] {
    return Object.keys(this.meta.papers)
  }

  // ── Private helpers ────────────────────────────────────

  private loadAllChunks(): SectionChunk[] {
    if (this.allChunks !== null) return this.allChunks

    const chunks: SectionChunk[] = []
    if (!existsSync(this.chunksDir)) return chunks

    const files = readdirSync(this.chunksDir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      try {
        const data = JSON.parse(
          readFileSync(join(this.chunksDir, file), 'utf-8'),
        )
        if (Array.isArray(data)) {
          chunks.push(...data)
        }
      } catch {
        // Skip corrupted files
      }
    }

    this.allChunks = chunks
    return chunks
  }

  private getIDF(chunks: SectionChunk[]): Map<string, number> {
    if (this.idfCache !== null) return this.idfCache

    const docCount = chunks.length
    const docFreq = new Map<string, number>()

    for (const chunk of chunks) {
      const uniqueTokens = new Set(tokenize(chunk.content))
      for (const t of uniqueTokens) {
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
      }
    }

    const idf = new Map<string, number>()
    for (const [term, df] of docFreq) {
      idf.set(term, Math.log((docCount + 1) / (df + 1)) + 1)
    }

    this.idfCache = idf
    return idf
  }

  private sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9._-]/g, '_')
  }
}
