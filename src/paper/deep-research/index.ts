import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'fs'
import { join } from 'path'
import { ResearchPlanner } from './planner'
import { PaperDiscovery } from './discovery'
import { LiteratureAnalyzer } from './analyzer'
import { PaperAcquisitionChain } from '../acquisition'
import { FragmentStore } from '../fragment-store'
import {
  BibTeXManager,
  formatBibTeX,
  generateKey,
  type BibTeXEntry,
} from '../writing/bibtex-manager'
import { pdfExtractor } from '../pdf-extractor'
import { ChunkSearchIndex } from '../chunk-index'
import { PythonEnv } from '../python-env'
import type {
  DeepResearchOptions,
  DeepResearchResult,
  DiscoveredPaper,
  AcquisitionResult,
  ResearchPlan,
} from './types'

import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import { extractModelId } from '../agent-dispatch'

const DEFAULT_MODEL = extractModelId(DEFAULT_MODEL_ASSIGNMENTS.research)

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim()
}

export type ProgressEvent =
  | { type: 'phase'; phase: number; message: string }
  | {
      type: 'plan_ready'
      plan: ResearchPlan
    }
  | {
      type: 'discovery_update'
      found: number
      target: number
      sources: { arxiv: number; s2: number; other: number }
      latest?: {
        title: string
        authors: string
        year: number
        citations: number
      }
    }
  | {
      type: 'acquisition_update'
      done: number
      total: number
      downloaded: number
      oa: number
      failed: number
      current?: string
    }
  | { type: 'analysis_update'; report: string }
  | { type: 'detail'; message: string }
  | { type: 'error'; message: string }

export class DeepResearchEngine {
  private projectDir: string
  private options: DeepResearchOptions
  private litDir: string

  constructor(projectDir: string, options: DeepResearchOptions) {
    this.projectDir = projectDir
    this.options = options
    this.litDir = join(projectDir, 'literature')
  }

