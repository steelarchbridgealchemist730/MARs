import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { LaTeXEngine } from './latex-engine'
import type {
  PaperOutline,
  NarrativePlan,
  NarrativeSectionPlan,
  SectionMaterials,
  ClaimMaterial,
  EvidenceMaterial,
  PostProcessResult,
  FigureOutput,
  TableOutput,
} from './types'
import type { VenueConstraints } from './template-types'
import { chatCompletion } from '../llm-client'
import { TemplateResolver } from './template-resolver'
import { BibTeXManager } from './bibtex-manager'
import { ClaimGraph } from '../claim-graph/index'
import { EvidencePoolManager } from '../evidence-pool'
import { FragmentStore } from '../fragment-store'
import { FigureDesigner, extractPackageDependencies } from './figure-designer'
import type { ResearchState } from '../research-state'

const resolver = new TemplateResolver()

function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n... (truncated)'
}

/**
 * Estimate words per page based on venue formatting.
 * ~700 for 2-column 10pt, ~350 for 1-column 12pt.
 */
function wordsPerPage(constraints: VenueConstraints | null): number {
  if (!constraints) return 500
  const cols = constraints.formatting.columns
  const fontSize = constraints.formatting.font_size
  if (cols === 2 && fontSize.includes('10')) return 700
  if (cols === 1 && fontSize.includes('12')) return 350
  if (cols === 2) return 650
  return 500
}

export class PaperWriter {
  private projectDir: string
  private modelName: string
  private bibPath: string | null

  constructor(projectDir: string, modelName: string, bibPath?: string) {
    this.projectDir = projectDir
    this.modelName = modelName
    this.bibPath = bibPath ?? null
  }

  async createOutline(
    proposal: any,
    experimentResults?: any,
  ): Promise<PaperOutline> {
    const systemPrompt = `You are an expert academic paper planner. Given a research proposal and optional experiment results, create a detailed paper outline for a machine learning / computer science research paper. Return a JSON object with exactly this structure:
{
  "title": "string",
  "authors": ["string"],
  "venue": "string (e.g. NeurIPS 2026)",
  "template": "neurips",
  "sections": [
    { "name": "abstract", "title": "Abstract", "word_budget": 250 },
    { "name": "introduction", "title": "Introduction", "word_budget": 2000 },
    { "name": "related-work", "title": "Related Work", "word_budget": 2500 },
    { "name": "methodology", "title": "Methodology", "word_budget": 3000 },
    { "name": "experiments", "title": "Experiments", "word_budget": 2500 },
    { "name": "results", "title": "Results", "word_budget": 2000 },
    { "name": "conclusion", "title": "Conclusion", "word_budget": 800 }
  ],
  "figures": [
    { "id": "fig1", "caption": "string", "type": "matplotlib", "description": "string" }
  ],
  "tables": [
    { "id": "tab1", "caption": "string", "description": "string" }
  ],
  "estimated_pages": number
}
Return ONLY the JSON object, no markdown fences or extra text.`

    const proposalText =
      typeof proposal === 'string'
        ? proposal
        : JSON.stringify(proposal, null, 2)
    const resultsText = experimentResults
      ? `\n\nExperiment Results:\n${typeof experimentResults === 'string' ? experimentResults : JSON.stringify(experimentResults, null, 2)}`
      : ''

    const userContent = `Create a paper outline for the following research proposal:

${truncate(proposalText, 16000)}${truncate(resultsText, 8000)}`

    const response = await chatCompletion({
      modelSpec: this.modelName,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    })

    const rawText = response.text || '{}'

    let parsed: Partial<PaperOutline>
    try {
      parsed = JSON.parse(rawText) as Partial<PaperOutline>
    } catch {
      const match = rawText.match(/\{[\s\S]*\}/)
      if (match) {
        try {
          parsed = JSON.parse(match[0]) as Partial<PaperOutline>
        } catch {
          parsed = {}
        }
      } else {
        parsed = {}
      }
    }

    const outline: PaperOutline = {
      title: parsed.title ?? proposal?.title ?? 'Research Paper',
      authors: parsed.authors ?? ['Anonymous'],
      venue: parsed.venue ?? 'NeurIPS 2026',
      template: parsed.template ?? 'neurips',
      sections: parsed.sections ?? [
        { name: 'abstract', title: 'Abstract', word_budget: 250 },
        { name: 'introduction', title: 'Introduction', word_budget: 2000 },
        { name: 'related-work', title: 'Related Work', word_budget: 2500 },
        { name: 'methodology', title: 'Methodology', word_budget: 3000 },
        { name: 'experiments', title: 'Experiments', word_budget: 2500 },
        { name: 'results', title: 'Results', word_budget: 2000 },
        { name: 'conclusion', title: 'Conclusion', word_budget: 800 },
      ],
      figures: parsed.figures ?? [],
      tables: parsed.tables ?? [],
      estimated_pages: parsed.estimated_pages ?? 8,
    }

    return outline
  }

