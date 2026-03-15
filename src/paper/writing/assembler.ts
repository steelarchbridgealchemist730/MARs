import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from 'fs'
import { join, relative } from 'path'
import {
  FragmentStore,
  type FragmentMeta,
  type FragmentType,
} from '../fragment-store'
import { ClaimGraph } from '../claim-graph/index'
import type { ClaimGraphData, ClaimPhase } from '../claim-graph/types'
import { chatCompletion } from '../llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import { TemplateResolver } from './template-resolver'

// ── Types ────────────────────────────────────────────────

export interface PaperStructure {
  title: string
  template: string // neurips, icml, aaai, acl, custom
  sections: SectionPlan[]
  max_pages: number
}

export interface SectionPlan {
  name: string // filename-safe: introduction, related-work, methodology, etc.
  title: string // display title: "Introduction", "Related Work", etc.
  fragments: string[] // fragment IDs assigned to this section
  needs_transition: boolean // whether to generate connecting text
}

export interface AssemblyResult {
  main_tex: string
  section_files: string[]
  warnings: string[]
  estimated_pages: number
}

// ── Default structure ────────────────────────────────────

const DEFAULT_SECTIONS: SectionPlan[] = [
  {
    name: 'abstract',
    title: 'Abstract',
    fragments: [],
    needs_transition: false,
  },
  {
    name: 'introduction',
    title: 'Introduction',
    fragments: [],
    needs_transition: true,
  },
  {
    name: 'related-work',
    title: 'Related Work',
    fragments: [],
    needs_transition: true,
  },
  {
    name: 'methodology',
    title: 'Methodology',
    fragments: [],
    needs_transition: true,
  },
  {
    name: 'experiments',
    title: 'Experiments',
    fragments: [],
    needs_transition: true,
  },
  { name: 'results', title: 'Results', fragments: [], needs_transition: true },
  {
    name: 'conclusion',
    title: 'Conclusion',
    fragments: [],
    needs_transition: false,
  },
]

// ── Section-type mapping ─────────────────────────────────

const TYPE_TO_SECTION: Record<FragmentType, string> = {
  related_work: 'related-work',
  definitions: 'methodology',
  algorithms: 'methodology',
  proofs: 'methodology',
  derivations: 'methodology',
  experiments: 'experiments',
  figures: 'results',
  tables: 'results',
}

// ── PaperAssembler ───────────────────────────────────────

export class PaperAssembler {
  private projectDir: string
  private store: FragmentStore
  private resolver: TemplateResolver

  constructor(projectDir: string) {
    this.projectDir = projectDir
    this.store = new FragmentStore(projectDir)
    this.resolver = new TemplateResolver()
  }

  /**
   * Auto-assign unassigned fragments to sections based on type and claim phase.
   *
   * When claimGraph is provided, fragments are routed by their related claims:
   *   - Any admitted claim → main text (by fragment type)
   *   - All claims demoted (none admitted) → discussion/limitation
   *   - All claims rejected/retracted → excluded from paper
   *   - No related_claims → type-based assignment (backward compatible)
   */
  autoAssign(
    structure: PaperStructure,
    claimGraph?: ClaimGraphData,
  ): PaperStructure {
    const allFragments = this.store.list()
    const assigned = new Set(structure.sections.flatMap(s => s.fragments))
    const unassigned = allFragments.filter(f => !assigned.has(f.id))

    const { mainText, discussion } = this.classifyFragments(
      unassigned,
      claimGraph,
    )

    // Main-text fragments: assign by type
    for (const fragment of mainText) {
      const targetSection = TYPE_TO_SECTION[fragment.type]
      if (!targetSection) continue

      const section = structure.sections.find(s => s.name === targetSection)
      if (section) {
        section.fragments.push(fragment.id)
        assigned.add(fragment.id)
      }
    }

    // Discussion fragments: route to discussion section
    if (discussion.length > 0) {
      let discSection = structure.sections.find(s => s.name === 'discussion')
      if (!discSection) {
        discSection = {
          name: 'discussion',
          title: 'Discussion and Limitations',
          fragments: [],
          needs_transition: true,
        }
        const conclusionIdx = structure.sections.findIndex(
          s => s.name === 'conclusion',
        )
        if (conclusionIdx >= 0) {
          structure.sections.splice(conclusionIdx, 0, discSection)
        } else {
          structure.sections.push(discSection)
        }
      }
      for (const frag of discussion) {
        discSection.fragments.push(frag.id)
        assigned.add(frag.id)
      }
    }

    // Excluded fragments (rejected/retracted claims) are not assigned

    return structure
  }