  async run(
    topic: string,
    onProgress: (msg: string) => void,
    onEvent?: (event: ProgressEvent) => void,
  ): Promise<DeepResearchResult> {
    const papersDir = join(this.litDir, 'papers')
    mkdirSync(papersDir, { recursive: true })

    const emit = (event: ProgressEvent) => {
      onEvent?.(event)
      // Also emit string for backward compat
      if (event.type === 'phase') onProgress(event.message)
      else if (event.type === 'detail') onProgress(event.message)
      else if (event.type === 'error') onProgress(`ERROR: ${event.message}`)
    }

    const model = DEFAULT_MODEL

    // ── Continuation detection ──────────────────────────────
    const isContinuation = !!(
      this.options.continue_from &&
      existsSync(join(this.litDir, 'discovered-papers.json'))
    )
    const { prevPapers, prevAcquired, prevPlan } = isContinuation
      ? this.loadPreviousRound()
      : { prevPapers: [], prevAcquired: [], prevPlan: null }

    if (isContinuation) {
      emit({
        type: 'detail',
        message: `  Continuing from previous round: ${prevPapers.length} papers, ${prevAcquired.length} acquired`,
      })
    }

    // ── Phase 1: Plan ─────────────────────────────────────
    emit({
      type: 'phase',
      phase: 1,
      message: 'Phase 1/4: Planning research strategy...',
    })
    let plan: ResearchPlan

    if (isContinuation && prevPlan && !this.options.extend_discovery) {
      // Reuse previous plan for --continue without --extend
      plan = prevPlan
      emit({
        type: 'detail',
        message: '  Reusing previous research plan',
      })
    } else {
      try {
        const planner = new ResearchPlanner(model)
        plan = await planner.plan(topic, this.options)
      } catch (err: any) {
        emit({ type: 'error', message: `Planning failed: ${err.message}` })
        throw err
      }
    }

    const planPath = join(this.litDir, 'research-plan.json')
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8')
    emit({
      type: 'detail',
      message: `  Plan: ${plan.dimensions.length} dimensions, ${plan.key_authors.length} key authors`,
    })
    emit({ type: 'plan_ready', plan })

    // ── Phase 2: Discover ─────────────────────────────────
    emit({
      type: 'phase',
      phase: 2,
      message:
        'Phase 2/4: Discovering papers across arXiv + Semantic Scholar...',
    })
    let papers: DiscoveredPaper[]

    if (isContinuation && !this.options.extend_discovery) {
      // --continue without --extend: skip discovery, reuse previous papers
      papers = prevPapers
      emit({
        type: 'detail',
        message: `  Reusing ${papers.length} previously discovered papers`,
      })
    } else {
      let newPapers: DiscoveredPaper[]
      try {
        const discovery = new PaperDiscovery(this.options)
        newPapers = await discovery.discover(plan)
      } catch (err: any) {
        emit({ type: 'error', message: `Discovery failed: ${err.message}` })
        throw err
      }

      if (isContinuation && this.options.extend_discovery) {
        // --extend: merge new papers with previous
        papers = this.mergePapers(prevPapers, newPapers)
        emit({
          type: 'detail',
          message: `  Extended: ${newPapers.length} new + ${prevPapers.length} previous = ${papers.length} total (after dedup)`,
        })
      } else {
        papers = newPapers
      }
    }

    // Count by source
    const arxivCount = papers.filter(p => p.source === 'arxiv').length
    const s2Count = papers.filter(p => p.source === 'semantic_scholar').length
    const otherCount = papers.length - arxivCount - s2Count
    const highlyRelevant = papers.filter(p => p.relevance_score > 0.8).length

    emit({
      type: 'discovery_update',
      found: papers.length,
      target: this.options.max_papers ?? 100,
      sources: { arxiv: arxivCount, s2: s2Count, other: otherCount },
      latest: papers[0]
        ? {
            title: papers[0].title,
            authors: papers[0].authors.slice(0, 2).join(', '),
            year: papers[0].year,
            citations: papers[0].citation_count,
          }
        : undefined,
    })
    emit({
      type: 'detail',
      message: `  Found ${papers.length} papers (arXiv: ${arxivCount}, S2: ${s2Count}), ${highlyRelevant} highly relevant`,
    })

    const papersListPath = join(this.litDir, 'discovered-papers.json')
    writeFileSync(papersListPath, JSON.stringify(papers, null, 2), 'utf-8')

    // ── Phase 3: Acquire ──────────────────────────────────
    emit({
      type: 'phase',
      phase: 3,
      message: 'Phase 3/4: Acquiring PDFs via multi-source chain...',
    })
    let acquired: AcquisitionResult[]
    try {
      acquired = await this.acquirePapers(papers, papersDir, emit, prevAcquired)
    } catch (err: any) {
      emit({ type: 'error', message: `Acquisition failed: ${err.message}` })
      throw err
    }

    const downloadedCount = acquired.filter(
      a => a.status === 'downloaded' || a.status === 'oa_found',
    ).length
    const acquiredPath = join(this.litDir, 'acquired-papers.json')
    writeFileSync(acquiredPath, JSON.stringify(acquired, null, 2), 'utf-8')

    // Generate bibliography.bib
    this.generateBibliography(papers, acquired)

    emit({
      type: 'detail',
      message: `  Acquired ${downloadedCount} PDFs, ${acquired.length - downloadedCount} abstract-only`,
    })

    // ── Phase 3b: Structured extraction + selective vision ─────────
    const extractorAvailable = await pdfExtractor.isAvailable(this.projectDir)
    const chunkIndex = new ChunkSearchIndex(this.litDir)
    const enrichedDir = join(this.litDir, 'enriched')
    mkdirSync(enrichedDir, { recursive: true })

    if (extractorAvailable && downloadedCount > 0) {
      emit({
        type: 'detail',
        message: '  Extracting structured content from PDFs...',
      })
      const maxExtractions = this.getMaxExtractions()
      const pdfFiles = existsSync(papersDir)
        ? readdirSync(papersDir)
            .filter(f => f.endsWith('.pdf'))
            .slice(0, maxExtractions)
        : []

      for (const pdfFile of pdfFiles) {
        const pdfPath = join(papersDir, pdfFile)
        const paperId = pdfFile.replace(/\.pdf$/i, '')
        const outputDir = join(papersDir, `${paperId}_extracted`)
        mkdirSync(outputDir, { recursive: true })

        try {
          // Extract structured Markdown + render figure pages
          let extraction = await pdfExtractor.extract(
            pdfPath,
            paperId,
            outputDir,
            this.projectDir,
          )

          // Selective vision analysis on figure pages
          if (extraction.figures.length > 0) {
            extraction = await pdfExtractor.analyzeFiguresWithVision(extraction)
          }

          // Write enriched text for PaperQA2 indexing
          const { enrichedPath } = await pdfExtractor.writeIndexableOutput(
            extraction,
            outputDir,
          )

          // Copy enriched.md to the central enriched dir for PaperQA2
          const enrichedText = readFileSync(enrichedPath, 'utf-8')
          writeFileSync(
            join(enrichedDir, `${paperId}.md`),
            enrichedText,
            'utf-8',
          )

          // Add to local chunk index — prefer discovered paper metadata over PDF metadata
          const matchingPaper = papers.find(
            p =>
              p.title.toLowerCase().includes(paperId.toLowerCase()) ||
              paperId.includes(p.arxiv_id ?? '__none__'),
          )
          chunkIndex.addPaper(
            paperId,
            {
              title: matchingPaper?.title ?? extraction.metadata.title,
              authors: matchingPaper?.authors ?? extraction.metadata.authors,
              year: matchingPaper?.year ?? extraction.metadata.year,
              chunk_count: extraction.chunks.length,
            },
            extraction.chunks,
          )

          emit({
            type: 'detail',
            message: `  Extracted: ${extraction.metadata.title.slice(0, 60)} (${extraction.chunks.length} chunks, ${extraction.figures.length} figures)`,
          })
        } catch (err: any) {
          emit({
            type: 'detail',
            message: `  Failed to extract ${pdfFile}: ${err?.message ?? 'unknown error'}`,
          })
        }
      }

      const indexMeta = chunkIndex.getMeta()
      emit({
        type: 'detail',
        message: `  Chunk index: ${Object.keys(indexMeta.papers).length} papers, ${indexMeta.total_chunks} chunks`,
      })
    }

    // ── Phase 3c: PaperQA2 indexing (uses enriched text) ─────────
    try {
      const pqaIndexDir = join(this.litDir, 'index')
      // Use enriched markdown files if available, fall back to raw PDFs
      const indexSourceDir =
        existsSync(enrichedDir) &&
        readdirSync(enrichedDir).filter(f => f.endsWith('.md')).length > 0
          ? enrichedDir
          : papersDir
      const indexFiles = existsSync(indexSourceDir)
        ? readdirSync(indexSourceDir).filter(
            f => f.endsWith('.pdf') || f.endsWith('.md'),
          )
        : []

      if (indexFiles.length > 0) {
        emit({
          type: 'detail',
          message: `  Indexing ${indexFiles.length} documents with PaperQA2...`,
        })
        const env = new PythonEnv(this.projectDir)
        const pqaAvailable = await env.ensurePackage('paper-qa')
        if (pqaAvailable) {
          const pqaBin = env.binPath('pqa')
          const pqaProc = Bun.spawn(
            [
              pqaBin,
              'index',
              '--directory',
              indexSourceDir,
              '--index-directory',
              pqaIndexDir,
            ],
            {
              stdout: 'pipe',
              stderr: 'pipe',
              cwd: this.projectDir,
            },
          )
          await pqaProc.exited
          emit({
            type: 'detail',
            message: '  PaperQA2 index built from enriched text',
          })
        } else {
          emit({
            type: 'detail',
            message:
              '  PaperQA2 auto-install failed — using local chunk index as fallback',
          })
        }
      }
    } catch {
      emit({
        type: 'detail',
        message:
          '  PaperQA2 indexing skipped — local chunk index available as fallback',
      })
    }

    // ── Phase 4: Analyze ──────────────────────────────────
    emit({
      type: 'phase',
      phase: 4,
      message: 'Phase 4/4: Analyzing literature and generating reports...',
    })
    try {
      const analyzer = new LiteratureAnalyzer(this.projectDir, model)

      // Generate reports with map-reduce for large paper sets
      emit({ type: 'analysis_update', report: 'survey' })
      await analyzer.analyzeMapReduce(papers, acquired, msg => {
        emit({ type: 'detail', message: msg })
      })
      emit({ type: 'analysis_update', report: 'complete' })

      // Generate related_work fragments from analysis
      emit({
        type: 'detail',
        message: '  Generating LaTeX fragments for related work...',
      })
      const bibPath = join(this.litDir, 'bibliography.bib')
      const store = new FragmentStore(this.projectDir)
      store.init()
      await analyzer.generateFragments(store, bibPath)
      const fragmentCount = store.list('related_work').length
      emit({
        type: 'detail',
        message: `  Created ${fragmentCount} related_work fragment(s) in fragments/related_work/`,
      })
    } catch (err: any) {
      emit({ type: 'error', message: `Analysis failed: ${err.message}` })
      throw err
    }

    emit({
      type: 'detail',
      message:
        '  Generated: survey.md, gaps.md, taxonomy.md, timeline.md, bibliography.bib + LaTeX fragments',
    })

    return {
      plan,
      papers_found: papers.length,
      papers_acquired: downloadedCount,
      survey_path: join(this.litDir, 'survey.md'),
      gaps_path: join(this.litDir, 'gaps.md'),
      taxonomy_path: join(this.litDir, 'taxonomy.md'),
      timeline_path: join(this.litDir, 'timeline.md'),
      index_dir: this.litDir,
    }
  }

