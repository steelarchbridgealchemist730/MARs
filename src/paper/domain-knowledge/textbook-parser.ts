import type { PDFExtractResult } from '../pdf-extractor'
import type { PDFExtractor } from '../pdf-extractor'
import type {
  KnowledgeEntry,
  KnowledgeEntryType,
  TextbookConfig,
} from './types'
import type { EntryStore } from './entry-store'
import { chatCompletion } from '../llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import { estimateTokens } from '../claim-graph/token-utils'
import { repairTruncatedJSON } from '../json-repair'

// ── Types ───────────────────────────────────────────────

export interface ChapterContent {
  number: number
  title: string
  text: string
  sections: Array<{ title: string; level: number }>
  startOffset: number
  endOffset: number
}

export interface TextbookParseResult {
  sourceId: string
  chapters_parsed: number
  entries_created: number
  cost_usd: number
  errors: string[]
}

export type TextbookParseProgress =
  | { type: 'phase'; message: string }
  | { type: 'chapter_start'; chapter: number; title: string }
  | { type: 'chapter_done'; chapter: number; entries: number }
  | { type: 'error'; message: string }

// ── Constants ───────────────────────────────────────────

const MAX_TOKENS_PER_CALL = 25_000
const MAX_CHARS_PER_CALL = MAX_TOKENS_PER_CALL * 4

// ── Textbook Parser ─────────────────────────────────────

export class TextbookParser {
  constructor(
    private entryStore: EntryStore,
    private pdfExtractor: PDFExtractor,
  ) {}