  /**
   * Classify fragments by claim phase.
   *   admitted → mainText, demoted-only → discussion, rejected-only → excluded.
   *   No related_claims or no claimGraph → mainText (backward compatible).
   */
  private classifyFragments(
    fragments: FragmentMeta[],
    claimGraph?: ClaimGraphData,
  ): {
    mainText: FragmentMeta[]
    discussion: FragmentMeta[]
    excluded: FragmentMeta[]
  } {
    if (!claimGraph) {
      return { mainText: fragments, discussion: [], excluded: [] }
    }

    const graph = ClaimGraph.fromJSON(claimGraph)
    const mainText: FragmentMeta[] = []
    const discussion: FragmentMeta[] = []
    const excluded: FragmentMeta[] = []

    for (const frag of fragments) {
      if (frag.related_claims.length === 0) {
        mainText.push(frag)
        continue
      }

      const phases = frag.related_claims
        .map(id => graph.getClaim(id)?.phase)
        .filter((p): p is ClaimPhase => p != null)

      if (phases.length === 0) {
        // Claims not found in graph — keep in main text
        mainText.push(frag)
        continue
      }

      const hasAdmitted = phases.includes('admitted')
      const allRejected = phases.every(
        p => p === 'rejected' || p === 'retracted',
      )

      if (hasAdmitted) {
        mainText.push(frag)
      } else if (allRejected) {
        excluded.push(frag)
      } else {
        // demoted / proposed / under_investigation with no admitted → discussion
        discussion.push(frag)
      }
    }

    return { mainText, discussion, excluded }
  }

  /**
   * Assemble the paper from fragments into a compilable LaTeX project.
   * When claimGraph is provided, fragment placement is driven by claim phases.
   */
  async assemble(
    structure: PaperStructure,
    claimGraph?: ClaimGraphData,
  ): Promise<AssemblyResult> {
    const paperDir = join(this.projectDir, 'paper')
    const sectionsDir = join(paperDir, 'sections')
    mkdirSync(sectionsDir, { recursive: true })

    const warnings: string[] = []
    const sectionFiles: string[] = []

    // Auto-assign unassigned fragments (claim-phase-aware when graph provided)
    structure = this.autoAssign(structure, claimGraph)

    // Generate each section file
    for (const section of structure.sections) {
      const filePath = join(sectionsDir, `${section.name}.tex`)
      const content = await this.buildSection(section, warnings)
      writeFileSync(filePath, content, 'utf-8')
      sectionFiles.push(filePath)
    }

    // Generate main.tex from template
    const mainTex = this.buildMainTex(structure)
    const mainPath = join(paperDir, 'main.tex')
    writeFileSync(mainPath, mainTex, 'utf-8')

    // Copy bibliography if exists
    const bibSrc = join(this.projectDir, 'bibliography.bib')
    if (existsSync(bibSrc)) {
      copyFileSync(bibSrc, join(paperDir, 'references.bib'))
    }

    // Auto-generate transitions between fragments
    await this.generateTransitions(structure)

    // Check for unassigned fragments
    const assignedIds = new Set(structure.sections.flatMap(s => s.fragments))
    const unassigned = this.store.list().filter(f => !assignedIds.has(f.id))
    if (unassigned.length > 0) {
      warnings.push(
        `${unassigned.length} fragments not assigned to any section: ${unassigned.map(f => f.id).join(', ')}`,
      )
    }

    // Estimate pages
    const estimatedPages = this.store.estimatePages()

    return {
      main_tex: mainPath,
      section_files: sectionFiles,
      warnings,
      estimated_pages: estimatedPages,
    }
  }