  // ── Continuation helpers ──────────────────────────────────

  private loadPreviousRound(): {
    prevPapers: DiscoveredPaper[]
    prevAcquired: AcquisitionResult[]
    prevPlan: ResearchPlan | null
  } {
    const papersPath = join(this.litDir, 'discovered-papers.json')
    const acquiredPath = join(this.litDir, 'acquired-papers.json')
    const planPath = join(this.litDir, 'research-plan.json')

    let prevPapers: DiscoveredPaper[] = []
    let prevAcquired: AcquisitionResult[] = []
    let prevPlan: ResearchPlan | null = null

    try {
      if (existsSync(papersPath)) {
        prevPapers = JSON.parse(readFileSync(papersPath, 'utf-8'))
      }
    } catch {
      prevPapers = []
    }

    try {
      if (existsSync(acquiredPath)) {
        prevAcquired = JSON.parse(readFileSync(acquiredPath, 'utf-8'))
      }
    } catch {
      prevAcquired = []
    }

    try {
      if (existsSync(planPath)) {
        prevPlan = JSON.parse(readFileSync(planPath, 'utf-8'))
      }
    } catch {
      prevPlan = null
    }

    return { prevPapers, prevAcquired, prevPlan }
  }

  private mergePapers(
    existing: DiscoveredPaper[],
    newPapers: DiscoveredPaper[],
  ): DiscoveredPaper[] {
    const merged = new Map<string, DiscoveredPaper>()

    for (const paper of existing) {
      merged.set(normalizeTitle(paper.title), paper)
    }

    for (const paper of newPapers) {
      const key = normalizeTitle(paper.title)
      const current = merged.get(key)
      if (!current || paper.relevance_score > current.relevance_score) {
        merged.set(key, paper)
      }
    }

    return Array.from(merged.values()).sort(
      (a, b) => b.relevance_score - a.relevance_score,
    )
  }