  /** Main entry point. */
  async parse(
    config: TextbookConfig,
    packDir: string,
    onProgress?: (event: TextbookParseProgress) => void,
  ): Promise<TextbookParseResult> {
    const errors: string[] = []
    let costUsd = 0
    let entriesCreated = 0

    // Step 1: PDF extraction
    onProgress?.({ type: 'phase', message: 'Extracting text from PDF...' })
    const outputDir = `${packDir}/.tmp-extract-${config.id}`
    let extracted: PDFExtractResult
    try {
      extracted = await this.pdfExtractor.extract(
        config.path,
        config.id,
        outputDir,
      )
    } catch (err) {
      throw new Error(
        `PDF extraction failed for ${config.path}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // Step 2: Chapter identification
    onProgress?.({ type: 'phase', message: 'Identifying chapters...' })
    let chapters = this.identifyChapters(extracted)

    // Step 3: Filter target chapters
    if (config.focus_chapters && config.focus_chapters.length > 0) {
      chapters = chapters.filter(ch =>
        config.focus_chapters!.includes(ch.number),
      )
    }

    onProgress?.({
      type: 'phase',
      message: `Found ${chapters.length} chapter(s) to parse`,
    })

    // Step 4: Per-chapter LLM parsing
    for (const chapter of chapters) {
      onProgress?.({
        type: 'chapter_start',
        chapter: chapter.number,
        title: chapter.title,
      })

      try {
        const { entries, cost } = await this.parseChapter(chapter, config.id)

        // Step 5: Assign IDs and save
        for (const rawEntry of entries) {
          const id = this.entryStore.nextId(rawEntry.type)
          const entry: KnowledgeEntry = {
            ...rawEntry,
            id,
            source: {
              id: config.id,
              chapter: String(chapter.number),
              section: rawEntry.source?.section || '',
              page: rawEntry.source?.page || 0,
            },
          }
          this.entryStore.saveEntry(entry)
          entriesCreated++
        }

        costUsd += cost
        onProgress?.({
          type: 'chapter_done',
          chapter: chapter.number,
          entries: entries.length,
        })
      } catch (err) {
        const msg = `Chapter ${chapter.number} (${chapter.title}): ${err instanceof Error ? err.message : String(err)}`
        errors.push(msg)
        onProgress?.({ type: 'error', message: msg })
      }
    }

    return {
      sourceId: config.id,
      chapters_parsed: chapters.length,
      entries_created: entriesCreated,
      cost_usd: costUsd,
      errors,
    }
  }

  // ── Chapter Identification ────────────────────────────

  identifyChapters(extracted: PDFExtractResult): ChapterContent[] {
    const sections = extracted.text.sections || []
    const fullText = extracted.text.markdown || ''

    if (fullText.length === 0) return []

    // Try level-1 headings first, then level-2
    let chapterSections = sections.filter(s => s.level === 1)
    if (chapterSections.length === 0) {
      chapterSections = sections.filter(s => s.level === 2)
    }

    // If no headings found, treat entire text as one chapter
    if (chapterSections.length === 0) {
      return [
        {
          number: 1,
          title: 'Full Text',
          text: fullText,
          sections: [],
          startOffset: 0,
          endOffset: fullText.length,
        },
      ]
    }

    const chapters: ChapterContent[] = []

    for (let i = 0; i < chapterSections.length; i++) {
      const sec = chapterSections[i]
      const nextSec = chapterSections[i + 1]
      const startOffset = sec.char_offset
      const endOffset = nextSec ? nextSec.char_offset : fullText.length

      // Collect sub-sections within this chapter's range
      const subSections = sections.filter(
        s =>
          s.level > sec.level &&
          s.char_offset >= startOffset &&
          s.char_offset < endOffset,
      )

      chapters.push({
        number: i + 1,
        title: sec.title,
        text: fullText.slice(startOffset, endOffset),
        sections: subSections.map(s => ({
          title: s.title,
          level: s.level,
        })),
        startOffset,
        endOffset,
      })
    }

    return chapters
  }

  // ── Per-Chapter Parsing ───────────────────────────────

  async parseChapter(
    chapter: ChapterContent,
    sourceId: string,
  ): Promise<{ entries: KnowledgeEntry[]; cost: number }> {
    const textTokens = estimateTokens(chapter.text)
    let allEntries: KnowledgeEntry[] = []
    let totalCost = 0

    if (textTokens <= MAX_TOKENS_PER_CALL) {
      // Single call
      const { entries, cost } = await this.callLLM(
        chapter.text,
        sourceId,
        chapter.number,
        chapter.title,
      )
      allEntries = entries
      totalCost = cost
    } else {
      // Split by sections within the chapter
      const chunks = this.splitChapterIntoChunks(chapter)
      for (const chunk of chunks) {
        try {
          const { entries, cost } = await this.callLLM(
            chunk.text,
            sourceId,
            chapter.number,
            `${chapter.title} - ${chunk.title}`,
          )
          allEntries.push(...entries)
          totalCost += cost
        } catch (err) {
          // Retry once on failure
          try {
            const { entries, cost } = await this.callLLM(
              chunk.text,
              sourceId,
              chapter.number,
              `${chapter.title} - ${chunk.title}`,
            )
            allEntries.push(...entries)
            totalCost += cost
          } catch {
            // Skip this chunk after retry failure
          }
        }
      }
    }

    return { entries: allEntries, cost: totalCost }
  }

  private splitChapterIntoChunks(
    chapter: ChapterContent,
  ): Array<{ title: string; text: string }> {
    // If there are no sub-sections, split by character limit
    if (chapter.sections.length === 0) {
      return this.splitTextBySize(chapter.text, chapter.title)
    }

    // Split at section boundaries within the chapter text
    // Sections have titles — find them in the text
    const chunks: Array<{ title: string; text: string }> = []
    let currentTitle = chapter.title
    let currentStart = 0

    for (const sec of chapter.sections) {
      const idx = chapter.text.indexOf(sec.title, currentStart)
      if (idx > currentStart) {
        const chunkText = chapter.text.slice(currentStart, idx)
        if (chunkText.trim().length > 0) {
          chunks.push({ title: currentTitle, text: chunkText })
        }
        currentTitle = sec.title
        currentStart = idx
      }
    }

    // Last chunk
    const lastText = chapter.text.slice(currentStart)
    if (lastText.trim().length > 0) {
      chunks.push({ title: currentTitle, text: lastText })
    }

    // If any chunk is still too large, split it further
    const result: Array<{ title: string; text: string }> = []
    for (const chunk of chunks) {
      if (chunk.text.length > MAX_CHARS_PER_CALL) {
        result.push(...this.splitTextBySize(chunk.text, chunk.title))
      } else {
        result.push(chunk)
      }
    }

    return result
  }

  private splitTextBySize(
    text: string,
    title: string,
  ): Array<{ title: string; text: string }> {
    const chunks: Array<{ title: string; text: string }> = []
    let offset = 0
    let part = 1

    while (offset < text.length) {
      let end = Math.min(offset + MAX_CHARS_PER_CALL, text.length)
      // Try to break at paragraph boundary
      if (end < text.length) {
        const paraBreak = text.lastIndexOf('\n\n', end)
        if (paraBreak > offset + MAX_CHARS_PER_CALL * 0.5) {
          end = paraBreak
        }
      }
      chunks.push({
        title: `${title} (part ${part})`,
        text: text.slice(offset, end),
      })
      offset = end
      part++
    }

    return chunks
  }

  // ── LLM Call ──────────────────────────────────────────

  private async callLLM(
    text: string,
    sourceId: string,
    chapterNum: number,
    chapterTitle: string,
  ): Promise<{ entries: KnowledgeEntry[]; cost: number }> {
    const prompt = this.buildPrompt(text, sourceId, chapterNum, chapterTitle)

    const result = await chatCompletion({
      modelSpec: DEFAULT_MODEL_ASSIGNMENTS.research,
      messages: [{ role: 'user', content: prompt }],
      system:
        'You are parsing a textbook chapter to extract structured knowledge entries. Output only a JSON array. No markdown fences, no commentary.',
      max_tokens: 16384,
      temperature: 0,
    })

    const entries = this.parseEntries(result.text)
    return { entries, cost: result.cost_usd }
  }

  private buildPrompt(
    text: string,
    sourceId: string,
    chapterNum: number,
    chapterTitle: string,
  ): string {
    return `Source: ${sourceId}, Chapter ${chapterNum}: ${chapterTitle}

Text:
${text}

Extract ALL of the following from the text above:
1. **Definitions**: each with precise statement
2. **Theorems/Propositions/Lemmas/Corollaries**: statement + assumptions + proof_sketch + proof_technique
3. **Algorithms**: pseudocode + complexity + inputs/outputs
4. **Key Results**: important named results or equations

For EACH entry, output a JSON object with these fields:
- "type": one of "theorem", "proposition", "lemma", "corollary", "definition", "algorithm", "result"
- "label": short identifier (e.g. "Bayes' Theorem", "SGD Algorithm")
- "name": formal name if one exists, otherwise a descriptive name
- "statement": the precise mathematical statement or definition text (use LaTeX for math)
- "assumptions": array of { "id": "A1", "text": "...", "strength": "standard"|"technical"|"strong"|"necessary_and_sufficient" } (for theorems)
- "proof_sketch": brief sketch of the proof approach (for theorems)
- "proof_technique": e.g. "induction", "contradiction", "construction" (for theorems)
- "proof_difficulty": "elementary"|"moderate"|"advanced"|"deep" (for theorems)
- "pseudocode": algorithm steps (for algorithms)
- "complexity": time/space complexity (for algorithms)
- "inputs": input description (for algorithms)
- "outputs": output description (for algorithms)
- "usability": { "citable": true/false, "cite_as": "Author et al. (Year)", "common_use": "brief description of how this is typically used" }
- "relations": { "depends_on": [], "used_by": [], "generalizes": null, "specialized_by": [] }
- "tags": array of topic tags (e.g. ["optimization", "convexity", "gradient descent"])
- "source": { "section": "section title if known", "page": page_number_if_known_or_0 }

Output a JSON array of these objects. Be precise with LaTeX notation. Do not invent content not in the text.`
  }

  // ── JSON Parsing ──────────────────────────────────────

  private parseEntries(responseText: string): KnowledgeEntry[] {
    // Strip markdown fences
    let cleaned = responseText
      .replace(/```(?:json)?\s*\n?/g, '')
      .replace(/```\s*$/g, '')
      .trim()

    // Try to find a JSON array
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/)
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0])
        if (Array.isArray(parsed)) {
          return this.validateEntries(parsed)
        }
      } catch {
        // Try repair
      }
    }

    // Try repair on the full text
    const repaired = repairTruncatedJSON(cleaned)
    if (repaired) {
      // repairTruncatedJSON expects objects; we may have an array
      if (Array.isArray(repaired)) {
        return this.validateEntries(repaired)
      }
      // Maybe it wrapped in an object with an entries field
      if (
        typeof repaired === 'object' &&
        repaired !== null &&
        'entries' in repaired
      ) {
        const arr = (repaired as Record<string, unknown>).entries
        if (Array.isArray(arr)) return this.validateEntries(arr)
      }
    }

    // Try to find array start and repair from there
    const arrayStart = cleaned.indexOf('[')
    if (arrayStart >= 0) {
      let repairText = cleaned.slice(arrayStart)

      // Close unterminated string (odd number of unescaped quotes)
      const unescapedQuotes = repairText.match(/(?<!\\)"/g)
      if (unescapedQuotes && unescapedQuotes.length % 2 !== 0) {
        repairText += '"'
      }

      // Count open brackets/braces properly (respecting strings)
      let openBraces = 0
      let openBrackets = 0
      let inString = false
      for (let i = 0; i < repairText.length; i++) {
        const ch = repairText[i]
        if (ch === '\\' && inString) {
          i++
          continue
        }
        if (ch === '"') {
          inString = !inString
          continue
        }
        if (inString) continue
        if (ch === '{') openBraces++
        else if (ch === '}') openBraces--
        else if (ch === '[') openBrackets++
        else if (ch === ']') openBrackets--
      }

      // Remove trailing comma before closing
      repairText = repairText.replace(/,\s*$/, '')
      for (let i = 0; i < openBraces; i++) repairText += '}'
      for (let i = 0; i < openBrackets; i++) repairText += ']'
      try {
        const parsed = JSON.parse(repairText)
        if (Array.isArray(parsed)) return this.validateEntries(parsed)
      } catch {
        // Give up
      }
    }

    return []
  }

  private validateEntries(raw: unknown[]): KnowledgeEntry[] {
    const valid: KnowledgeEntry[] = []
    const validTypes: KnowledgeEntryType[] = [
      'theorem',
      'proposition',
      'lemma',
      'corollary',
      'definition',
      'algorithm',
      'result',
    ]

    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>

      // Required fields
      if (
        !obj.type ||
        typeof obj.type !== 'string' ||
        !validTypes.includes(obj.type as KnowledgeEntryType)
      )
        continue
      if (!obj.label || typeof obj.label !== 'string') continue
      if (!obj.statement || typeof obj.statement !== 'string') continue

      // Build entry with defaults for missing optional fields
      const entry: KnowledgeEntry = {
        id: '', // Will be assigned by caller
        type: obj.type as KnowledgeEntryType,
        source: {
          id: '',
          chapter: '',
          section:
            typeof (obj.source as any)?.section === 'string'
              ? (obj.source as any).section
              : '',
          page:
            typeof (obj.source as any)?.page === 'number'
              ? (obj.source as any).page
              : 0,
        },
        label: obj.label as string,
        name: typeof obj.name === 'string' ? obj.name : (obj.label as string),
        statement: obj.statement as string,
        usability: {
          citable:
            typeof (obj.usability as any)?.citable === 'boolean'
              ? (obj.usability as any).citable
              : true,
          cite_as:
            typeof (obj.usability as any)?.cite_as === 'string'
              ? (obj.usability as any).cite_as
              : undefined,
          common_use:
            typeof (obj.usability as any)?.common_use === 'string'
              ? (obj.usability as any).common_use
              : '',
        },
        relations: {
          depends_on: Array.isArray((obj.relations as any)?.depends_on)
            ? (obj.relations as any).depends_on
            : [],
          used_by: Array.isArray((obj.relations as any)?.used_by)
            ? (obj.relations as any).used_by
            : [],
          generalizes:
            typeof (obj.relations as any)?.generalizes === 'string'
              ? (obj.relations as any).generalizes
              : null,
          specialized_by: Array.isArray((obj.relations as any)?.specialized_by)
            ? (obj.relations as any).specialized_by
            : [],
        },
        tags: Array.isArray(obj.tags)
          ? (obj.tags as string[]).filter(t => typeof t === 'string')
          : [],
      }

      // Optional theorem fields
      if (Array.isArray(obj.assumptions))
        entry.assumptions = obj.assumptions as any
      if (typeof obj.proof_sketch === 'string')
        entry.proof_sketch = obj.proof_sketch
      if (typeof obj.proof_technique === 'string')
        entry.proof_technique = obj.proof_technique
      if (typeof obj.proof_difficulty === 'string')
        entry.proof_difficulty = obj.proof_difficulty as any

      // Optional algorithm fields
      if (typeof obj.pseudocode === 'string') entry.pseudocode = obj.pseudocode
      if (typeof obj.complexity === 'string') entry.complexity = obj.complexity
      if (typeof obj.inputs === 'string') entry.inputs = obj.inputs
      if (typeof obj.outputs === 'string') entry.outputs = obj.outputs

      valid.push(entry)
    }

    return valid
  }
}