  /**
   * Build content for a single section by combining its fragments.
   */
  private async buildSection(
    section: SectionPlan,
    warnings: string[],
  ): Promise<string> {
    const lines: string[] = []

    if (section.name === 'abstract') {
      // Abstract is special — usually a single fragment or generated
      if (section.fragments.length > 0) {
        const content = this.store.readContent(section.fragments[0])
        if (content) {
          lines.push('\\begin{abstract}')
          lines.push(content)
          lines.push('\\end{abstract}')
        }
      } else {
        lines.push('\\begin{abstract}')
        lines.push('% TODO: Write abstract after all sections are complete')
        lines.push('\\end{abstract}')
      }
      return lines.join('\n')
    }

    lines.push(`\\section{${section.title}}`)
    lines.push('')

    if (section.fragments.length === 0) {
      lines.push(`% TODO: No fragments assigned to ${section.title}`)
      warnings.push(`Section "${section.title}" has no fragments assigned`)
      return lines.join('\n')
    }

    for (let i = 0; i < section.fragments.length; i++) {
      const fragId = section.fragments[i]
      const meta = this.store.get(fragId)

      if (!meta) {
        warnings.push(`Fragment "${fragId}" not found`)
        lines.push(`% WARNING: Fragment "${fragId}" not found`)
        continue
      }

      const content = this.store.readContent(fragId)
      if (!content) {
        warnings.push(`Fragment "${fragId}" has no content`)
        continue
      }

      // Add fragment content
      lines.push(`% --- Fragment: ${meta.title} (${fragId}) ---`)
      lines.push(content)
      lines.push('')

      // Add transition placeholder between fragments
      if (section.needs_transition && i < section.fragments.length - 1) {
        lines.push('% TODO: Add transition to next subsection')
        lines.push('')
      }
    }

    return lines.join('\n')
  }

  /**
   * Generate main.tex using the selected template.
   */
  private buildMainTex(structure: PaperStructure): string {
    let templatePath: string
    try {
      templatePath = this.resolver.getMainTexPath(structure.template)
    } catch {
      templatePath = ''
    }

    if (existsSync(templatePath)) {
      // Read template and replace section inputs
      let template = readFileSync(templatePath, 'utf-8')

      // Replace the \input{sections/...} block with our sections
      const sectionInputs = structure.sections
        .map(s => `\\input{sections/${s.name}}`)
        .join('\n')

      // Find and replace the section input block
      const inputPattern =
        /\\input\{sections\/[^}]+\}(\s*\\input\{sections\/[^}]+\})*/
      if (inputPattern.test(template)) {
        template = template.replace(inputPattern, sectionInputs)
      }

