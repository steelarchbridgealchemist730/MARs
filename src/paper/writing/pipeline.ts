import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
} from 'fs'
import { join } from 'path'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import { extractModelId } from '../agent-dispatch'
import { NarrativePlanner } from './narrative-planner'
import { TemplateResolver } from './template-resolver'
import { BibTeXManager } from './bibtex-manager'
import { PaperWriter, postProcessSection } from './writer'
import { FragmentStore, type FragmentType } from '../fragment-store'
import { FigureDesigner, extractPackageDependencies } from './figure-designer'
import { PaperAssembler } from './assembler'
import { LaTeXEngine } from './latex-engine'
import { PageChecker } from './page-checker'
import type { ResearchState } from '../research-state'
import type { ResolvedTemplate, VenueConstraints } from './template-types'
import type {
  NarrativePlan,
  WritingPipelinePhase,
  WritingPipelineResult,
  CompilationResult,
} from './types'

// ── Fragment Type Mapping ─────────────────────────────────

export function mapSectionToFragmentType(
  sectionName: string,
): FragmentType | null {
  const map: Record<string, FragmentType> = {
    'related-work': 'related_work',
    related_work: 'related_work',
    literature: 'related_work',
    methodology: 'definitions',
    method: 'definitions',
    model: 'definitions',
    experiments: 'experiments',
    results: 'experiments',
    data: 'experiments',
  }
  return map[sectionName] ?? null
}

// ── Options ──────────────────────────────────────────────

export interface WritingPipelineOptions {
  projectDir: string
  state: ResearchState
  templateId?: string
  modelSpec?: string
  onProgress?: (phase: WritingPipelinePhase, message: string) => void
}

// ── WritingPipeline ──────────────────────────────────────

export class WritingPipeline {
  private projectDir: string
  private state: ResearchState
  private templateId: string
  private modelSpec: string
  private onProgress: (phase: WritingPipelinePhase, message: string) => void

  constructor(options: WritingPipelineOptions) {
    this.projectDir = options.projectDir
    this.state = options.state
    this.templateId =
      options.templateId ??
      (options.state.proposal as any)?.template ??
      'neurips'
    this.modelSpec =
      options.modelSpec ?? extractModelId(DEFAULT_MODEL_ASSIGNMENTS.writing)
    this.onProgress = options.onProgress ?? (() => {})
  }

