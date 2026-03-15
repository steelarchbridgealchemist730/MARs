import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { chatCompletion } from '../llm-client'
import { FigureGenerator } from './figure-generator'
import { FragmentStore } from '../fragment-store'
import { repairTruncatedJSON } from '../json-repair'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import type { VenueConstraints } from './template-types'
import type {
  HeroFigurePlan,
  MainTablePlan,
  NarrativePlan,
  FigureApproach,
  FigureOutput,
  TableOutput,
  FigureMaterials,
  FigureDesignDecision,
} from './types'
import type { ResearchState } from '../research-state'

// ── Helper Functions (exported for testing) ─────────────

/**
 * Extract required LaTeX packages from TikZ/table code.
 * Looks for \usetikzlibrary, \usepackage, known environments, and `% packages:` comments.
 */
export function extractPackageDependencies(code: string): string[] {
  const deps = new Set<string>()

  // Explicit % packages: comment line
  const packagesComment = code.match(/^%\s*packages?:\s*(.+)$/m)
  if (packagesComment) {
    for (const pkg of packagesComment[1].split(/[,\s]+/)) {
      const trimmed = pkg.trim()
      if (trimmed) deps.add(trimmed)
    }
  }

  // \usepackage{...}
  const usepackage = code.matchAll(/\\usepackage(?:\[.*?\])?\{([^}]+)\}/g)
  for (const m of usepackage) {
    for (const pkg of m[1].split(',')) {
      const trimmed = pkg.trim()
      if (trimmed) deps.add(trimmed)
    }
  }

  // \usetikzlibrary{...}
  if (/\\usetikzlibrary/.test(code)) {
    deps.add('tikz')
  }

  // Detect from environment/command usage
  if (/\\begin\{tikzpicture\}/.test(code)) deps.add('tikz')
  if (/\\begin\{axis\}/.test(code) || /\\begin\{pgfplot/.test(code))
    deps.add('pgfplots')
  if (/\\toprule|\\midrule|\\bottomrule/.test(code)) deps.add('booktabs')
  if (/\\multicolumn/.test(code)) deps.add('multirow')
  if (/\\includegraphics/.test(code)) deps.add('graphicx')
  if (/\\subcaption|\\subfigure|\\begin\{subfigure\}/.test(code))
    deps.add('subcaption')
  if (/\\xcolor|\\definecolor|\\textcolor/.test(code)) deps.add('xcolor')

  return [...deps]
}

/**
 * Get figure sizing defaults from venue constraints.
 */
export function getVenueSizing(constraints: VenueConstraints | null): {
  maxWidth: string
  placement: string
  columns: 1 | 2
  tableStyle: string
} {
  if (!constraints) {
    return {
      maxWidth: '\\textwidth',
      placement: '[htbp]',
      columns: 1,
      tableStyle: 'booktabs',
    }
  }

  const fmt = constraints.formatting
  const columns = fmt.columns ?? 1
  const maxWidth =
    columns === 2
      ? (fmt.max_figure_width_double_col ?? '\\textwidth')
      : (fmt.max_figure_width_single_col ?? '\\textwidth')

  const placement =
    fmt.figure_placement === 'top'
      ? '[t]'
      : fmt.figure_placement === 'bottom'
        ? '[b]'
        : '[htbp]'
  const tableStyle = fmt.table_style ?? 'booktabs'

  return { maxWidth, placement, columns, tableStyle }
}

// ── FigureDesigner Class ────────────────────────────────

export class FigureDesigner {
  private projectDir: string
  private modelSpec: string
  private figureGenerator: FigureGenerator
  private fragmentStore: FragmentStore

  constructor(projectDir: string, modelSpec?: string) {
    this.projectDir = projectDir
    this.modelSpec = modelSpec ?? DEFAULT_MODEL_ASSIGNMENTS.writing
    this.figureGenerator = new FigureGenerator(projectDir, this.modelSpec)
    this.fragmentStore = new FragmentStore(projectDir)
  }

