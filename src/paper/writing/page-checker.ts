import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs'
import { join, dirname } from 'path'
import { chatCompletion } from '../llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import type { VenueConstraints } from './template-types'
import type { PageCheckResult, CutSuggestion } from './types'
import { estimateWordCount } from './writer'

// ── PageChecker ──────────────────────────────────────────

export class PageChecker {
  private modelName: string

  constructor(modelName?: string) {
    this.modelName = modelName ?? DEFAULT_MODEL_ASSIGNMENTS.quick
  }

  /**
   * Get page count from a compiled PDF.
   * Strategy 1: pdfinfo (poppler-utils)
   * Strategy 2: grep /Type /Page in PDF bytes
   */
  async getPageCount(pdfPath: string): Promise<number> {
    if (!existsSync(pdfPath)) return 0

    // Strategy 1: pdfinfo
    try {
      const proc = Bun.spawn(['pdfinfo', pdfPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await proc.exited
      if (proc.exitCode === 0) {
        const stdout = await new Response(proc.stdout).text()
        const match = stdout.match(/Pages:\s+(\d+)/)
        if (match) return parseInt(match[1]!, 10)
      }
    } catch {
      // pdfinfo not available — try fallback
    }

    // Strategy 2: Count /Type /Page in PDF bytes
    try {
      const buffer = readFileSync(pdfPath)
      const text = buffer.toString('latin1')
      // Count occurrences of /Type /Page (but not /Type /Pages)
      const matches = text.match(/\/Type\s*\/Page(?!\s*s)/g)
      if (matches) return matches.length
    } catch {
      // Couldn't read PDF
    }

    return 0
  }

  /**
   * Check if the compiled PDF meets page budget constraints.
   */
  async check(
    pdfPath: string,
    constraints: VenueConstraints | null,
  ): Promise<PageCheckResult> {
    const totalPages = await this.getPageCount(pdfPath)

    if (!constraints || constraints.page_limits.main_body === 'unlimited') {
      return {
        passed: true,
        totalPages,
        mainBodyPages: totalPages,
        limit: 'unlimited',
        overBy: 0,
      }
    }

    const limit = constraints.page_limits.main_body
    const mainBodyPages = this.estimateMainBodyPages(pdfPath, totalPages)
    const overBy = Math.max(0, mainBodyPages - limit)

    return {
      passed: overBy === 0,
      totalPages,
      mainBodyPages,
      limit,
      overBy,
      suggestion:
        overBy > 0
          ? `Paper exceeds page limit by ${overBy} page(s). Consider tightening prose, moving content to appendix, or reducing figure sizes.`
          : undefined,
    }
  }

  /**
   * Suggest cuts to bring the paper within page budget.
   * Uses LLM to analyze section word counts and suggest structured cuts.
   */
  async suggestCuts(
    paperDir: string,
    overByPages: number,
    constraints: VenueConstraints | null,
  ): Promise<CutSuggestion[]> {
    if (overByPages <= 0) return []

    const sectionsDir = join(paperDir, 'sections')
    if (!existsSync(sectionsDir)) return []

    // Collect section word counts
    const sectionStats: Array<{ name: string; words: number }> = []
    try {
      const files = readdirSync(sectionsDir).filter(f => f.endsWith('.tex'))
      for (const file of files) {
        const content = readFileSync(join(sectionsDir, file), 'utf-8')
        const words = estimateWordCount(content)
        sectionStats.push({ name: file.replace(/\.tex$/, ''), words })
      }
    } catch {
      return []
    }

    if (sectionStats.length === 0) return []

    // Estimate words per page
    const wordsPerPage = this.estimateWordsPerPage(constraints)
    const wordsToSave = Math.ceil(overByPages * wordsPerPage)

    try {
      const response = await chatCompletion({
        modelSpec: this.modelName,
        max_tokens: 2048,
        system: `You are a research paper editor. Suggest specific cuts to reduce a paper by approximately ${wordsToSave} words (${overByPages} pages). Return a JSON array of cut suggestions.`,
        messages: [
          {
            role: 'user',
            content: `The paper exceeds the page limit by ${overByPages} page(s) (~${wordsToSave} words to save).

Section word counts:
${sectionStats.map(s => `- ${s.name}: ${s.words} words`).join('\n')}

Return a JSON array of objects with: section (string), action (string describing what to cut/move), estimated_savings_words (number), risk_level ("low" | "medium" | "high").

Focus on low-risk cuts first (move to appendix, tighten prose, remove redundancy). Return ONLY the JSON array.`,
          },
        ],
      })

      let text = response.text
        .replace(/^```(?:json)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim()

      const suggestions = JSON.parse(text) as CutSuggestion[]
      return Array.isArray(suggestions) ? suggestions : []
    } catch {
      return []
    }
  }

  /**
   * Apply suggested cuts to bring the paper within page budget.
   * Processes low-risk cuts first, then medium. Skips high-risk.
   * Max 2 rounds of compression per section.
   */
  async applyCuts(
    paperDir: string,
    cuts: CutSuggestion[],
    constraints: VenueConstraints | null,
  ): Promise<{ applied: number; wordsSaved: number }> {
    const sectionsDir = join(paperDir, 'sections')
    if (!existsSync(sectionsDir)) return { applied: 0, wordsSaved: 0 }

    // Sort: low first, then medium; skip high
    const sortedCuts = [...cuts]
      .filter(c => c.risk_level !== 'high')
      .sort((a, b) => {
        const order = { low: 0, medium: 1, high: 2 }
        return order[a.risk_level] - order[b.risk_level]
      })

    let applied = 0
    let wordsSaved = 0
    const compressionRounds: Record<string, number> = {}

    for (const cut of sortedCuts) {
      const sectionFile = join(sectionsDir, `${cut.section}.tex`)
      if (!existsSync(sectionFile)) continue

      const content = readFileSync(sectionFile, 'utf-8')
      const currentWords = estimateWordCount(content)

      if (
        cut.action.toLowerCase().includes('move_to_appendix') ||
        cut.action.toLowerCase().includes('appendix')
      ) {
        try {
          const result = await this.moveToAppendix(
            paperDir,
            sectionFile,
            cut.section,
            content,
            cut.action,
          )
          wordsSaved += result.wordsSaved
          applied++
        } catch {
          /* LLM extraction failed — skip */
        }
        continue
      }

      // Compress action: rewrite section to be shorter
      const rounds = compressionRounds[cut.section] ?? 0
      if (rounds >= 2) continue // Max 2 compression rounds per section

      const targetWords = Math.max(
        50,
        currentWords - cut.estimated_savings_words,
      )

      try {
        const response = await chatCompletion({
          modelSpec: this.modelName,
          max_tokens: 16384,
          system: `You are an expert academic editor. Compress the following LaTeX section to approximately ${targetWords} words while preserving all key technical content, claims, and citations. Remove redundancy, tighten prose, and eliminate filler. Return ONLY the compressed LaTeX content, no markdown fences or explanation.`,
          messages: [
            {
              role: 'user',
              content: `Compress this section from ~${currentWords} words to ~${targetWords} words:\n\n${content}`,
            },
          ],
        })

        let compressed = response.text
          .replace(/^```(?:latex|tex)?\n?/m, '')
          .replace(/\n?```$/m, '')
          .trim()

        const newWords = estimateWordCount(compressed)
        const saved = currentWords - newWords

        if (saved > 0) {
          writeFileSync(sectionFile, compressed, 'utf-8')
          wordsSaved += saved
          applied++
        }
      } catch {
        // LLM compression failed — skip this cut
      }

      compressionRounds[cut.section] = rounds + 1
    }

    return { applied, wordsSaved }
  }

  // ── Appendix helpers ─────────────────────────────────

  /**
   * Move content from a section to an appendix file using LLM extraction.
   * Returns the number of words saved from the original section.
   */
  private async moveToAppendix(
    paperDir: string,
    sectionFile: string,
    sectionName: string,
    content: string,
    action: string,
  ): Promise<{ wordsSaved: number }> {
    const beforeWords = estimateWordCount(content)

    const response = await chatCompletion({
      modelSpec: this.modelName,
      max_tokens: 16384,
      system: `You are an expert academic editor. Given a LaTeX section and an action description, split the section into two parts:
1. "remaining" — the main content that stays, with a back-reference like "See Appendix~\\ref{app:${sectionName}} for details."
2. "extracted" — the content to move to the appendix.

Return a JSON object with exactly two keys: "remaining" (string) and "extracted" (string). Both should be valid LaTeX content. Return ONLY the JSON object, no markdown fences.`,
      messages: [
        {
          role: 'user',
          content: `Action: ${action}\n\nSection content:\n${content}`,
        },
      ],
    })

    let parsed: { remaining: string; extracted: string }
    try {
      let text = response.text
        .replace(/^```(?:json)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim()
      parsed = JSON.parse(text)
    } catch {
      throw new Error('Failed to parse LLM extraction response')
    }

    if (!parsed.remaining || !parsed.extracted) {
      throw new Error('LLM extraction returned empty remaining or extracted')
    }

    // Write remaining content back to the original section file
    writeFileSync(sectionFile, parsed.remaining, 'utf-8')

    // Create appendix file
    const sectionsDir = join(paperDir, 'sections')
    mkdirSync(sectionsDir, { recursive: true })
    const titleCase = sectionName.charAt(0).toUpperCase() + sectionName.slice(1)
    const appendixContent = `\\section{${titleCase} (Supplementary)}\n\\label{app:${sectionName}}\n\n${parsed.extracted}\n`
    writeFileSync(
      join(sectionsDir, `appendix-${sectionName}.tex`),
      appendixContent,
      'utf-8',
    )

    // Ensure main.tex includes the appendix
    this.ensureAppendixInMainTex(paperDir, sectionName)

    const afterWords = estimateWordCount(parsed.remaining)
    return { wordsSaved: Math.max(0, beforeWords - afterWords) }
  }

  /**
   * Ensure main.tex has an \appendix marker and includes the appendix section file.
   */
  private ensureAppendixInMainTex(paperDir: string, sectionName: string): void {
    const mainTexPath = join(paperDir, 'main.tex')
    if (!existsSync(mainTexPath)) return

    let mainTex = readFileSync(mainTexPath, 'utf-8')
    const inputLine = `\\input{sections/appendix-${sectionName}}`

    // If no \appendix line exists, insert it before \bibliography / \bibliographystyle / \end{document}
    if (!mainTex.includes('\\appendix')) {
      const insertBefore =
        /^(\\bibliography\b|\\bibliographystyle\b|\\end\{document\})/m
      const match = insertBefore.exec(mainTex)
      if (match && match.index !== undefined) {
        mainTex =
          mainTex.slice(0, match.index) +
          '\\appendix\n' +
          inputLine +
          '\n\n' +
          mainTex.slice(match.index)
      }
    } else {
      // \appendix exists — add input after it if not already present
      if (!mainTex.includes(inputLine)) {
        const appendixIdx = mainTex.indexOf('\\appendix')
        const afterAppendix = appendixIdx + '\\appendix'.length
        // Find end of line after \appendix
        const eolIdx = mainTex.indexOf('\n', afterAppendix)
        const insertAt = eolIdx >= 0 ? eolIdx + 1 : afterAppendix
        mainTex =
          mainTex.slice(0, insertAt) +
          inputLine +
          '\n' +
          mainTex.slice(insertAt)
      }
    }

    writeFileSync(mainTexPath, mainTex, 'utf-8')
  }

  // ── Internal helpers ──────────────────────────────────

  /**
   * Estimate the number of main body pages from total pages.
   * Looks for \appendix or \bibliography markers in main.tex to estimate ratio.
   */
  private estimateMainBodyPages(pdfPath: string, totalPages: number): number {
    if (totalPages === 0) return 0

    const texDir = dirname(pdfPath)
    const mainTexPath = join(texDir, 'main.tex')
    if (!existsSync(mainTexPath)) return totalPages

    try {
      const content = readFileSync(mainTexPath, 'utf-8')
      const lines = content.split('\n')
      const totalLines = lines.length

      // Find \appendix or \bibliography position
      let endMainIdx = totalLines
      for (let i = 0; i < lines.length; i++) {
        if (
          lines[i]!.includes('\\appendix') ||
          lines[i]!.includes('\\bibliography') ||
          lines[i]!.includes('\\printbibliography')
        ) {
          endMainIdx = i
          break
        }
      }

      if (endMainIdx >= totalLines) return totalPages

      // Ratio-based estimation
      const mainRatio = endMainIdx / totalLines
      return Math.round(totalPages * mainRatio)
    } catch {
      return totalPages
    }
  }

  /**
   * Estimate words per page based on venue formatting.
   */
  private estimateWordsPerPage(constraints: VenueConstraints | null): number {
    if (!constraints) return 500
    const cols = constraints.formatting.columns
    const fontSize = constraints.formatting.font_size
    if (cols === 2 && fontSize.includes('10')) return 700
    if (cols === 1 && fontSize.includes('12')) return 350
    if (cols === 2) return 650
    return 500
  }
}