      // Replace title
      template = template.replace(
        /\\title\{[^}]*\}/,
        `\\title{${structure.title}}`,
      )

      return template
    }

    // Fallback: generate a basic main.tex
    const sectionInputs = structure.sections
      .map(s => `\\input{sections/${s.name}}`)
      .join('\n')

    return `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb,graphicx,booktabs,hyperref,natbib}

\\title{${structure.title}}
\\author{Author}

\\begin{document}
\\maketitle

${sectionInputs}

\\bibliographystyle{plainnat}
\\bibliography{references}
\\end{document}
`
  }

  /**
   * Generate transition text between fragments using LLM.
   */
  async generateTransitions(structure: PaperStructure): Promise<void> {
    const paperDir = join(this.projectDir, 'paper', 'sections')

    for (const section of structure.sections) {
      if (!section.needs_transition || section.fragments.length < 2) continue

      const filePath = join(paperDir, `${section.name}.tex`)
      if (!existsSync(filePath)) continue

      let content = readFileSync(filePath, 'utf-8')

      // Replace TODO transition placeholders with LLM-generated text
      if (!content.includes('% TODO: Add transition')) continue

      const response = await chatCompletion({
        modelSpec: DEFAULT_MODEL_ASSIGNMENTS.writing,
        max_tokens: 16384,
        messages: [
          {
            role: 'user',
            content: `Given this LaTeX section, replace each "% TODO: Add transition to next subsection" comment with a brief 1-2 sentence transition paragraph. Keep it natural and academic.

Only output the complete section content with transitions filled in. No explanations.

${content}`,
          },
        ],
      })

      if (
        response.text.includes('\\section') ||
        response.text.includes('\\subsection')
      ) {
        writeFileSync(filePath, response.text, 'utf-8')
      }
    }
  }

  /**
   * Validate the assembled paper for common issues.
   */
  validate(structure: PaperStructure): string[] {
    const issues: string[] = []
    const paperDir = join(this.projectDir, 'paper')

    // Check main.tex exists
    if (!existsSync(join(paperDir, 'main.tex'))) {
      issues.push('main.tex not found')
    }

    // Check all section files exist
    for (const section of structure.sections) {
      const filePath = join(paperDir, 'sections', `${section.name}.tex`)
      if (!existsSync(filePath)) {
        issues.push(`Missing section file: sections/${section.name}.tex`)
      }
    }

    // Check bibliography
    const bibPath = join(paperDir, 'references.bib')
    if (!existsSync(bibPath)) {
      issues.push('references.bib not found (bibliography may be missing)')
    }

    // Check page limit
    const estimatedPages = this.store.estimatePages()
    if (estimatedPages > structure.max_pages) {
      issues.push(
        `Estimated ${estimatedPages} pages exceeds max ${structure.max_pages}`,
      )
    }

    // ── Validate \cite{} references ──────────────────────
    const bibPath2 = join(paperDir, 'references.bib')
    const bibKeys = new Set<string>()
    if (existsSync(bibPath2)) {
      try {
        const bibContent = readFileSync(bibPath2, 'utf-8')
        const bibKeyRegex = /@\w+\{([^,\s]+),/g
        let bibMatch: RegExpExecArray | null
        while ((bibMatch = bibKeyRegex.exec(bibContent)) !== null) {
          bibKeys.add(bibMatch[1])
        }
      } catch {
        // Skip bib validation if we can't read it
      }
    }

    // ── Validate \ref{} labels ───────────────────────────
    const allLabels = new Set<string>()
    const allRefs = new Set<string>()
    const allCites = new Set<string>()

    const sectionsDir = join(paperDir, 'sections')
    for (const section of structure.sections) {
      const filePath = join(sectionsDir, `${section.name}.tex`)
      if (!existsSync(filePath)) continue

      try {
        const content = readFileSync(filePath, 'utf-8')

        // Collect \label{...}
        const labelRegex = /\\label\{([^}]+)\}/g
        let labelMatch: RegExpExecArray | null
        while ((labelMatch = labelRegex.exec(content)) !== null) {
          allLabels.add(labelMatch[1])
        }

        // Collect \ref{...} and \eqref{...}
        const refRegex = /\\(?:eq)?ref\{([^}]+)\}/g
        let refMatch: RegExpExecArray | null
        while ((refMatch = refRegex.exec(content)) !== null) {
          allRefs.add(refMatch[1])
        }

        // Collect \cite{...} (handles comma-separated keys)
        const citeRegex = /\\cite[tp]?\{([^}]+)\}/g
        let citeMatch: RegExpExecArray | null
        while ((citeMatch = citeRegex.exec(content)) !== null) {
          for (const key of citeMatch[1].split(',')) {
            allCites.add(key.trim())
          }
        }
      } catch {
        // Skip file on read error
      }
    }

    // Check for broken \ref{} references
    for (const ref of allRefs) {
      if (!allLabels.has(ref)) {
        issues.push(`Broken \\ref{${ref}}: no matching \\label found`)
      }
    }

    // Check for broken \cite{} references
    if (bibKeys.size > 0) {
      for (const cite of allCites) {
        if (!bibKeys.has(cite)) {
          issues.push(`Broken \\cite{${cite}}: key not found in references.bib`)
        }
      }
    }

    return issues
  }

  /**
   * Create a default structure from available fragments.
   */
  createDefaultStructure(title: string, template = 'neurips'): PaperStructure {
    let maxPages = 10
    try {
      const constraints = this.resolver.getConstraints(template)
      if (
        constraints &&
        typeof constraints.page_limits.main_body === 'number'
      ) {
        maxPages = constraints.page_limits.main_body
      }
    } catch {
      // Use default if resolver fails
    }

    return {
      title,
      template,
      sections: DEFAULT_SECTIONS.map(s => ({ ...s, fragments: [] })),
      max_pages: maxPages,
    }
  }
}