  /**
   * Gather materials needed for figure/table design from the research state.
   */
  gatherFigureMaterials(
    plan: NarrativePlan,
    state: ResearchState | null,
  ): FigureMaterials {
    const materials: FigureMaterials = {
      claimDescriptions: [],
      experimentData: null,
      experimentSummaries: [],
      existingFigures: [],
      narrativeArc: {
        hook: plan.narrative_arc.hook,
        insight: plan.narrative_arc.insight,
        method_summary: plan.narrative_arc.method_summary,
      },
    }

    if (!state) return materials

    // Collect claim descriptions from admitted claims
    for (const claim of state.claimGraph.claims) {
      if (claim.phase === 'admitted') {
        materials.claimDescriptions.push(
          `[${claim.epistemicLayer}] ${claim.statement}`,
        )
      }
    }

    // Collect experiment data from artifacts
    for (const entry of state.artifacts.entries) {
      if (entry.type === 'experiment_result') {
        const fullPath = entry.path.startsWith('/')
          ? entry.path
          : join(this.projectDir, entry.path)
        if (existsSync(fullPath)) {
          try {
            const { readFileSync } = require('fs')
            const content = readFileSync(fullPath, 'utf-8')
            if (!materials.experimentData) {
              materials.experimentData = content.slice(0, 4000)
            }
            materials.experimentSummaries.push(
              `${entry.description}: ${content.slice(0, 500)}`,
            )
          } catch {
            materials.experimentSummaries.push(entry.description)
          }
        } else {
          materials.experimentSummaries.push(entry.description)
        }
      }
    }

    // Scan existing figures directory
    const figuresDir = join(this.projectDir, 'paper', 'figures')
    if (existsSync(figuresDir)) {
      try {
        materials.existingFigures = readdirSync(figuresDir).filter(
          f => f.endsWith('.png') || f.endsWith('.pdf') || f.endsWith('.tex'),
        )
      } catch {
        // ignore
      }
    }

    return materials
  }

  /**
   * Design the hero figure: two-phase approach (decide + generate).
   */
  async designHeroFigure(
    plan: HeroFigurePlan,
    materials: FigureMaterials,
    constraints: VenueConstraints | null,
  ): Promise<FigureOutput> {
    const sizing = getVenueSizing(constraints)

    // Phase 1: Decide approach
    const figureStrategy =
      constraints?.writing_guidelines?.figure_strategy ?? ''
    const decision = await this.decideApproach(
      plan,
      materials,
      sizing,
      figureStrategy,
    )

    // Phase 2: Generate code
    const output = await this.generateFigureCode(
      plan,
      materials,
      decision,
      sizing,
    )

    // Write file and save fragment
    const figuresDir = join(this.projectDir, 'paper', 'figures')
    mkdirSync(figuresDir, { recursive: true })

    if (output.approach === 'matplotlib') {
      // Delegate to FigureGenerator for matplotlib execution
      try {
        const pngPath = await this.figureGenerator.generateMatplotlib(
          plan.description,
          materials.experimentData ?? undefined,
          join(figuresDir, 'hero_figure.png'),
        )
        output.filePath = pngPath
      } catch (err) {
        // Retry once with error context
        try {
          const retryPngPath = await this.figureGenerator.generateMatplotlib(
            `${plan.description}\n\nPrevious attempt failed with: ${(err as Error).message}\nPlease fix the issue.`,
            materials.experimentData ?? undefined,
            join(figuresDir, 'hero_figure.png'),
          )
          output.filePath = retryPngPath
        } catch {
          // Fall through — filePath stays undefined
        }
      }
    } else {
      // TikZ or combined: write .tex file
      const texPath = join(figuresDir, 'hero_figure.tex')
      writeFileSync(texPath, output.code, 'utf-8')
      output.filePath = texPath
    }

    // Save as fragment
    try {
      const fragment = this.fragmentStore.create(
        'figures',
        'Hero Figure',
        output.code,
        {
          created_by: 'figure-designer',
          notes: `Approach: ${output.approach}. ${decision.reasoning}`,
        },
      )
      output.fragmentId = fragment.id
    } catch {
      // Fragment store may not be initialized
    }

    return output
  }

