import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { DiscoveredPaper, AcquisitionResult, BatchSummary } from './types'
import { chatCompletion } from '../llm-client'
import type { FragmentStore } from '../fragment-store'

const BATCH_SIZE = 25 // papers per map-phase batch
const MAX_BATCH_CHARS = 40000 // char limit per batch input
const MAX_REDUCE_CHARS = 60000 // char limit for reduce phase

const FRAGMENT_SYSTEM_PROMPT = `You are an academic writer converting a literature analysis into LaTeX fragments.
Given a Markdown literature analysis and a BibTeX bibliography, produce a standalone LaTeX
section suitable for \\input{} in a research paper. Use \\cite{key} for citations where keys
match the provided .bib entries. Do not include \\documentclass, \\begin{document}, or preamble.
Use standard LaTeX commands: \\section{}, \\subsection{}, \\paragraph{}, \\cite{}, \\textit{}, etc.
Output ONLY the LaTeX content, no markdown fences or explanations.`

function buildPapersSummary(
  papers: DiscoveredPaper[],
  acquired: AcquisitionResult[],
  maxChars: number = MAX_BATCH_CHARS,
): string {
  const acquiredMap = new Map<string, AcquisitionResult>()
  for (const a of acquired) {
    acquiredMap.set(a.paper.source_id, a)
  }

  const lines: string[] = []
  let totalChars = 0

  for (const p of papers) {
    const acq = acquiredMap.get(p.source_id)
    const status = acq ? `[${acq.status}]` : '[abstract_only]'

    const entry = [
      `### ${p.title} (${p.year}) ${status}`,
      `Authors: ${p.authors.slice(0, 5).join(', ')}`,
      `Citations: ${p.citation_count} | Source: ${p.source}`,
      `Abstract: ${p.abstract}`,
      '',
    ].join('\n')

    if (totalChars + entry.length > maxChars) {
      lines.push(
        `... (${papers.length - papers.indexOf(p)} more papers truncated due to length limit)`,
      )
      break
    }

    lines.push(entry)
    totalChars += entry.length
  }

  return lines.join('\n')
}

export class LiteratureAnalyzer {
  private projectDir: string
  private modelName: string

  constructor(projectDir: string, modelName: string) {
    this.projectDir = projectDir
    this.modelName = modelName
  }

  /**
   * Backward-compatible entry point. Delegates to analyzeMapReduce.
   */
  async analyze(
    papers: DiscoveredPaper[],
    acquired: AcquisitionResult[],
  ): Promise<void> {
    await this.analyzeMapReduce(papers, acquired)
  }

  /**
   * Map-reduce analysis for large paper sets.
   * - <= BATCH_SIZE papers: single-call (same as original behavior)
   * - > BATCH_SIZE papers: map phase → optional intermediate reduce → final reports
   */
  async analyzeMapReduce(
    papers: DiscoveredPaper[],
    acquired: AcquisitionResult[],
    onProgress?: (msg: string) => void,
  ): Promise<void> {
    const litDir = join(this.projectDir, 'literature')
    mkdirSync(litDir, { recursive: true })

    if (papers.length <= BATCH_SIZE) {
      // Small paper set — direct single-call analysis (no map-reduce overhead)
      const papersSummary = buildPapersSummary(papers, acquired)
      const topic = `${papers.length} papers`

      await Promise.all([
        this.writeSurvey(litDir, papersSummary, topic),
        this.writeGaps(litDir, papersSummary, topic),
        this.writeTaxonomy(litDir, papersSummary, topic),
        this.writeTimeline(litDir, papersSummary, topic),
      ])
      return
    }

    // ── Map phase: build batch summaries ──────────────────
    onProgress?.(
      `  Map phase: splitting ${papers.length} papers into batches of ${BATCH_SIZE}...`,
    )
    const batchSummaries = await this.buildBatchSummaries(
      papers,
      acquired,
      onProgress,
    )

    // Save batch summaries for debugging/resumption
    const batchSummariesPath = join(litDir, 'batch-summaries.json')
    writeFileSync(
      batchSummariesPath,
      JSON.stringify(batchSummaries, null, 2),
      'utf-8',
    )
    onProgress?.(
      `  Map phase complete: ${batchSummaries.length} batch summaries generated`,
    )

    // ── Reduce phase: combine batch summaries ────────────
    let combinedSummary = batchSummaries
      .map(bs => bs.summary)
      .join('\n\n---\n\n')

    if (combinedSummary.length > MAX_REDUCE_CHARS) {
      onProgress?.(
        `  Intermediate reduce: combined summaries exceed ${MAX_REDUCE_CHARS} chars, reducing...`,
      )
      combinedSummary = await this.intermediateReduce(
        batchSummaries,
        onProgress,
      )
    }

    // ── Final reports from reduced summaries ─────────────
    const topic = `${papers.length} papers (map-reduce from ${batchSummaries.length} batches)`
    onProgress?.('  Generating final reports from reduced summaries...')

    await Promise.all([
      this.writeSurvey(litDir, combinedSummary, topic),
      this.writeGaps(litDir, combinedSummary, topic),
      this.writeTaxonomy(litDir, combinedSummary, topic),
      this.writeTimeline(litDir, combinedSummary, topic),
    ])
  }

