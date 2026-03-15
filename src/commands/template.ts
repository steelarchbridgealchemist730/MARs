import { resolve as resolvePath } from 'path'
import type { Command } from '@commands'
import { TemplateResolver } from '../paper/writing/template-resolver'
import { loadConfig, saveConfig } from '../paper/config-io'

async function handleTemplate(args: string): Promise<string> {
  const resolver = new TemplateResolver()
  const parts = args.trim().split(/\s+/)
  const subcommand = parts[0] ?? ''

  // /template or /template list
  if (!subcommand || subcommand === 'list') {
    const templates = resolver.listTemplates()
    const config = loadConfig()
    const activeId = config.paper?.template ?? resolver.getDefaultTemplateId()

    const lines = ['Available templates:\n']
    for (const t of templates) {
      const isActive = t.id === activeId || t.aliases.includes(activeId)
      const marker = isActive ? ' (active)' : ''
      const aliases =
        t.aliases.length > 1
          ? ` [aliases: ${t.aliases.filter(a => a !== t.id).join(', ')}]`
          : ''
      lines.push(
        `  ${isActive ? '>' : ' '} ${t.id.padEnd(10)} ${t.name}${marker}${aliases}`,
      )
      lines.push(`    ${t.venue_type} | ${t.field}`)
    }
    lines.push(
      '\nUsage: /template switch <name> | /template info <name> | /template constraints',
    )
    return lines.join('\n')
  }

  // /template switch <name>
  if (subcommand === 'switch') {
    const name = parts[1]
    if (!name) return 'Usage: /template switch <name>'

    try {
      const resolved = resolver.resolve(name)
      const config = loadConfig()

      const oldTemplate = config.paper?.template ?? 'neurips'
      config.paper = config.paper ?? {}
      config.paper.template = resolved.manifest.id
      config.paper.compiler = resolved.manifest.compilation.engine

      if (
        resolved.constraints &&
        typeof resolved.constraints.page_limits.main_body === 'number'
      ) {
        config.paper.max_pages = resolved.constraints.page_limits.main_body
      }

      saveConfig(config)

      const changes = [
        `Template switched: ${oldTemplate} -> ${resolved.manifest.id}`,
        `  Name: ${resolved.manifest.name}`,
        `  Compiler: ${resolved.manifest.compilation.engine}`,
      ]
      if (
        resolved.constraints &&
        typeof resolved.constraints.page_limits.main_body === 'number'
      ) {
        changes.push(
          `  Max pages: ${resolved.constraints.page_limits.main_body}`,
        )
      }
      return changes.join('\n')
    } catch (e: any) {
      return e.message
    }
  }

  // /template info <name>
  if (subcommand === 'info') {
    const name = parts[1]
    if (!name) {
      // Show info for active template
      const config = loadConfig()
      const activeId = config.paper?.template ?? resolver.getDefaultTemplateId()
      return showTemplateInfo(resolver, activeId)
    }
    return showTemplateInfo(resolver, name)
  }

  // /template install <path-or-url>
  if (subcommand === 'install') {
    const source = parts.slice(1).join(' ')
    if (!source) return 'Usage: /template install <path-or-url>'
    return await installTemplate(resolver, source)
  }

  // /template constraints — show active template's constraints
  if (subcommand === 'constraints') {
    const config = loadConfig()
    const activeId = config.paper?.template ?? resolver.getDefaultTemplateId()
    return showConstraints(resolver, parts[1] ?? activeId)
  }

  return [
    'Usage:',
    '  /template              List available templates',
    '  /template list         List available templates',
    '  /template switch <name>  Switch active template',
    '  /template info [name]  Show template details',
    '  /template constraints [name]  Show venue constraints',
    '  /template install <path-or-url>  Install a custom template from a local directory or URL',
  ].join('\n')
}

function isUrl(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://')
}

async function installTemplate(
  resolver: TemplateResolver,
  source: string,
): Promise<string> {
  try {
    let entry
    if (isUrl(source)) {
      entry = await resolver.installFromUrl(source)
    } else {
      const absPath = resolvePath(source)
      entry = resolver.installFromLocal(absPath)
    }
    return [
      `Template installed successfully:`,
      `  ID: ${entry.id}`,
      `  Name: ${entry.name}`,
      `  Type: ${entry.venue_type} | Field: ${entry.field}`,
      ``,
      `Use "/template switch ${entry.id}" to activate it.`,
    ].join('\n')
  } catch (e: any) {
    return `Failed to install template: ${e.message}`
  }
}