  /**
   * Design the main results table.
   */
  async designMainTable(
    plan: MainTablePlan,
    materials: FigureMaterials,
    constraints: VenueConstraints | null,
  ): Promise<TableOutput> {
    const sizing = getVenueSizing(constraints)

    const tableStrategy = constraints?.writing_guidelines?.table_strategy ?? ''
    const tableStrategyLine = tableStrategy
      ? `\n- Venue table strategy: ${tableStrategy}`
      : ''
    const system = `You are an expert LaTeX table designer for academic papers. Generate a publication-quality results table using the booktabs package. Return ONLY a JSON object with this structure:
{
  "code": "... full LaTeX table environment code ...",
  "caption": "...",
  "label": "tab:main-results"
}

Rules:
- Use \\toprule, \\midrule, \\bottomrule (booktabs style)
- Bold the best result in each column with \\textbf{}
- Include standard deviations where data is available
- Use ${sizing.tableStyle} table style
- Table width should fit within ${sizing.maxWidth}
- ${sizing.columns === 2 ? 'Use \\begin{table*} for full-width or \\begin{table} for single column' : 'Use \\begin{table}'}${tableStrategyLine}
Return ONLY the JSON object, no markdown fences.`

    const userContent = [
      `Design the main results table for this paper.`,
      ``,
      `Table content: ${plan.content}`,
      `Caption draft: ${plan.caption_draft}`,
      plan.experiments_used.length > 0
        ? `Experiments: ${plan.experiments_used.join(', ')}`
        : '',
      materials.experimentData
        ? `\nExperiment data:\n${materials.experimentData.slice(0, 3000)}`
        : '',
      materials.experimentSummaries.length > 0
        ? `\nExperiment summaries:\n${materials.experimentSummaries.join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n')

    const response = await chatCompletion({
      modelSpec: this.modelSpec,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: userContent }],
    })

    const parsed = this.parseJSON<{
      code: string
      caption: string
      label: string
    }>(response.text)

    const code = parsed?.code ?? this.fallbackTable(plan)
    const caption = parsed?.caption ?? plan.caption_draft
    const label = parsed?.label ?? 'tab:main-results'
    const dependencies = extractPackageDependencies(code)

    // Always ensure booktabs
    if (!dependencies.includes('booktabs')) {
      dependencies.push('booktabs')
    }

    // Write .tex file
    const figuresDir = join(this.projectDir, 'paper', 'figures')
    mkdirSync(figuresDir, { recursive: true })
    const texPath = join(figuresDir, 'main_table.tex')
    writeFileSync(texPath, code, 'utf-8')

    // Save as fragment
    let fragmentId: string | undefined
    try {
      const fragment = this.fragmentStore.create(
        'tables',
        'Main Results Table',
        code,
        {
          created_by: 'figure-designer',
          notes: `Caption: ${caption}`,
        },
      )
      fragmentId = fragment.id
    } catch {
      // Fragment store may not be initialized
    }

    return {
      code,
      caption,
      label,
      dependencies,
      filePath: texPath,
      fragmentId,
    }
  }

  // ── Private Methods ───────────────────────────────────

  private async decideApproach(
    plan: HeroFigurePlan,
    materials: FigureMaterials,
    sizing: ReturnType<typeof getVenueSizing>,
    figureStrategy?: string,
  ): Promise<FigureDesignDecision> {
    const strategyLine = figureStrategy
      ? `\nVenue figure strategy: ${figureStrategy}`
      : ''
    const system = `You are an expert academic figure designer. Decide the best approach for creating a hero figure. Return ONLY a JSON object:
{
  "approach": "tikz" | "matplotlib" | "combined",
  "reasoning": "brief explanation",
  "layout": "single_column" | "double_column",
  "subfigures": number,
  "colorScheme": "description of colors"
}

Guidelines:
- Use "tikz" for architecture diagrams, flowcharts, system diagrams
- Use "matplotlib" for plots, charts, data visualizations
- Use "combined" when the figure needs both a diagram and data plots
- ${sizing.columns === 2 ? 'Prefer single_column for simple figures, double_column for complex ones' : 'Use single_column layout'}${strategyLine}
Return ONLY the JSON object, no markdown fences.`

    const userContent = [
      `Hero figure description: ${plan.description}`,
      `Components: ${plan.components.join(', ')}`,
      `Estimated height: ${plan.estimated_height} of page`,
      ``,
      `Narrative context:`,
      `  Hook: ${materials.narrativeArc.hook}`,
      `  Insight: ${materials.narrativeArc.insight}`,
      `  Method: ${materials.narrativeArc.method_summary}`,
      materials.experimentData
        ? `\nHas experiment data available.`
        : `\nNo experiment data available.`,
      materials.existingFigures.length > 0
        ? `Existing figures: ${materials.existingFigures.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n')

    const response = await chatCompletion({
      modelSpec: this.modelSpec,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userContent }],
    })

    const parsed = this.parseJSON<FigureDesignDecision>(response.text)

    return {
      approach: parsed?.approach ?? 'tikz',
      reasoning:
        parsed?.reasoning ?? 'Default to TikZ for architecture diagram',
      layout:
        parsed?.layout ??
        (sizing.columns === 2 ? 'double_column' : 'single_column'),
      subfigures: parsed?.subfigures ?? 1,
      colorScheme: parsed?.colorScheme ?? 'blue-gray academic palette',
    }
  }