  async run(): Promise<WritingPipelineResult> {
    const warnings: string[] = []
    const phases_completed: WritingPipelinePhase[] = []
    const paperDir = join(this.projectDir, 'paper')
    const sectionsDir = join(paperDir, 'sections')
    mkdirSync(sectionsDir, { recursive: true })

    // Initialize fragment store (best-effort)
    let fragmentStore: FragmentStore | null = null
    try {
      fragmentStore = new FragmentStore(this.projectDir)
      fragmentStore.init()
    } catch {
      /* best-effort */
    }

    // ── Phase 1: Plan ──────────────────────────────────
    this.onProgress('plan', 'Planning narrative structure...')

    const resolver = new TemplateResolver()
    let resolved: ResolvedTemplate | null = null
    try {
      resolved = resolver.resolve(this.templateId)
    } catch {
      warnings.push(`Template "${this.templateId}" not found, using defaults`)
    }

    const constraints = resolved?.constraints ?? null

    const planner = new NarrativePlanner(this.projectDir, this.modelSpec)
    let plan: NarrativePlan
    try {
      const templateForPlan = resolved ?? {
        manifest: {
          id: 'custom',
          name: 'Custom',
          venue_type: 'conference' as const,
          field: 'CS',
          description: 'Custom template',
          template_files: { main: 'main.tex' },
          compilation: {
            engine: 'pdflatex' as const,
            bibtex: 'bibtex' as const,
            sequence: ['pdflatex', 'bibtex', 'pdflatex', 'pdflatex'],
            extra_packages: [],
          },
        },
        constraints: null,
        directory: paperDir,
      }
      plan = await planner.plan(this.state, templateForPlan)
    } catch (err: any) {
      return {
        success: false,
        warnings: [...warnings, `Narrative planning failed: ${err.message}`],
        phases_completed,
      }
    }

    if (!plan.sections || plan.sections.length === 0) {
      return {
        success: false,
        warnings: [...warnings, 'Narrative plan has no sections'],
        phases_completed,
      }
    }

    // Save plan
    const planPath = join(paperDir, 'narrative-plan.json')
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8')
    phases_completed.push('plan')

    // ── Phase 2: Bibliography ──────────────────────────
    this.onProgress('bibliography', 'Syncing bibliography...')

    const bibPath = join(paperDir, 'bibliography.bib')
    if (!existsSync(bibPath)) {
      writeFileSync(bibPath, '', 'utf-8')
    }
    const bibManager = new BibTeXManager(bibPath)

    const litBibPath = join(this.projectDir, 'bibliography.bib')
    if (existsSync(litBibPath) && litBibPath !== bibPath) {
      try {
        const syncResult = await bibManager.syncFromLiterature(
          litBibPath,
          paperDir,
        )
        this.onProgress(
          'bibliography',
          `Synced ${syncResult.synced} entries, ${syncResult.missing} missing`,
        )
      } catch (err: any) {
        warnings.push(`Bibliography sync warning: ${err.message}`)
      }
    }
    phases_completed.push('bibliography')

    // ── Phase 3: Write Sections ────────────────────────
    this.onProgress('write_sections', 'Writing sections...')

    const writer = new PaperWriter(this.projectDir, this.modelSpec, bibPath)
    const previousSections: string[] = []
    const proposal = this.state.proposal ?? { title: 'Research Paper' }

    // Build shared context (same pattern as writePaperFromPlan)
    const arc = plan.narrative_arc
    const sharedContext = [
      `Title: ${proposal.title}`,
      `Authors: ${((proposal as any).authors ?? ['Anonymous']).join(', ')}`,
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

    for (let i = 0; i < plan.sections.length; i++) {
      const sectionPlan = plan.sections[i]!
      this.onProgress(
        'write_sections',
        `Writing section: ${sectionPlan.title} (${i + 1}/${plan.sections.length})`,
      )

      const materials = writer.gatherMaterials(sectionPlan, this.state)

      let content = await writer.writeSectionFromPlan(
        sectionPlan,
        constraints,
        sharedContext,
        previousSections,
        materials,
      )

      const { latex, warnings: sectionWarnings } = await postProcessSection(
        content,
        sectionPlan,
        constraints,
        bibManager,
      )
      content = latex
      warnings.push(...sectionWarnings)

      const sectionFile = join(sectionsDir, `${sectionPlan.name}.tex`)
      const sectionTex = `\\section{${sectionPlan.title}}\n\n${content}\n`
      writeFileSync(sectionFile, sectionTex, 'utf-8')

      // Track in fragment store
      if (fragmentStore) {
        const fragType = mapSectionToFragmentType(sectionPlan.name)
        if (fragType) {
          try {
            const frag = fragmentStore.create(
              fragType,
              sectionPlan.title,
              content,
              {
                created_by: 'writing-pipeline',
                related_claims: sectionPlan.claims_covered,
                estimated_pages: sectionPlan.page_budget,
              },
            )
            fragmentStore.assignToSection(sectionPlan.name, frag.id)
          } catch {
            /* best-effort */
          }
        }
      }

      previousSections.push(`[${sectionPlan.title}]\n${content.slice(0, 3000)}`)
    }
    phases_completed.push('write_sections')

    // ── Phase 4: Hero Figure + Main Table ──────────────
    this.onProgress('figures', 'Generating figures and tables...')

    const allFigureDeps: string[] = []
    const figureDesigner = new FigureDesigner(this.projectDir, this.modelSpec)

    if (plan.hero_figure) {
      const figureMaterials = figureDesigner.gatherFigureMaterials(
        plan,
        this.state,
      )
      try {
        const heroFigure = await figureDesigner.designHeroFigure(
          plan.hero_figure,
          figureMaterials,
          constraints,
        )
        allFigureDeps.push(...heroFigure.dependencies)
        writer.injectFigureIntoSection(
          plan.hero_figure.placement,
          heroFigure,
          sectionsDir,
        )
      } catch {
        warnings.push('Failed to generate hero figure')
      }
    }

    if (plan.main_table) {
      const tableMaterials = figureDesigner.gatherFigureMaterials(
        plan,
        this.state,
      )
      try {
        const mainTable = await figureDesigner.designMainTable(
          plan.main_table,
          tableMaterials,
          constraints,
        )
        allFigureDeps.push(...mainTable.dependencies)
        writer.injectTableIntoSection(
          plan.main_table.placement,
          mainTable,
          sectionsDir,
        )
      } catch {
        warnings.push('Failed to generate main table')
      }
    }

    const mainTexPath = join(paperDir, 'main.tex')
    if (allFigureDeps.length > 0 && existsSync(mainTexPath)) {
      writer.ensurePackages(mainTexPath, allFigureDeps)
    }
    phases_completed.push('figures')

    // ── Phase 5: Assemble ──────────────────────────────
    this.onProgress('assemble', 'Assembling paper...')

    // Copy template dir to paper/
    if (resolved) {
      this.copyTemplateDir(resolved.directory, paperDir)
    }

    // Update main.tex with title, authors, section inputs
    this.updateMainTex(mainTexPath, plan, proposal)

    // Copy bibliography to paper dir
    if (existsSync(litBibPath) && litBibPath !== bibPath) {
      copyFileSync(litBibPath, join(paperDir, 'references.bib'))
    }
    if (existsSync(bibPath)) {
      // Also copy as references.bib if it doesn't exist
      const refsBibPath = join(paperDir, 'references.bib')
      if (!existsSync(refsBibPath)) {
        copyFileSync(bibPath, refsBibPath)
      }
    }

    // PaperAssembler validation
    try {
      const assembler = new PaperAssembler(this.projectDir)
      const structure = assembler.createDefaultStructure(
        proposal.title,
        this.templateId,
      )
      // Update structure sections to match the plan
      structure.sections = plan.sections.map(s => ({
        name: s.name,
        title: s.title,
        fragments: [],
        needs_transition: false,
      }))
      const validationIssues = assembler.validate(structure)
      if (validationIssues.length > 0) {
        warnings.push(...validationIssues.map(i => `Validation: ${i}`))
      }
    } catch {
      // Validation is best-effort
    }
    phases_completed.push('assemble')

    // ── Phase 6: Compile + Fix Loop ────────────────────
    this.onProgress('compile', 'Compiling LaTeX...')

    const engine = new LaTeXEngine(this.projectDir, {
      manifest: resolved?.manifest ?? null,
      constraints,
      bibManager,
      templateDir: resolved?.directory ?? null,
    })

    let compilationResult: CompilationResult
    try {
      compilationResult = await engine.compileAndFixDetailed(
        mainTexPath,
        this.modelSpec,
      )
    } catch (err: any) {
      return {
        success: false,
        plan,
        warnings: [...warnings, `Compilation failed: ${err.message}`],
        phases_completed,
      }
    }

    if (!compilationResult.success || !compilationResult.pdfPath) {
      return {
        success: false,
        plan,
        compilationResult,
        warnings: [
          ...warnings,
          `Compilation failed after ${compilationResult.attempts} attempts`,
        ],
        phases_completed,
      }
    }

    let pdfPath = compilationResult.pdfPath
    phases_completed.push('compile')

    // ── Phase 7: Page Check ────────────────────────────
    this.onProgress('page_check', 'Checking page count...')

    const pageChecker = new PageChecker(this.modelSpec)
    let pageCheck = await pageChecker.check(pdfPath, constraints)
    let cutSuggestions: import('./types').CutSuggestion[] | undefined

    if (!pageCheck.passed && pageCheck.overBy > 0) {
      this.onProgress(
        'page_check',
        `Over by ${pageCheck.overBy} page(s) — applying cuts...`,
      )

      cutSuggestions = await pageChecker.suggestCuts(
        paperDir,
        pageCheck.overBy,
        constraints,
      )

      if (cutSuggestions.length > 0) {
        const { applied, wordsSaved } = await pageChecker.applyCuts(
          paperDir,
          cutSuggestions,
          constraints,
        )

        if (applied > 0) {
          this.onProgress(
            'page_check',
            `Applied ${applied} cuts, saved ~${wordsSaved} words. Recompiling...`,
          )

          // Recompile after cuts
          try {
            compilationResult = await engine.compileAndFixDetailed(
              mainTexPath,
              this.modelSpec,
            )
            if (compilationResult.pdfPath) {
              pdfPath = compilationResult.pdfPath
            }
          } catch {
            warnings.push('Recompilation after page cuts failed')
          }

          // Re-check pages
          pageCheck = await pageChecker.check(pdfPath, constraints)
          if (!pageCheck.passed) {
            warnings.push(
              `Still over page limit by ${pageCheck.overBy} page(s) after cuts`,
            )
          }
        }
      }
    }
    phases_completed.push('page_check')

    // ── Phase 8: Final Sync ────────────────────────────
    this.onProgress('final_sync', 'Final bibliography sync and compilation...')

    // Re-sync bibliography (may have new \cite{} from compression rewrites)
    try {
      if (existsSync(litBibPath) && litBibPath !== bibPath) {
        await bibManager.syncFromLiterature(litBibPath, paperDir)
      }
    } catch {
      // Non-fatal
    }

    // Final compilation pass
    try {
      const finalResult = await engine.compileAndFixDetailed(
        mainTexPath,
        this.modelSpec,
      )
      if (finalResult.pdfPath) {
        pdfPath = finalResult.pdfPath
        compilationResult = finalResult
      }
    } catch {
      // Use previous compilation result
    }
    phases_completed.push('final_sync')

    return {
      success: true,
      pdfPath,
      plan,
      pageCheck,
      cutSuggestions,
      warnings,
      compilationResult,
      phases_completed,
    }
  }

  // ── Helpers ────────────────────────────────────────────

  private copyTemplateDir(src: string, dest: string): void {
    if (!existsSync(src)) return
    mkdirSync(dest, { recursive: true })
    try {
      const entries = readdirSync(src, { withFileTypes: true })
      for (const entry of entries) {
        const srcPath = join(src, entry.name)
        const destPath = join(dest, entry.name)
        if (entry.isDirectory()) {
          this.copyTemplateDir(srcPath, destPath)
        } else if (!existsSync(destPath)) {
          copyFileSync(srcPath, destPath)
        }
      }
    } catch {
      // Template copy is best-effort
    }
  }

  private updateMainTex(
    mainTexPath: string,
    plan: NarrativePlan,
    proposal: { title: string; authors?: string[] },
  ): void {
    if (!existsSync(mainTexPath)) return

    let mainTex = readFileSync(mainTexPath, 'utf-8')

    // Update title
    mainTex = mainTex.replace(/\\title\{[^}]*\}/, `\\title{${proposal.title}}`)

    // Update authors
    const authorLines = (proposal.authors ?? ['Anonymous'])
      .map(a => `  ${a} \\\\`)
      .join('\n  \\And\n')
    mainTex = mainTex.replace(
      /\\author\{[\s\S]*?\n\}/,
      `\\author{\n${authorLines}\n}`,
    )

    // Rebuild section inputs
    const sectionInputs = plan.sections
      .map(s => `\\input{sections/${s.name}}`)
      .join('\n')
    mainTex = mainTex.replace(
      /(?:\\input\{sections\/[^}]+\}\s*\n?)+/,
      sectionInputs + '\n',
    )

    writeFileSync(mainTexPath, mainTex, 'utf-8')
  }
}