  private mergeAcquired(
    existing: AcquisitionResult[],
    newResults: AcquisitionResult[],
  ): AcquisitionResult[] {
    const merged = new Map<string, AcquisitionResult>()

    for (const result of existing) {
      merged.set(normalizeTitle(result.paper.title), result)
    }

    for (const result of newResults) {
      const key = normalizeTitle(result.paper.title)
      const current = merged.get(key)
      if (!current) {
        merged.set(key, result)
      } else if (
        current.status === 'abstract_only' &&
        (result.status === 'downloaded' || result.status === 'oa_found')
      ) {
        // Upgrade: previously abstract_only but now have PDF
        merged.set(key, result)
      }
    }

    return Array.from(merged.values())
  }

  private async acquirePapers(
    papers: DiscoveredPaper[],
    papersDir: string,
    emit: (event: ProgressEvent) => void,
    prevAcquired: AcquisitionResult[] = [],
  ): Promise<AcquisitionResult[]> {
    const maxDownloads = this.getMaxDownloads()

    // Build set of already-acquired titles to skip
    const alreadyAcquiredTitles = new Set(
      prevAcquired
        .filter(a => a.status === 'downloaded' || a.status === 'oa_found')
        .map(a => normalizeTitle(a.paper.title)),
    )

    // Filter out papers already acquired with PDFs
    const papersToAcquire = papers
      .filter(p => !alreadyAcquiredTitles.has(normalizeTitle(p.title)))
      .slice(0, maxDownloads)

    if (papersToAcquire.length === 0 && prevAcquired.length > 0) {
      emit({
        type: 'detail',
        message: `  All ${prevAcquired.length} papers already acquired, skipping downloads`,
      })
      return prevAcquired
    }

    let downloaded = 0
    let oa = 0
    let failed = 0

    const chain = new PaperAcquisitionChain({
      output_dir: papersDir,
      ezproxy_url: this.options.ezproxy_url,
      scihub_enabled: this.options.scihub_enabled,
      scihub_mirrors: this.options.scihub_mirrors,
      unpaywall_email: this.options.unpaywall_email,
    })
    const chainResults = await chain.acquireBatch(
      papersToAcquire.map(p => ({
        title: p.title,
        doi: p.doi,
        arxiv_id: p.arxiv_id,
        s2_paper_id: p.s2_paper_id,
        ssrn_id: p.ssrn_id,
        pdf_url: p.pdf_url,
        year: p.year,
      })),
      (done, total, title) => {
        // Update counters
        emit({
          type: 'acquisition_update',
          done,
          total,
          downloaded,
          oa,
          failed,
          current: title ? `Downloading: ${title.slice(0, 50)}...` : undefined,
        })
      },
    )

    const newResults: AcquisitionResult[] = chainResults.map((cr, i) => {
      if (cr.success) {
        if (cr.source_used === 'unpaywall' || cr.source_used === 's2_oa') {
          oa++
        } else {
          downloaded++
        }
      } else {
        failed++
      }
      return {
        paper: papersToAcquire[i],
        status: cr.success
          ? cr.source_used === 'unpaywall' || cr.source_used === 's2_oa'
            ? ('oa_found' as const)
            : ('downloaded' as const)
          : ('abstract_only' as const),
        pdf_path: cr.pdf_path,
        source_used: cr.source_used,
      }
    })

    // Add abstract_only entries for papers beyond max downloads that weren't previously acquired
    const acquiredTitlesNow = new Set(
      papersToAcquire.map(p => normalizeTitle(p.title)),
    )
    for (const paper of papers) {
      const key = normalizeTitle(paper.title)
      if (!alreadyAcquiredTitles.has(key) && !acquiredTitlesNow.has(key)) {
        newResults.push({ paper, status: 'abstract_only' })
      }
    }

    // Merge with previous results
    return this.mergeAcquired(prevAcquired, newResults)
  }

