import type { Command } from '@commands'
import { importFromZotero } from '../paper/zotero-import'
import { join } from 'path'

const zoteroImport: Command = {
  type: 'local',
  name: 'zotero-import',
  userFacingName() {
    return 'zotero-import'
  },
  description: 'Import papers from a Zotero library into the project',
  isEnabled: true,
  isHidden: false,
  argumentHint: '[path-to-zotero-data-dir]',
  aliases: ['zotero'],

  async call(args: string): Promise<string> {
    const zoteroPath = args.trim() || ''
    const outputDir = join(process.cwd(), 'literature', 'papers')

    const result = await importFromZotero(zoteroPath, outputDir)

    const lines: string[] = []

    if (result.errors.length > 0 && result.imported === 0) {
      lines.push('Zotero import failed:')
      for (const err of result.errors) {
        lines.push(`  - ${err}`)
      }
      return lines.join('\n')
    }

    lines.push(`Zotero import complete:`)
    lines.push(`  Imported: ${result.imported} paper(s)`)
    lines.push(`  Skipped: ${result.skipped} (already imported or no PDF)`)

    if (result.papers.length > 0) {
      lines.push('')
      lines.push('Imported papers:')
      for (const paper of result.papers.slice(0, 10)) {
        const authorStr =
          paper.authors.length > 0 ? ` (${paper.authors[0]})` : ''
        const yearStr = paper.year > 0 ? ` [${paper.year}]` : ''
        lines.push(`  - ${paper.title}${authorStr}${yearStr}`)
      }
      if (result.papers.length > 10) {
        lines.push(`  ... and ${result.papers.length - 10} more`)
      }
    }

    if (result.errors.length > 0) {
      lines.push('')
      lines.push('Warnings:')
      for (const err of result.errors) {
        lines.push(`  - ${err}`)
      }
    }

    return lines.join('\n')
  },
}

export default zoteroImport