  private async generateFigureCode(
    plan: HeroFigurePlan,
    materials: FigureMaterials,
    decision: FigureDesignDecision,
    sizing: ReturnType<typeof getVenueSizing>,
  ): Promise<FigureOutput> {
    const widthCmd =
      decision.layout === 'double_column' && sizing.columns === 2
        ? '\\textwidth'
        : sizing.maxWidth

    const envName =
      decision.layout === 'double_column' && sizing.columns === 2
        ? 'figure*'
        : 'figure'

    let approachInstructions = ''
    if (decision.approach === 'tikz') {
      approachInstructions = `Generate TikZ code for the figure. Use \\begin{${envName}}${sizing.placement} and \\begin{tikzpicture}. Width should fit within ${widthCmd}.`
    } else if (decision.approach === 'matplotlib') {
      approachInstructions = `Generate a complete Python matplotlib script. Save to a PNG file. The LaTeX wrapper will use \\includegraphics[width=${widthCmd}]{figures/hero_figure.png}.`
    } else {
      approachInstructions = `Generate a combined figure with TikZ diagram and data plot subfigures. Use \\begin{${envName}}${sizing.placement} with subcaption package.`
    }

    const system = `You are an expert academic figure creator. Generate publication-quality figure code. Return ONLY a JSON object:
{
  "code": "... full code (TikZ LaTeX or Python matplotlib) ...",
  "caption": "...",
  "label": "fig:hero"
}

${approachInstructions}

Color scheme: ${decision.colorScheme}
Number of subfigures: ${decision.subfigures}

Rules:
- For TikZ: include the full \\begin{figure}...\\end{figure} environment
- For matplotlib: include complete runnable Python script with plt.savefig()
- Caption should be informative and self-contained
- Label must start with fig:
Return ONLY the JSON object, no markdown fences.`

    const userContent = [
      `Generate the hero figure for: ${plan.description}`,
      `Components: ${plan.components.join(', ')}`,
      ``,
      `Narrative context:`,
      `  Hook: ${materials.narrativeArc.hook}`,
      `  Insight: ${materials.narrativeArc.insight}`,
      `  Method: ${materials.narrativeArc.method_summary}`,
      materials.claimDescriptions.length > 0
        ? `\nKey claims:\n${materials.claimDescriptions.slice(0, 5).join('\n')}`
        : '',
      materials.experimentData && decision.approach !== 'tikz'
        ? `\nExperiment data (use for plots):\n${materials.experimentData.slice(0, 2000)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n')

    const response = await chatCompletion({
      modelSpec: this.modelSpec,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: userContent }],
    })

    const parsed = this.parseJSON<{
      code: string
      caption: string
      label: string
    }>(response.text)

    let code = parsed?.code ?? this.fallbackFigure(plan, decision, sizing)
    const caption = parsed?.caption ?? plan.description
    const label = parsed?.label ?? 'fig:hero'

    // Validate TikZ code: check balanced braces
    if (decision.approach === 'tikz' || decision.approach === 'combined') {
      if (!this.validateTikZ(code)) {
        // Retry once
        const retryResponse = await chatCompletion({
          modelSpec: this.modelSpec,
          max_tokens: 8192,
          system:
            system +
            '\n\nIMPORTANT: The previous attempt had unbalanced braces. Please ensure all { } are properly matched.',
          messages: [{ role: 'user', content: userContent }],
        })
        const retryParsed = this.parseJSON<{
          code: string
          caption: string
          label: string
        }>(retryResponse.text)
        if (retryParsed?.code && this.validateTikZ(retryParsed.code)) {
          code = retryParsed.code
        }
      }
    }

    const dependencies = extractPackageDependencies(code)

    return {
      approach: decision.approach,
      code,
      caption,
      label,
      dependencies,
    }
  }

  private validateTikZ(code: string): boolean {
    let braceCount = 0
    for (const ch of code) {
      if (ch === '{') braceCount++
      if (ch === '}') braceCount--
      if (braceCount < 0) return false
    }
    if (braceCount !== 0) return false

    // Check matching begin/end
    const begins = code.match(/\\begin\{([^}]+)\}/g) ?? []
    const ends = code.match(/\\end\{([^}]+)\}/g) ?? []
    if (begins.length !== ends.length) return false

    return true
  }

  private parseJSON<T>(text: string): T | null {
    // Strip markdown fences
    const cleaned = text
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim()

    try {
      return JSON.parse(cleaned) as T
    } catch {
      // Try repair
      const repaired = repairTruncatedJSON(cleaned)
      if (repaired && typeof repaired === 'object') {
        return repaired as T
      }
      return null
    }
  }

  private fallbackFigure(
    plan: HeroFigurePlan,
    decision: FigureDesignDecision,
    sizing: ReturnType<typeof getVenueSizing>,
  ): string {
    const envName =
      decision.layout === 'double_column' && sizing.columns === 2
        ? 'figure*'
        : 'figure'
    return [
      `\\begin{${envName}}${sizing.placement}`,
      `  \\centering`,
      `  % TODO: Replace with actual figure`,
      `  \\fbox{\\parbox{0.8${sizing.maxWidth}}{\\centering\\vspace{2cm}${plan.description}\\vspace{2cm}}}`,
      `  \\caption{${plan.description}}`,
      `  \\label{fig:hero}`,
      `\\end{${envName}}`,
    ].join('\n')
  }

  private fallbackTable(plan: MainTablePlan): string {
    return [
      `\\begin{table}[htbp]`,
      `  \\centering`,
      `  \\caption{${plan.caption_draft}}`,
      `  \\label{tab:main-results}`,
      `  \\begin{tabular}{lcc}`,
      `    \\toprule`,
      `    Method & Metric 1 & Metric 2 \\\\`,
      `    \\midrule`,
      `    Baseline & 0.0 & 0.0 \\\\`,
      `    Ours & \\textbf{0.0} & \\textbf{0.0} \\\\`,
      `    \\bottomrule`,
      `  \\end{tabular}`,
      `\\end{table}`,
    ].join('\n')
  }
}