  private generateBibliography(
    papers: DiscoveredPaper[],
    _acquired: AcquisitionResult[],
  ): void {
    const bibPath = join(this.litDir, 'bibliography.bib')
    const manager = new BibTeXManager(bibPath)
    for (const paper of papers) {
      const key = generateKey(
        paper.authors.length > 0 ? paper.authors : ['unknown'],
        paper.year,
        paper.title,
      )
      const entry: BibTeXEntry = {
        key,
        type: 'article',
        title: paper.title,
        authors: paper.authors.length > 0 ? paper.authors : ['Unknown'],
        year: paper.year,
        doi: paper.doi || undefined,
        arxiv_id: paper.arxiv_id || undefined,
        url: paper.url || undefined,
      }
      if (!manager.hasKey(entry.key)) {
        manager.appendRawEntry(formatBibTeX(entry))
      }
    }
  }

  private getMaxDownloads(): number {
    const depth = this.options.depth ?? 'standard'
    switch (depth) {
      case 'quick':
        return 30
      case 'thorough':
        return 100
      default:
        return 50
    }
  }

  private getMaxExtractions(): number {
    const depth = this.options.depth ?? 'standard'
    switch (depth) {
      case 'quick':
        return 10
      case 'standard':
        return 30
      case 'thorough':
        return 100
    }
  }
}

export default DeepResearchEngine