  /**
   * Map phase: split papers into batches and produce a structured summary for each.
   */
  private async buildBatchSummaries(
    papers: DiscoveredPaper[],
    acquired: AcquisitionResult[],
    onProgress?: (msg: string) => void,
  ): Promise<BatchSummary[]> {
    const batches: DiscoveredPaper[][] = []
    for (let i = 0; i < papers.length; i += BATCH_SIZE) {
      batches.push(papers.slice(i, i + BATCH_SIZE))
    }

    const MAP_CONCURRENCY = 4
    const results: BatchSummary[] = []

    for (let i = 0; i < batches.length; i += MAP_CONCURRENCY) {
      const chunk = batches.slice(i, i + MAP_CONCURRENCY)
      const promises = chunk.map(async (batch, j) => {
        const batchIndex = i + j
        const batchSummaryInput = buildPapersSummary(batch, acquired)

        onProgress?.(
          `  Summarizing batch ${batchIndex + 1}/${batches.length} (${batch.length} papers)...`,
        )

        const summary = await this.callLLM(
          `You are an expert academic researcher creating a structured summary of a batch of papers.
Analyze the provided papers and produce a comprehensive summary covering:
1. **Key themes and topics** across these papers
2. **Methods and approaches** used (with specific paper mentions)
3. **Main findings and contributions** (with specific paper mentions)
4. **Research gaps** identified or implied
5. **Connections between papers** — how they relate, cite, or build on each other

Be specific: mention paper titles, author names, and years. This summary will be combined with other batch summaries for a final literature analysis, so preserve important details.`,
          `Summarize the following batch of ${batch.length} papers:\n\n${batchSummaryInput}`,
        )

        return {
          batch_index: batchIndex,
          paper_count: batch.length,
          paper_titles: batch.map(p => p.title),
          summary,
        } satisfies BatchSummary
      })

      const batchResults = await Promise.all(promises)
      results.push(...batchResults)
    }

    return results.sort((a, b) => a.batch_index - b.batch_index)
  }

  /**
   * Intermediate reduce: when combined batch summaries are too large,
   * group them into super-batches and synthesize each.
   */
  private async intermediateReduce(
    batchSummaries: BatchSummary[],
    onProgress?: (msg: string) => void,
  ): Promise<string> {
    const SUPER_BATCH_SIZE = 4
    const superBatches: BatchSummary[][] = []
    for (let i = 0; i < batchSummaries.length; i += SUPER_BATCH_SIZE) {
      superBatches.push(batchSummaries.slice(i, i + SUPER_BATCH_SIZE))
    }

    const reducedSummaries: string[] = []

    for (let i = 0; i < superBatches.length; i++) {
      const superBatch = superBatches[i]
      const totalPapers = superBatch.reduce(
        (sum, bs) => sum + bs.paper_count,
        0,
      )

      onProgress?.(
        `  Reducing super-batch ${i + 1}/${superBatches.length} (${totalPapers} papers)...`,
      )

      const input = superBatch
        .map(
          bs =>
            `## Batch ${bs.batch_index + 1} (${bs.paper_count} papers)\n${bs.summary}`,
        )
        .join('\n\n---\n\n')

      const reduced = await this.callLLM(
        `You are an expert academic researcher synthesizing multiple literature batch summaries into a unified analysis.
Combine the provided batch summaries into a single coherent summary. Preserve:
- Key themes, methods, and findings with specific paper references
- Research gaps and connections between papers
- Any conflicting findings or methodological debates
Remove redundancy but keep important details.`,
        `Synthesize the following ${superBatch.length} batch summaries covering ${totalPapers} papers:\n\n${input}`,
      )

      reducedSummaries.push(reduced)
    }

    return reducedSummaries.join('\n\n---\n\n')
  }

