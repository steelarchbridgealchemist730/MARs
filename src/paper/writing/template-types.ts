export interface TemplateManifest {
  id: string
  name: string
  venue_type: 'conference' | 'journal' | 'workshop' | 'preprint'
  field: string
  description: string
  template_files: {
    main: string
    style?: string
    math_commands?: string
    makefile?: string
  }
  compilation: {
    engine: 'pdflatex' | 'xelatex' | 'lualatex'
    bibtex: 'bibtex' | 'biber'
    sequence: string[]
    extra_packages: string[]
  }
}

export interface VenueConstraints {
  page_limits: {
    main_body: number | 'unlimited'
    references: number | 'unlimited'
    appendix: number | 'unlimited'
    total_with_appendix?: number | null
  }
  structure: {
    required_sections: string[]
    optional_sections: string[]
    appendix_typical?: string[]
    abstract_word_limit: number | 'unlimited'
  }
  formatting: {
    columns: 1 | 2
    font_size: string
    figure_placement?: string
    table_style?: string
    citation_style?: string
    max_figure_width_single_col?: string
    max_figure_width_double_col?: string
  }
  writing_guidelines: {
    main_body_strategy: string
    figure_strategy?: string
    table_strategy?: string
    proof_strategy?: string
    related_work_placement?: string
    page_budget: Record<string, number>
  }
  common_pitfalls: string[]
}

export interface TemplateRegistryEntry {
  id: string
  name: string
  aliases: string[]
  venue_type: string
  field: string
  path: string
}

export interface TemplateRegistry {
  version: number
  default_template: string
  templates: TemplateRegistryEntry[]
}

export interface ResolvedTemplate {
  manifest: TemplateManifest
  constraints: VenueConstraints | null
  directory: string
}
