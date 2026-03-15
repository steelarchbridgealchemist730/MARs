import type { Command } from '@commands'
import { FragmentStore, type FragmentType } from '../paper/fragment-store'
import { join } from 'path'

const VALID_TYPES: FragmentType[] = [
  'proofs',
  'derivations',
  'algorithms',
  'definitions',
  'experiments',
  'related_work',
  'figures',
  'tables',
]

function handleFragments(args: string): string {
  const projectDir = join(process.cwd(), '.claude-paper-research')
  const store = new FragmentStore(projectDir)
  const parts = args.trim().split(/\s+/)
  const subcommand = parts[0] ?? ''

  if (!subcommand || subcommand === 'list') {
    // /fragments or /fragments list [type]
    const filterType = parts[1] as FragmentType | undefined
    const fragments = store.list(
      filterType && VALID_TYPES.includes(filterType) ? filterType : undefined,
    )

    if (fragments.length === 0) {
      return 'No fragments found. Use /fragments new <type> "title" to create one.'
    }

    const lines = [`Fragments (${fragments.length}):\n`]
    const grouped: Record<string, typeof fragments> = {}

    for (const f of fragments) {
      if (!grouped[f.type]) grouped[f.type] = []
      grouped[f.type].push(f)
    }

    for (const [type, frags] of Object.entries(grouped)) {
      lines.push(`  ${type}/`)
      for (const f of frags) {
        const statusIcon =
          f.status === 'finalized'
            ? '[done]'
            : f.status === 'reviewed'
              ? '[reviewed]'
              : '[draft]'
        lines.push(`    ${statusIcon} ${f.id}: ${f.title}`)
      }
    }

    // Show paper structure if defined
    const structure = store.getPaperStructure()
    if (Object.keys(structure).length > 0) {
      lines.push('\nPaper Structure:')
      for (const [section, ids] of Object.entries(structure)) {
        lines.push(`  ${section}: ${ids.join(', ')}`)
      }
    }

    // Show unassigned
    const unassigned = store.getUnassigned()
    if (unassigned.length > 0) {
      lines.push(`\nUnassigned: ${unassigned.map(f => f.id).join(', ')}`)
    }

    lines.push(`\nEstimated total: ~${store.estimatePages().toFixed(1)} pages`)

    return lines.join('\n')
  }

  if (subcommand === 'show') {
    const id = parts[1]
    if (!id) return 'Usage: /fragments show <id>'

    const content = store.readContent(id)
    const meta = store.get(id)
    if (!content || !meta) return `Fragment "${id}" not found.`

    return [
      `Fragment: ${meta.id}`,
      `Type: ${meta.type} | Status: ${meta.status} | By: ${meta.created_by}`,
      `Title: ${meta.title}`,
      `File: ${meta.file_path}`,
      meta.notes ? `Notes: ${meta.notes}` : '',
      `Est. pages: ${meta.estimated_pages}`,
      '',
      '--- Content ---',
      content,
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (subcommand === 'new') {
    const type = parts[1] as FragmentType
    if (!type || !VALID_TYPES.includes(type)) {
      return `Usage: /fragments new <type> "title"\nValid types: ${VALID_TYPES.join(', ')}`
    }

    // Extract title from remaining args (may be quoted)
    const titleStart = args.indexOf(type) + type.length
    const title = args
      .slice(titleStart)
      .trim()
      .replace(/^["']|["']$/g, '')

    if (!title) {
      return 'Please provide a title: /fragments new <type> "title"'
    }

    store.init()
    const meta = store.create(
      type,
      title,
      `% ${title}\n% TODO: Write content\n`,
    )

    return `Created fragment: ${meta.id}\nFile: ${meta.file_path}\nEdit the .tex file to add content.`
  }

  if (subcommand === 'init') {
    store.init()
    return 'Fragment directory structure initialized.'
  }

  return [
    'Usage:',
    '  /fragments              List all fragments',
    '  /fragments list [type]  List fragments by type',
    '  /fragments show <id>    Show fragment content',
    '  /fragments new <type> "title"  Create new fragment',
    '  /fragments init         Initialize fragment directories',
    '',
    `Valid types: ${VALID_TYPES.join(', ')}`,
  ].join('\n')
}

const fragments: Command = {
  type: 'local',
  name: 'fragments',
  userFacingName() {
    return 'fragments'
  },
  description: 'Manage LaTeX fragments (list, show, create)',
  isEnabled: true,
  isHidden: false,
  argumentHint: '[list|show|new|init] [args...]',
  aliases: ['frag'],

  async call(args: string): Promise<string> {
    return handleFragments(args)
  },
}

export default fragments