  /**
   * Generate related_work LaTeX fragments from the analysis reports.
   * Call after analyze() has written survey.md and gaps.md.
   */
  async generateFragments(
    store: FragmentStore,
    bibPath: string,
  ): Promise<void> {
    const litDir = join(this.projectDir, 'literature')
    const surveyPath = join(litDir, 'survey.md')
    const gapsPath = join(litDir, 'gaps.md')

    // Idempotency: remove previous deep-research fragments before creating new ones
    const existing = store
      .list('related_work')
      .filter(f => f.created_by === 'deep-research')
    for (const f of existing) {
      store.delete(f.id)
    }

    // Read bib file for citation keys
    const bibContent = existsSync(bibPath) ? readFileSync(bibPath, 'utf-8') : ''

    // Generate literature survey fragment
    if (existsSync(surveyPath)) {
      const surveyMd = readFileSync(surveyPath, 'utf-8')
      const surveyLatex = await this.callLLM(
        FRAGMENT_SYSTEM_PROMPT,
        `Convert the following Markdown literature survey into a LaTeX \\section{Related Work} fragment.
Use \\cite{key} for citations where keys match the provided .bib entries.
Group related papers thematically. Be concise and academic in tone.

## BibTeX entries (use these keys for \\cite{})
${bibContent.slice(0, 20000)}

## Literature Survey (Markdown)
${surveyMd.slice(0, 40000)}`,
      )

      const surveyMeta = store.create(
        'related_work',
        'Literature Survey',
        surveyLatex,
        {
          created_by: 'deep-research',
          notes: 'Auto-generated from deep-research survey analysis',
          estimated_pages: 1.5,
        },
      )
      store.assignToSection('Related Work', surveyMeta.id)
    }

    // Generate research gaps fragment
    if (existsSync(gapsPath)) {
      const gapsMd = readFileSync(gapsPath, 'utf-8')
      const gapsLatex = await this.callLLM(
        FRAGMENT_SYSTEM_PROMPT,
        `Convert the following Markdown research gaps analysis into a LaTeX fragment
suitable for a "Research Gaps and Positioning" subsection. Use \\cite{key} where appropriate.
Focus on open problems and how the current work addresses them.

## BibTeX entries (use these keys for \\cite{})
${bibContent.slice(0, 20000)}

## Research Gaps (Markdown)
${gapsMd.slice(0, 40000)}`,
      )

      const gapsMeta = store.create(
        'related_work',
        'Research Gaps and Positioning',
        gapsLatex,
        {
          created_by: 'deep-research',
          notes: 'Auto-generated from deep-research gaps analysis',
          estimated_pages: 1.0,
        },
      )
      store.assignToSection('Related Work', gapsMeta.id)
    }
  }

  private async callLLM(
    systemPrompt: string,
    userContent: string,
  ): Promise<string> {
    const response = await chatCompletion({
      modelSpec: this.modelName,
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    })
    return response.text
  }

  private async writeSurvey(
    litDir: string,
    papersSummary: string,
    topic: string,
  ): Promise<void> {
    const system = `You are an expert academic researcher writing a structured literature survey.
Write a comprehensive literature survey in Markdown with these sections:
1. Overview - Field summary and scope
2. Key Papers - Most influential works with brief descriptions
3. Methodology Comparison - How different papers approach the problem
4. Findings - Key results and conclusions across the literature

Be specific, cite paper titles, and provide actionable insights.`

    const content = await this.callLLM(
      system,
      `Write a literature survey for the following ${topic}:\n\n${papersSummary}`,
    )

    writeFileSync(join(litDir, 'survey.md'), content, 'utf-8')
  }

  private async writeGaps(
    litDir: string,
    papersSummary: string,
    topic: string,
  ): Promise<void> {
    const system = `You are an expert academic researcher identifying research gaps.
Analyze the provided papers and identify research gaps. Write a Markdown document with:
1. A numbered list of research gaps, ranked by potential impact/value
2. For each gap: description, why it matters, what existing work misses, and suggested directions
3. A section on methodological limitations in current work
4. Emerging opportunities not yet explored

Be specific and actionable.`

    const content = await this.callLLM(
      system,
      `Identify research gaps from the following ${topic}:\n\n${papersSummary}`,
    )

    writeFileSync(join(litDir, 'gaps.md'), content, 'utf-8')
  }

  private async writeTaxonomy(
    litDir: string,
    papersSummary: string,
    topic: string,
  ): Promise<void> {
    const system = `You are an expert academic researcher creating a paper taxonomy.
Classify the provided papers by methodology and approach. Write a Markdown document with:
1. A taxonomy tree or table classifying papers by their primary methodology
2. Categories such as: theoretical, empirical, simulation-based, survey/review, applied
3. Sub-categories based on specific techniques (e.g., deep learning, statistical, optimization)
4. A brief explanation of each category and the papers that belong to it
5. Cross-cutting themes that appear across multiple categories

Format clearly with headers and tables where appropriate.`

    const content = await this.callLLM(
      system,
      `Create a taxonomy for the following ${topic}:\n\n${papersSummary}`,
    )

    writeFileSync(join(litDir, 'taxonomy.md'), content, 'utf-8')
  }

  private async writeTimeline(
    litDir: string,
    papersSummary: string,
    topic: string,
  ): Promise<void> {
    const system = `You are an expert academic researcher tracing the chronological development of a research field.
Analyze the provided papers and write a chronological timeline document in Markdown with:
1. A year-by-year or period-by-period narrative of how the field evolved
2. Key milestones and breakthrough papers for each period
3. How ideas built upon each other over time
4. Shifts in methodology or focus across time periods
5. Current state of the art and trajectory

Format with clear year/period headers. Be narrative and analytical, not just a list.`

    const content = await this.callLLM(
      system,
      `Write a chronological development timeline for the following ${topic}:\n\n${papersSummary}`,
    )

    writeFileSync(join(litDir, 'timeline.md'), content, 'utf-8')
  }
}