function showTemplateInfo(resolver: TemplateResolver, name: string): string {
  try {
    const resolved = resolver.resolve(name)
    const m = resolved.manifest
    const lines = [
      `Template: ${m.id}`,
      `  Name: ${m.name}`,
      `  Type: ${m.venue_type} | Field: ${m.field}`,
      `  Description: ${m.description}`,
      `  Main file: ${m.template_files.main}`,
      `  Compiler: ${m.compilation.engine}`,
      `  BibTeX: ${m.compilation.bibtex}`,
      `  Sequence: ${m.compilation.sequence.join(' -> ')}`,
    ]
    if (m.compilation.extra_packages.length > 0) {
      lines.push(`  Packages: ${m.compilation.extra_packages.join(', ')}`)
    }
    if (resolved.constraints) {
      const c = resolved.constraints
      lines.push('')
      lines.push('  Constraints:')
      lines.push(`    Main body pages: ${c.page_limits.main_body}`)
      lines.push(`    Columns: ${c.formatting.columns}`)
      lines.push(`    Abstract limit: ${c.structure.abstract_word_limit} words`)
      lines.push(
        `    Required sections: ${c.structure.required_sections.join(', ')}`,
      )
    }
    return lines.join('\n')
  } catch (e: any) {
    return e.message
  }
}

function showConstraints(resolver: TemplateResolver, name: string): string {
  try {
    const constraints = resolver.getConstraints(name)
    if (!constraints) return `No constraints defined for template "${name}".`

    const c = constraints
    const lines = [
      `Venue constraints for "${name}":\n`,
      'Page Limits:',
      `  Main body: ${c.page_limits.main_body}`,
      `  References: ${c.page_limits.references}`,
      `  Appendix: ${c.page_limits.appendix}`,
      c.page_limits.total_with_appendix != null
        ? `  Total with appendix: ${c.page_limits.total_with_appendix}`
        : null,
      '',
      'Structure:',
      `  Required: ${c.structure.required_sections.join(', ')}`,
      `  Optional: ${c.structure.optional_sections.join(', ')}`,
      `  Abstract limit: ${c.structure.abstract_word_limit} words`,
      '',
      'Formatting:',
      `  Columns: ${c.formatting.columns}`,
      `  Font size: ${c.formatting.font_size}`,
      c.formatting.citation_style
        ? `  Citation style: ${c.formatting.citation_style}`
        : null,
      '',
      'Writing Guidelines:',
      `  Strategy: ${c.writing_guidelines.main_body_strategy}`,
      c.writing_guidelines.proof_strategy
        ? `  Proofs: ${c.writing_guidelines.proof_strategy}`
        : null,
      c.writing_guidelines.related_work_placement
        ? `  Related work: ${c.writing_guidelines.related_work_placement}`
        : null,
    ]

    if (Object.keys(c.writing_guidelines.page_budget).length > 0) {
      lines.push('')
      lines.push('Page Budget:')
      for (const [section, pages] of Object.entries(
        c.writing_guidelines.page_budget,
      )) {
        lines.push(`  ${section}: ~${pages} pages`)
      }
    }

    if (c.common_pitfalls.length > 0) {
      lines.push('')
      lines.push('Common Pitfalls:')
      for (const pitfall of c.common_pitfalls) {
        lines.push(`  - ${pitfall}`)
      }
    }

    return lines.filter(l => l != null).join('\n')
  } catch (e: any) {
    return e.message
  }
}

const template: Command = {
  type: 'local',
  name: 'template',
  userFacingName() {
    return 'template'
  },
  description:
    'Manage LaTeX templates (list, switch, info, constraints, install)',
  isEnabled: true,
  isHidden: false,
  argumentHint: '[list|switch|info|constraints|install] [name|path|url]',
  aliases: ['tpl'],

  async call(args: string): Promise<string> {
    return handleTemplate(args)
  },
}

export default template