  async writeSection(
    outline: PaperOutline,
    sectionName: string,
    context: string,
  ): Promise<string> {
    const section = outline.sections.find(s => s.name === sectionName)
    const sectionTitle = section?.title ?? sectionName
    const wordBudget = section?.word_budget ?? 400

    const systemPrompt = `You are an expert academic writer specializing in machine learning and computer science papers. Write a section of a research paper in LaTeX format. Follow these rules:
- Write clean, well-structured LaTeX
- Do NOT include \\documentclass, \\begin{document}, or \\end{document}
- Do NOT include \\section{} — just the content below it (the caller wraps it)
- Use \\subsection{} and \\subsubsection{} as needed
- Use \\cite{} for references where appropriate (use placeholder keys like authorYEAR)
- Aim for approximately ${wordBudget} words
- Be technically precise and academically rigorous
Return ONLY the LaTeX content for this section, no markdown fences.`

    const userContent = `Write the "${sectionTitle}" section for the following paper.

Paper Title: ${outline.title}
Venue: ${outline.venue}

Context and notes:
${truncate(context, 24000)}

Write the complete LaTeX content for the ${sectionTitle} section.`

    const response = await chatCompletion({
      modelSpec: this.modelName,
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    })

    const rawText = response.text

    // Strip markdown fences if present
    return rawText
      .replace(/^```(?:latex|tex)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim()
  }

  async writePaper(
    outline: PaperOutline,
    experimentResultsDir?: string,
  ): Promise<string> {
    const paperDir = join(this.projectDir, 'paper')
    const sectionsDir = join(paperDir, 'sections')

    mkdirSync(sectionsDir, { recursive: true })

    // Copy template
    let templateDir: string
    try {
      templateDir = resolver.getTemplateDir(outline.template)
    } catch {
      templateDir = ''
    }
    if (templateDir && existsSync(templateDir)) {
      this.copyDir(templateDir, paperDir)
    }

    // Gather experiment results context
    let resultsContext = ''
    if (experimentResultsDir && existsSync(experimentResultsDir)) {
      const files = readdirSync(experimentResultsDir).slice(0, 10)
      const snippets: string[] = []
      for (const f of files) {
        const fPath = join(experimentResultsDir, f)
        const content = readFileSafe(fPath)
        if (content) {
          snippets.push(`=== ${f} ===\n${truncate(content, 2000)}`)
        }
      }
      resultsContext = snippets.join('\n\n')
    }

    // Build shared context for all sections
    const sharedContext = [
      `Title: ${outline.title}`,
      `Authors: ${outline.authors.join(', ')}`,
      `Venue: ${outline.venue}`,
      outline.figures.length > 0
        ? `Figures planned: ${outline.figures.map(f => `${f.id}: ${f.caption}`).join('; ')}`
        : '',
      outline.tables.length > 0
        ? `Tables planned: ${outline.tables.map(t => `${t.id}: ${t.caption}`).join('; ')}`
        : '',
      resultsContext ? `Experiment Results:\n${resultsContext}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    // Write each section, passing previously-written sections as context
    const completedSections: string[] = []
    const previousSections: string[] = []

    for (const section of outline.sections) {
      // Build section-specific context including previous sections
      const sectionContext = [
        sharedContext,
        previousSections.length > 0
          ? `\n\nPreviously written sections (for continuity — do NOT repeat content):\n${previousSections.join('\n\n---\n\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')

      const sectionContent = await this.writeSection(
        outline,
        section.name,
        sectionContext,
      )

      const sectionFile = join(sectionsDir, `${section.name}.tex`)
      const sectionTex = `\\section{${section.title}}\n\n${sectionContent}\n`
      writeFileSync(sectionFile, sectionTex, 'utf-8')
      completedSections.push(section.name)

      // Accumulate for subsequent sections (truncate each to keep context manageable)
      previousSections.push(
        `[${section.title}]\n${sectionContent.slice(0, 3000)}`,
      )
    }

    // Update main.tex with title, authors, and correct section inputs
    const mainTexPath = join(paperDir, 'main.tex')
    if (existsSync(mainTexPath)) {
      let mainTex = readFileSync(mainTexPath, 'utf-8')

      // Update title
      mainTex = mainTex.replace(/\\title\{[^}]*\}/, `\\title{${outline.title}}`)

      // Update authors
      const authorLines = outline.authors
        .map(a => `  ${a} \\\\`)
        .join('\n  \\And\n')
      mainTex = mainTex.replace(
        /\\author\{[\s\S]*?\n\}/,
        `\\author{\n${authorLines}\n}`,
      )

      // Rebuild section inputs to match outline
      const sectionInputs = outline.sections
        .map(s => `\\input{sections/${s.name}}`)
        .join('\n')

      // Replace all existing \input{sections/...} lines
      mainTex = mainTex.replace(
        /(?:\\input\{sections\/[^}]+\}\s*\n?)+/,
        sectionInputs + '\n',
      )

      writeFileSync(mainTexPath, mainTex, 'utf-8')
    }

    // Compile (legacy path — no manifest available)
    const engine = new LaTeXEngine(this.projectDir)
    await engine.compileAndFix(mainTexPath, this.modelName)

    const pdfPath = mainTexPath.replace(/\.tex$/, '.pdf')
    return existsSync(pdfPath) ? pdfPath : mainTexPath
  }

  // ── Narrative-plan-driven writing ──────────────────────

  /**
   * Write a paper from a NarrativePlan (claim-driven, venue-aware).
   * This is an additive method — existing writePaper()/createOutline() are unchanged.
   *
   * When `state` is provided, section prompts are enriched with full claim
   * statements, evidence descriptions, experiment data, and existing fragments.
   * Post-processing validates cite keys (via BibTeXManager) and checks word count.
   */
  async writePaperFromPlan(
    plan: NarrativePlan,
    constraints: VenueConstraints | null,
    proposal: { title: string; authors?: string[]; template?: string },
    state?: ResearchState,
  ): Promise<string> {
    const paperDir = join(this.projectDir, 'paper')
    const sectionsDir = join(paperDir, 'sections')
    mkdirSync(sectionsDir, { recursive: true })

    // Copy template
    const templateId = proposal.template ?? 'neurips'
    let templateDir: string
    try {
      templateDir = resolver.getTemplateDir(templateId)
    } catch {
      templateDir = ''
    }
    if (templateDir && existsSync(templateDir)) {
      this.copyDir(templateDir, paperDir)
    }

    // Create BibTeXManager if bib path is available
    const bibPath = this.bibPath ?? join(paperDir, 'bibliography.bib')
    const bibManager = existsSync(bibPath) ? new BibTeXManager(bibPath) : null

    // Build shared context from narrative arc
    const arc = plan.narrative_arc
    const sharedContext = [
      `Title: ${proposal.title}`,
      `Authors: ${(proposal.authors ?? ['Anonymous']).join(', ')}`,
      `Narrative arc:`,
      `  Hook: ${arc.hook}`,
      `  Gap: ${arc.gap}`,
      `  Insight: ${arc.insight}`,
      `  Method: ${arc.method_summary}`,
      `  Evidence: ${arc.evidence_summary}`,
      `  Nuance: ${arc.nuance}`,
      plan.hero_figure
        ? `Hero figure: ${plan.hero_figure.description} (placement: ${plan.hero_figure.placement})`
        : '',
      plan.main_table
        ? `Main table: ${plan.main_table.content} (placement: ${plan.main_table.placement})`
        : '',
    ]
      .filter(Boolean)
      .join('\n')

    // Write each section sequentially for continuity
    const previousSections: string[] = []
    const allWarnings: string[] = []

    for (const sectionPlan of plan.sections) {
      // 1. Gather materials from research state
      const materials = state ? this.gatherMaterials(sectionPlan, state) : null

      // 2. Write section with enriched context
      let content = await this.writeSectionFromPlan(
        sectionPlan,
        constraints,
        sharedContext,
        previousSections,
        materials,
      )

      // 3. Post-process: cite validation + word count
      const { latex, warnings } = await postProcessSection(
        content,
        sectionPlan,
        constraints,
        bibManager,
      )
      content = latex
      allWarnings.push(...warnings)

      const sectionFile = join(sectionsDir, `${sectionPlan.name}.tex`)
      const sectionTex = `\\section{${sectionPlan.title}}\n\n${content}\n`
      writeFileSync(sectionFile, sectionTex, 'utf-8')

      previousSections.push(`[${sectionPlan.title}]\n${content.slice(0, 3000)}`)
    }

    // Phase 4: Generate hero figure and main table
    const allFigureDeps: string[] = []
    const figureDesigner = new FigureDesigner(this.projectDir, this.modelName)

    if (plan.hero_figure) {
      const figureMaterials = figureDesigner.gatherFigureMaterials(
        plan,
        state ?? null,
      )
      try {
        const heroFigure = await figureDesigner.designHeroFigure(
          plan.hero_figure,
          figureMaterials,
          constraints,
        )
        allFigureDeps.push(...heroFigure.dependencies)
        this.injectFigureIntoSection(
          plan.hero_figure.placement,
          heroFigure,
          sectionsDir,
        )
      } catch {
        allWarnings.push('Failed to generate hero figure')
      }
    }

    if (plan.main_table) {
      const tableMaterials = figureDesigner.gatherFigureMaterials(
        plan,
        state ?? null,
      )
      try {
        const mainTable = await figureDesigner.designMainTable(
          plan.main_table,
          tableMaterials,
          constraints,
        )
        allFigureDeps.push(...mainTable.dependencies)
        this.injectTableIntoSection(
          plan.main_table.placement,
          mainTable,
          sectionsDir,
        )
      } catch {
        allWarnings.push('Failed to generate main table')
      }
    }

    // Ensure figure/table packages in main.tex
    const mainTexForPkgs = join(this.projectDir, 'paper', 'main.tex')
    if (allFigureDeps.length > 0 && existsSync(mainTexForPkgs)) {
      this.ensurePackages(mainTexForPkgs, allFigureDeps)
    }

    // Sync bibliography from literature bib if available
    if (bibManager) {
      const litBibPath = join(this.projectDir, 'bibliography.bib')
      if (existsSync(litBibPath) && litBibPath !== bibPath) {
        await bibManager.syncFromLiterature(litBibPath, paperDir)
      }
    }

    // Update main.tex
    const mainTexPath = join(paperDir, 'main.tex')
    if (existsSync(mainTexPath)) {
      let mainTex = readFileSync(mainTexPath, 'utf-8')

      mainTex = mainTex.replace(
        /\\title\{[^}]*\}/,
        `\\title{${proposal.title}}`,
      )

      const authorLines = (proposal.authors ?? ['Anonymous'])
        .map(a => `  ${a} \\\\`)
        .join('\n  \\And\n')
      mainTex = mainTex.replace(
        /\\author\{[\s\S]*?\n\}/,
        `\\author{\n${authorLines}\n}`,
      )

      const sectionInputs = plan.sections
        .map(s => `\\input{sections/${s.name}}`)
        .join('\n')
      mainTex = mainTex.replace(
        /(?:\\input\{sections\/[^}]+\}\s*\n?)+/,
        sectionInputs + '\n',
      )

      writeFileSync(mainTexPath, mainTex, 'utf-8')
    }

    // Compile with template-aware engine
    const resolved = (() => {
      try {
        return resolver.resolve(templateId)
      } catch {
        return null
      }
    })()
    const engine = new LaTeXEngine(this.projectDir, {
      manifest: resolved?.manifest ?? null,
      constraints,
      bibManager,
      templateDir: resolved ? resolver.getTemplateDir(templateId) : null,
    })
    await engine.compileAndFix(mainTexPath, this.modelName)

    const pdfPath = mainTexPath.replace(/\.tex$/, '.pdf')
    return existsSync(pdfPath) ? pdfPath : mainTexPath
  }

  /**
   * Write a single section driven by a NarrativeSectionPlan.
   * Richer than writeSection(): includes claims, tone, page budget, must_cite, etc.
   * When `materials` is provided, the prompt includes full claim statements,
   * evidence descriptions, experiment data, and existing fragment previews.
   */
  async writeSectionFromPlan(
    plan: NarrativeSectionPlan,
    constraints: VenueConstraints | null,
    sharedContext: string,
    previousSections: string[],
    materials?: SectionMaterials | null,
  ): Promise<string> {
    const wordBudget = Math.round(plan.page_budget * wordsPerPage(constraints))

    const parts: string[] = [
      `You are an expert academic writer. Write a section of a research paper in LaTeX format.`,
      ``,
      `Rules:`,
      `- Write clean, well-structured LaTeX`,
      `- Do NOT include \\documentclass, \\begin{document}, or \\end{document}`,
      `- Do NOT include \\section{} — just the content below it (the caller wraps it)`,
      `- Use \\subsection{} and \\subsubsection{} as needed`,
      `- Aim for approximately ${wordBudget} words (${plan.page_budget} pages)`,
      `- Tone: ${plan.tone}`,
      `- Be technically precise and academically rigorous`,
      `- Add \\label{sec:${plan.name}} at the very beginning of the section content`,
      ``,
      `CRITICAL RULES:`,
      `1. Every claim must be backed by evidence. State evidence type explicitly: "Theorem 1 shows..." / "Table 1 demonstrates..." / "We observe that..."`,
      `2. Do NOT overclaim. If evidence is "consistent_with", say "consistent with", not "proves".`,
      `3. Use \\cite{key} for ALL factual claims from literature. NO empty citations.`,
      `4. If you reference a figure or table, use \\ref{} — the figure/table must exist.`,
      `5. Proof SKETCHES only in main body. Full proofs go to appendix.`,
      `6. Stay within page budget. ${wordBudget} words MAX.`,
      ``,
      `Return ONLY the LaTeX content for this section, no markdown fences.`,
    ]

    const userParts: string[] = [
      `Write the "${plan.title}" section.`,
      ``,
      sharedContext,
    ]

    // Venue constraints
    if (constraints) {
      const venueLines: string[] = [`\n## Venue Constraints`]
      const fmt = constraints.formatting
      venueLines.push(`Format: ${fmt.columns}-column, ${fmt.font_size}`)
      if (typeof constraints.page_limits.main_body === 'number') {
        venueLines.push(
          `Main body limit: ${constraints.page_limits.main_body} pages`,
        )
      }
      if (fmt.citation_style) {
        venueLines.push(`Citation style: ${fmt.citation_style}`)
      }
      const wg = constraints.writing_guidelines
      if (wg.main_body_strategy) {
        venueLines.push(`Writing strategy: ${wg.main_body_strategy}`)
      }
      if (wg.proof_strategy) {
        venueLines.push(`Proof strategy: ${wg.proof_strategy}`)
      }
      if (wg.related_work_placement) {
        venueLines.push(`Related work placement: ${wg.related_work_placement}`)
      }
      if (wg.figure_strategy) {
        venueLines.push(`Figure strategy: ${wg.figure_strategy}`)
      }
      if (wg.table_strategy) {
        venueLines.push(`Table strategy: ${wg.table_strategy}`)
      }
      if (constraints.common_pitfalls?.length > 0) {
        venueLines.push(
          `Common pitfalls: ${constraints.common_pitfalls.join('; ')}`,
        )
      }
      userParts.push(venueLines.join('\n'))
    }

    // Key points
    if (plan.key_points.length > 0) {
      userParts.push(
        `\nKey points to cover:\n${plan.key_points.map(p => `- ${p}`).join('\n')}`,
      )
    }

    // Claims to support — use full materials when available
    if (materials && materials.claims.length > 0) {
      const claimLines = materials.claims.map(
        c =>
          `- [${c.epistemicLayer}/${c.type}] "${c.statement}" (conf: ${c.confidence.toFixed(2)}, evidence: ${c.evidenceType}) [${c.id}]`,
      )
      userParts.push(`\n## Claims to Support\n${claimLines.join('\n')}`)
    } else if (plan.claims_covered.length > 0) {
      userParts.push(
        `\nClaims this section must support: ${plan.claims_covered.join(', ')}`,
      )
    }

    // Demoted claims — use full materials when available
    if (materials && materials.demotedClaims.length > 0) {
      const demotedLines = materials.demotedClaims.map(
        c =>
          `- [${c.epistemicLayer}/${c.type}] "${c.statement}" (conf: ${c.confidence.toFixed(2)}) [${c.id}]`,
      )
      userParts.push(
        `\n## Demoted Claims (discuss as limitations)\n${demotedLines.join('\n')}`,
      )
    } else if (
      plan.demoted_claims_here &&
      plan.demoted_claims_here.length > 0
    ) {
      userParts.push(
        `\nDemoted claims to discuss as limitations: ${plan.demoted_claims_here.join(', ')}`,
      )
    }

    // Evidence available
    if (materials && materials.evidence.length > 0) {
      const evidenceLines = materials.evidence.map(
        e => `- ${e.claim_id}: ${e.type} — ${e.description}`,
      )
      userParts.push(`\n## Evidence Available\n${evidenceLines.join('\n')}`)
    }

    // Experiment results
    if (materials?.experimentResults) {
      userParts.push(`\n## Experiment Results\n${materials.experimentResults}`)
    }

    // Existing fragments for this section
    if (materials && materials.fragments.length > 0) {
      const fragLines = materials.fragments.map(
        f => `- ${f.id}: "${f.title}" — ${f.preview}`,
      )
      userParts.push(
        `\n## Existing Fragments for This Section\nIncorporate or build upon these:\n${fragLines.join('\n')}`,
      )
    }

    // Related work context
    if (materials?.relatedWork) {
      userParts.push(`\n## Related Work Context\n${materials.relatedWork}`)
    }

    // Must-cite references
    const mustCite = materials?.mustCite ?? plan.must_cite
    if (mustCite && mustCite.length > 0) {
      userParts.push(
        `\nMust cite these references: ${mustCite.map(k => `\\cite{${k}}`).join(', ')}`,
      )
    }

    // Hero figure / main table placement
    if (plan.contains_hero_figure) {
      userParts.push(
        `\nThis section should include placement for the hero figure (use \\begin{figure} with a placeholder).`,
      )
    }
    if (plan.contains_main_table) {
      userParts.push(
        `\nThis section should include placement for the main results table (use \\begin{table} with a placeholder).`,
      )
    }

    // Transition hint
    if (plan.ends_with) {
      userParts.push(`\nEnd the section with a transition: ${plan.ends_with}`)
    }

    // Previous sections for continuity
    if (previousSections.length > 0) {
      userParts.push(
        `\nPreviously written sections (for continuity — do NOT repeat content):\n${previousSections.join('\n\n---\n\n')}`,
      )
    }

    const response = await chatCompletion({
      modelSpec: this.modelName,
      max_tokens: 16384,
      system: parts.join('\n'),
      messages: [{ role: 'user', content: userParts.join('\n') }],
    })

    return response.text
      .replace(/^```(?:latex|tex)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim()
  }

  // ── Material Gathering ──────────────────────────────────

  /**
   * Gather rich materials for a section from the research state.
   * Resolves claim IDs to full objects, collects evidence, reads experiments.
   */
  gatherMaterials(
    plan: NarrativeSectionPlan,
    state: ResearchState,
  ): SectionMaterials {
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)

    // Resolve claims_covered → full ClaimMaterial objects
    const claims: ClaimMaterial[] = []
    for (const id of plan.claims_covered) {
      const claim = graph.getClaim(id)
      if (!claim) continue
      claims.push({
        id: claim.id,
        statement: claim.statement,
        epistemicLayer: claim.epistemicLayer,
        type: claim.type,
        confidence: claim.strength.confidence,
        evidenceType: claim.strength.evidenceType,
      })
    }

    // Resolve demoted_claims_here → full ClaimMaterial objects
    const demotedClaims: ClaimMaterial[] = []
    for (const id of plan.demoted_claims_here ?? []) {
      const claim = graph.getClaim(id)
      if (!claim) continue
      demotedClaims.push({
        id: claim.id,
        statement: claim.statement,
        epistemicLayer: claim.epistemicLayer,
        type: claim.type,
        confidence: claim.strength.confidence,
        evidenceType: claim.strength.evidenceType,
      })
    }

    // Collect evidence for all covered claims
    const evidence: EvidenceMaterial[] = []
    const allClaimIds = [
      ...plan.claims_covered,
      ...(plan.demoted_claims_here ?? []),
    ]
    for (const claimId of allClaimIds) {
      const ev = pool.evidenceFor(claimId)
      for (const g of ev.grounded) {
        evidence.push({
          claim_id: claimId,
          type: 'grounded',
          description: truncate(g.claim || g.source_ref, 200),
        })
      }
      for (const d of ev.derived) {
        evidence.push({
          claim_id: claimId,
          type: 'derived',
          description: truncate(d.claim || d.method, 200),
        })
      }
    }

    // Read experiment results from artifacts
    let experimentResults: string | null = null
    if (plan.experiments_used && plan.experiments_used.length > 0) {
      const expParts: string[] = []
      for (const expId of plan.experiments_used) {
        const artifact = state.artifacts.entries.find(
          e => e.id === expId && e.type === 'experiment_result',
        )
        if (!artifact) continue
        const fullPath = artifact.path.startsWith('/')
          ? artifact.path
          : join(this.projectDir, artifact.path)
        if (existsSync(fullPath)) {
          const raw = readFileSafe(fullPath)
          if (raw) {
            expParts.push(
              `### ${artifact.description} (${expId})\n${truncate(raw, 2000)}`,
            )
          }
        }
      }
      if (expParts.length > 0) {
        experimentResults = expParts.join('\n\n')
      }
    }

    // Read existing fragment previews
    const fragments: Array<{ id: string; title: string; preview: string }> = []
    try {
      const store = new FragmentStore(this.projectDir)
      const structure = store.getPaperStructure()
      const assignedIds = structure[plan.name] ?? []
      for (const fragId of assignedIds) {
        const meta = store.get(fragId)
        if (!meta) continue
        const content = store.readContent(fragId)
        fragments.push({
          id: fragId,
          title: meta.title,
          preview: truncate(content ?? '', 200),
        })
      }
    } catch {
      // Fragment store may not be initialized — skip
    }

    // Build related work context from literature awareness
    let relatedWork: string | undefined
    if (state.literature_awareness) {
      const parts: string[] = []
      for (const paper of state.literature_awareness.deeply_read.slice(0, 10)) {
        const takeaways =
          paper.key_takeaways.length > 0
            ? ` Key takeaways: ${paper.key_takeaways.slice(0, 3).join('; ')}`
            : ''
        parts.push(`- ${paper.paper_id}: ${paper.relevance_to_us}${takeaways}`)
      }
      for (const result of state.literature_awareness.known_results.slice(
        0,
        5,
      )) {
        parts.push(
          `- Known result: ${result.statement} (from ${result.source})`,
        )
      }
      if (parts.length > 0) {
        relatedWork = parts.join('\n')
      }
    }

    return {
      claims,
      demotedClaims,
      evidence,
      experimentResults,
      fragments,
      mustCite: plan.must_cite ?? [],
      relatedWork,
    }
  }

  /**
   * Inject a generated figure into the section file that should contain it.
   * Replaces a placeholder comment or appends after the first paragraph.
   */
  injectFigureIntoSection(
    sectionName: string,
    figure: FigureOutput,
    sectionsDir: string,
  ): void {
    const sectionFile = join(sectionsDir, `${sectionName}.tex`)
    if (!existsSync(sectionFile)) return

    let content = readFileSync(sectionFile, 'utf-8')

    // Build the figure snippet
    let snippet: string
    if (figure.approach === 'matplotlib' && figure.filePath) {
      const fileName = figure.filePath.split('/').pop() ?? 'hero_figure.png'
      snippet = [
        `\\begin{figure}[htbp]`,
        `  \\centering`,
        `  \\includegraphics[width=0.9\\textwidth]{figures/${fileName}}`,
        `  \\caption{${figure.caption}}`,
        `  \\label{${figure.label}}`,
        `\\end{figure}`,
      ].join('\n')
    } else {
      snippet = figure.code
    }

    // Try to replace placeholder
    const placeholderPattern =
      /% *(?:TODO|PLACEHOLDER):?\s*(?:hero|main)?\s*figure.*\n?/i
    if (placeholderPattern.test(content)) {
      content = content.replace(placeholderPattern, snippet + '\n')
    } else {
      // Insert after the first paragraph (first double newline)
      const insertIdx = content.indexOf('\n\n')
      if (insertIdx >= 0) {
        content =
          content.slice(0, insertIdx) +
          '\n\n' +
          snippet +
          '\n' +
          content.slice(insertIdx + 2)
      } else {
        content += '\n\n' + snippet + '\n'
      }
    }

    writeFileSync(sectionFile, content, 'utf-8')
  }

  /**
   * Inject a generated table into the section file that should contain it.
   */
  injectTableIntoSection(
    sectionName: string,
    table: TableOutput,
    sectionsDir: string,
  ): void {
    const sectionFile = join(sectionsDir, `${sectionName}.tex`)
    if (!existsSync(sectionFile)) return

    let content = readFileSync(sectionFile, 'utf-8')

    // Try to replace placeholder
    const placeholderPattern =
      /% *(?:TODO|PLACEHOLDER):?\s*(?:main|results?)?\s*table.*\n?/i
    if (placeholderPattern.test(content)) {
      content = content.replace(placeholderPattern, table.code + '\n')
    } else {
      // Insert after the first paragraph
      const insertIdx = content.indexOf('\n\n')
      if (insertIdx >= 0) {
        content =
          content.slice(0, insertIdx) +
          '\n\n' +
          table.code +
          '\n' +
          content.slice(insertIdx + 2)
      } else {
        content += '\n\n' + table.code + '\n'
      }
    }

    writeFileSync(sectionFile, content, 'utf-8')
  }

  /**
   * Ensure required packages are present in main.tex before \\begin{document}.
   */
  ensurePackages(mainTexPath: string, packages: string[]): void {
    let content = readFileSync(mainTexPath, 'utf-8')
    const unique = [...new Set(packages)]

    for (const pkg of unique) {
      const pattern = new RegExp(
        `\\\\usepackage(\\[[^\\]]*\\])?\\{[^}]*\\b${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      )
      if (pattern.test(content)) continue

      // Insert before \begin{document}
      const docBegin = content.indexOf('\\begin{document}')
      if (docBegin >= 0) {
        content =
          content.slice(0, docBegin) +
          `\\usepackage{${pkg}}\n` +
          content.slice(docBegin)
      }
    }

    writeFileSync(mainTexPath, content, 'utf-8')
  }

  private copyDir(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true })
    const entries = readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = join(src, entry.name)
      const destPath = join(dest, entry.name)
      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath)
      } else {
        if (!existsSync(destPath)) {
          writeFileSync(destPath, readFileSync(srcPath))
        }
      }
    }
  }
}

// ── Post-Processing ─────────────────────────────────────

/**
 * Extract all \cite{}, \citep{}, \citet{} keys from LaTeX source.
 */
export function extractCiteKeys(latex: string): string[] {
  const keys: string[] = []
  const pattern = /\\(?:cite|citep|citet|citeauthor|citeyear)\{([^}]+)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(latex)) !== null) {
    const keyList = match[1]
    if (keyList) {
      for (const k of keyList.split(',')) {
        const trimmed = k.trim()
        if (trimmed) keys.push(trimmed)
      }
    }
  }
  return keys
}

/**
 * Estimate word count in LaTeX by stripping commands and counting tokens.
 */
export function estimateWordCount(latex: string): number {
  // Strip LaTeX commands, braces, and common environments
  const stripped = latex
    .replace(/\\(?:begin|end)\{[^}]+\}/g, '')
    .replace(/\\[a-zA-Z]+(?:\[[^\]]*\])?\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}\\$%&_^~#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.split(/\s+/).filter(w => w.length > 0).length
}

/**
 * Post-process a generated LaTeX section:
 * - Validate and auto-fix citation keys via BibTeXManager
 * - Check word count against page budget
 * - Ensure \label{sec:<name>} exists
 */
export async function postProcessSection(
  latex: string,
  plan: NarrativeSectionPlan,
  constraints: VenueConstraints | null,
  bibManager?: BibTeXManager | null,
): Promise<PostProcessResult> {
  let result = latex
  const warnings: string[] = []

  // Step A: Citation validation via BibTeXManager.autoFixCiteKey
  if (bibManager) {
    const citeKeys = extractCiteKeys(result)
    for (const key of citeKeys) {
      if (bibManager.hasKey(key)) continue
      const fixedKey = await bibManager.autoFixCiteKey(key)
      if (fixedKey && fixedKey !== key) {
        result = result.replace(new RegExp(escapeRegExp(key), 'g'), fixedKey)
        warnings.push(
          `Citation auto-fixed: \\cite{${key}} → \\cite{${fixedKey}}`,
        )
      } else if (!fixedKey) {
        warnings.push(
          `Missing citation key: \\cite{${key}} (placeholder added)`,
        )
      }
    }
  }

  // Step B: Word count check
  const wordBudget = Math.round(plan.page_budget * wordsPerPage(constraints))
  const wordCount = estimateWordCount(result)
  if (wordBudget > 0 && wordCount > wordBudget * 1.2) {
    result = `% WARNING: Section "${plan.name}" exceeds page budget (${wordCount} words, budget ~${wordBudget})\n${result}`
    warnings.push(
      `Section "${plan.name}" exceeds word budget: ${wordCount} words vs ~${wordBudget} budget`,
    )
  }

  // Step C: Label validation
  const labelPattern = new RegExp(
    `\\\\label\\{sec:${escapeRegExp(plan.name)}\\}`,
  )
  if (!labelPattern.test(result)) {
    result = `\\label{sec:${plan.name}}\n${result}`
  }

  return { latex: result, warnings }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
