import React, { useState, useMemo, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import type { DKPLoader } from '../../../../paper/domain-knowledge/loader'
import type {
  LoadedDKP,
  KnowledgeEntry,
  KnowledgeEntryType,
} from '../../../../paper/domain-knowledge/types'
import { useFullscreenDimensions } from '../../FullscreenLayout'
import { getTheme } from '@utils/theme'

// ── Types ─────────────────────────────────────────────

type NavLevel =
  | { type: 'pack_list' }
  | { type: 'pack_detail'; packName: string }
  | {
      type: 'direction_entries'
      packName: string
      directionId: string
      directionName: string
    }
  | { type: 'type_entries'; packName: string; entryType: KnowledgeEntryType }
  | {
      type: 'search_results'
      packName: string
      query: string
      entryIds: string[]
    }
  | {
      type: 'technique_results'
      packName: string
      technique: string
      entryIds: string[]
    }
  | { type: 'entry_detail'; packName: string; entryId: string }
  | { type: 'assumption_gap'; packName: string; entryId: string }

export interface DomainKnowledgePanelProps {
  loader: DKPLoader
  onDone: () => void
  onFooterChange?: (footer: React.ReactNode) => void
}

// ── Type display helpers ────────────────────────────────

const TYPE_ICON: Record<KnowledgeEntryType, string> = {
  theorem: 'T',
  proposition: 'P',
  lemma: 'L',
  corollary: 'C',
  definition: 'D',
  algorithm: 'A',
  result: 'R',
}

const TYPE_ORDER: KnowledgeEntryType[] = [
  'theorem',
  'definition',
  'lemma',
  'proposition',
  'corollary',
  'algorithm',
  'result',
]

// ── Search helpers (exported for testing) ───────────────

export function searchEntries(
  pack: LoadedDKP,
  query: string,
  maxResults = 20,
): string[] {
  if (!query.trim()) return []

  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 0)
  const scores = new Map<string, number>()

  // Search fullText index
  for (const token of tokens) {
    for (const [keyword, ids] of Object.entries(pack.indices.fullText)) {
      if (keyword.toLowerCase().includes(token)) {
        for (const id of ids) {
          scores.set(id, (scores.get(id) ?? 0) + 1)
        }
      }
    }
  }

  // Search byTopic index
  for (const token of tokens) {
    for (const [topic, ids] of Object.entries(pack.indices.byTopic)) {
      if (topic.toLowerCase().includes(token)) {
        for (const id of ids) {
          scores.set(id, (scores.get(id) ?? 0) + 2) // topic matches weighted higher
        }
      }
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults)
    .map(([id]) => id)
}

export function findByTechnique(
  loader: DKPLoader,
  packName: string,
  technique: string,
): string[] {
  const pack = loader.getLoadedPack(packName)
  if (!pack) return []

  const query = technique.toLowerCase().trim()
  if (!query) return []

  const theoremIds = pack.indices.byType.theorem ?? []
  const matches: string[] = []

  for (const id of theoremIds) {
    const entry = loader.getEntry(packName, id)
    if (
      entry?.proof_technique &&
      entry.proof_technique.toLowerCase().includes(query)
    ) {
      matches.push(id)
    }
  }

  return matches
}

// ── Component ─────────────────────────────────────────────

export function DomainKnowledgePanel({
  loader,
  onDone,
  onFooterChange,
}: DomainKnowledgePanelProps): React.ReactNode {
  const { contentHeight, contentWidth } = useFullscreenDimensions()
  const theme = getTheme()

  const [navStack, setNavStack] = useState<NavLevel[]>([{ type: 'pack_list' }])
  const [cursor, setCursor] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [searchMode, setSearchMode] = useState<'off' | 'search' | 'technique'>(
    'off',
  )
  const [searchQuery, setSearchQuery] = useState('')

  const current = navStack[navStack.length - 1]
  const packs = useMemo(() => loader.getLoadedPacks(), [loader])

  // Update footer when navigation changes
  useEffect(() => {
    if (!onFooterChange) return

    if (searchMode !== 'off') {
      const label = searchMode === 'search' ? 'Search' : 'Technique'
      onFooterChange(
        <Text dimColor>{label}: type query, Enter: submit, Esc: cancel</Text>,
      )
      return
    }

    switch (current.type) {
      case 'pack_list':
        onFooterChange(
          <Text dimColor>
            Up/Down: navigate{'  '}Enter: details{'  '}Esc: back to claims
          </Text>,
        )
        break
      case 'pack_detail':
        onFooterChange(
          <Text dimColor>
            Up/Down: navigate{'  '}Enter: browse{'  '}/: search{'  '}t:
            technique{'  '}Esc: back
          </Text>,
        )
        break
      case 'direction_entries':
      case 'type_entries':
      case 'search_results':
      case 'technique_results':
        onFooterChange(
          <Text dimColor>
            Up/Down: navigate{'  '}Enter: details{'  '}Esc: back
          </Text>,
        )
        break
      case 'entry_detail':
        onFooterChange(
          <Text dimColor>
            Up/Down: scroll{'  '}d: deps{'  '}u: used-by{'  '}r: related{'  '}
            a: assumptions{'  '}Esc: back
          </Text>,
        )
        break
      case 'assumption_gap':
        onFooterChange(<Text dimColor>Up/Down: scroll{'  '}Esc: back</Text>)
        break
    }
  }, [current, searchMode, onFooterChange])

  // Helper: push a new nav level
  function pushNav(level: NavLevel) {
    setNavStack(s => [...s, level])
    setCursor(0)
    setScrollOffset(0)
  }

  // Helper: pop one level
  function popNav() {
    if (navStack.length <= 1) {
      onDone()
      return
    }
    setNavStack(s => s.slice(0, -1))
    setCursor(0)
    setScrollOffset(0)
  }

  // Get entries for current entry-list levels
  function getEntryIdsForLevel(level: NavLevel): string[] {
    switch (level.type) {
      case 'direction_entries': {
        const pack = loader.getLoadedPack(level.packName)
        if (!pack) return []
        const dir = pack.directions.find(d => d.id === level.directionId)
        return dir?.key_entries ?? []
      }
      case 'type_entries': {
        const pack = loader.getLoadedPack(level.packName)
        if (!pack) return []
        return pack.indices.byType[level.entryType] ?? []
      }
      case 'search_results':
        return level.entryIds
      case 'technique_results':
        return level.entryIds
      default:
        return []
    }
  }

  // Get max cursor for current level
  function getMaxCursor(): number {
    switch (current.type) {
      case 'pack_list':
        return Math.max(0, packs.length - 1)
      case 'pack_detail': {
        const pack = loader.getLoadedPack(current.packName)
        if (!pack) return 0
        const dirCount = pack.directions.length
        const typeCount = TYPE_ORDER.filter(
          t => (pack.indices.byType[t]?.length ?? 0) > 0,
        ).length
        return Math.max(0, dirCount + typeCount - 1)
      }
      case 'direction_entries':
      case 'type_entries':
      case 'search_results':
      case 'technique_results': {
        const ids = getEntryIdsForLevel(current)
        return Math.max(0, ids.length - 1)
      }
      case 'entry_detail':
        return 0
      case 'assumption_gap':
        return 0
    }
  }

  const maxCursor = getMaxCursor()

  // Keyboard handling
  useInput(
    (input, key) => {
      if (searchMode !== 'off') return // TextInput handles keys

      if (key.upArrow) {
        if (
          current.type === 'entry_detail' ||
          current.type === 'assumption_gap'
        ) {
          setScrollOffset(o => Math.max(0, o - 1))
        } else {
          setCursor(c => Math.max(0, c - 1))
        }
        return
      }
      if (key.downArrow) {
        if (
          current.type === 'entry_detail' ||
          current.type === 'assumption_gap'
        ) {
          setScrollOffset(o => o + 1)
        } else {
          setCursor(c => Math.min(maxCursor, c + 1))
        }
        return
      }

      if (key.return) {
        handleEnter()
        return
      }

      if (key.escape) {
        popNav()
        return
      }

      // Context-specific shortcuts
      if (current.type === 'pack_detail') {
        if (input === '/') {
          setSearchMode('search')
          setSearchQuery('')
          return
        }
        if (input === 't') {
          setSearchMode('technique')
          setSearchQuery('')
          return
        }
      }

      if (current.type === 'entry_detail') {
        const packName = current.packName
        const entry = loader.getEntry(packName, current.entryId)
        if (!entry) return

        if (input === 'd' && entry.relations.depends_on.length > 0) {
          pushNav({
            type: 'search_results',
            packName,
            query: `deps of ${entry.id}`,
            entryIds: entry.relations.depends_on,
          })
          return
        }
        if (input === 'u' && entry.relations.used_by.length > 0) {
          pushNav({
            type: 'search_results',
            packName,
            query: `used-by ${entry.id}`,
            entryIds: entry.relations.used_by,
          })
          return
        }
        if (input === 'r') {
          const related = [
            ...entry.relations.specialized_by,
            ...(entry.relations.generalizes
              ? [entry.relations.generalizes]
              : []),
          ]
          if (related.length > 0) {
            pushNav({
              type: 'search_results',
              packName,
              query: `related to ${entry.id}`,
              entryIds: related,
            })
          }
          return
        }
        if (
          input === 'a' &&
          entry.assumptions &&
          entry.assumptions.length > 0
        ) {
          pushNav({
            type: 'assumption_gap',
            packName,
            entryId: entry.id,
          })
          return
        }
      }
    },
    { isActive: searchMode === 'off' },
  )

  function handleEnter() {
    switch (current.type) {
      case 'pack_list': {
        const pack = packs[cursor]
        if (pack) {
          pushNav({ type: 'pack_detail', packName: pack.manifest.name })
        }
        break
      }
      case 'pack_detail': {
        const pack = loader.getLoadedPack(current.packName)
        if (!pack) break
        const dirCount = pack.directions.length
        if (cursor < dirCount) {
          const dir = pack.directions[cursor]
          pushNav({
            type: 'direction_entries',
            packName: current.packName,
            directionId: dir.id,
            directionName: dir.name,
          })
        } else {
          const typeIdx = cursor - dirCount
          const activeTypes = TYPE_ORDER.filter(
            t => (pack.indices.byType[t]?.length ?? 0) > 0,
          )
          const selectedType = activeTypes[typeIdx]
          if (selectedType) {
            pushNav({
              type: 'type_entries',
              packName: current.packName,
              entryType: selectedType,
            })
          }
        }
        break
      }
      case 'direction_entries':
      case 'type_entries':
      case 'search_results':
      case 'technique_results': {
        const ids = getEntryIdsForLevel(current)
        const entryId = ids[cursor]
        if (entryId) {
          pushNav({
            type: 'entry_detail',
            packName:
              current.type === 'pack_list' ? '' : (current as any).packName,
            entryId,
          })
        }
        break
      }
    }
  }

  function handleSearchSubmit(query: string) {
    const packName =
      current.type === 'pack_detail' ? current.packName : undefined
    if (!packName) {
      setSearchMode('off')
      return
    }

    if (searchMode === 'search') {
      const pack = loader.getLoadedPack(packName)
      if (pack) {
        const ids = searchEntries(pack, query)
        setSearchMode('off')
        pushNav({
          type: 'search_results',
          packName,
          query,
          entryIds: ids,
        })
      } else {
        setSearchMode('off')
      }
    } else if (searchMode === 'technique') {
      const ids = findByTechnique(loader, packName, query)
      setSearchMode('off')
      pushNav({
        type: 'technique_results',
        packName,
        technique: query,
        entryIds: ids,
      })
    }
  }

  // ── Render functions ────────────────────────────────────

  function renderSearchInput(): React.ReactNode {
    const label = searchMode === 'search' ? 'Search' : 'Technique'
    return (
      <Box marginBottom={1}>
        <Text color="#818cf8" bold>
          {label}:{' '}
        </Text>
        <TextInput
          value={searchQuery}
          onChange={setSearchQuery}
          onSubmit={handleSearchSubmit}
        />
      </Box>
    )
  }

  function renderPackList(): React.ReactNode {
    if (packs.length === 0) {
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={1}>
          <Text>No knowledge packs loaded.</Text>
          <Text dimColor>Use /knowledge load to load a pack first.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold color="#818cf8">
          {'=== Knowledge Packs ==='}
        </Text>
        <Text />
        {packs.map((pack, i) => {
          const isCur = i === cursor
          const m = pack.manifest
          const sourceCount =
            (m.sources.textbooks?.length ?? 0) + (m.sources.papers?.length ?? 0)
          return (
            <Box key={m.name} flexDirection="column">
              <Box>
                <Text bold={isCur} color={isCur ? '#818cf8' : undefined}>
                  {isCur ? '> ' : '  '}
                  {m.name}
                </Text>
                <Text dimColor>
                  {'  '}
                  {m.stats.entries_total} entries | {sourceCount} sources
                </Text>
              </Box>
              <Box>
                <Text dimColor>
                  {'    '}
                  {m.description.length > contentWidth - 6
                    ? m.description.slice(0, contentWidth - 9) + '...'
                    : m.description}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  }

  function renderPackDetail(): React.ReactNode {
    if (current.type !== 'pack_detail') return null
    const pack = loader.getLoadedPack(current.packName)
    if (!pack) {
      return (
        <Box>
          <Text color={theme.error}>Pack not found: {current.packName}</Text>
        </Box>
      )
    }

    const m = pack.manifest
    const activeTypes = TYPE_ORDER.filter(
      t => (pack.indices.byType[t]?.length ?? 0) > 0,
    )

    const lines: Array<{
      text: string
      isCursor: boolean
      isDim: boolean
      isHeader: boolean
    }> = []

    // Directions section
    if (pack.directions.length > 0) {
      lines.push({
        text: `-- Directions (${pack.directions.length}) --`,
        isCursor: false,
        isDim: true,
        isHeader: true,
      })
      pack.directions.forEach((dir, i) => {
        const isCur = i === cursor
        const preview =
          dir.summary.length > contentWidth - 30
            ? dir.summary.slice(0, contentWidth - 33) + '...'
            : dir.summary
        lines.push({
          text: `${isCur ? '> ' : '  '}${dir.name} (${dir.entry_count} entries) - ${preview}`,
          isCursor: isCur,
          isDim: false,
          isHeader: false,
        })
      })
    }

    // Types section
    if (activeTypes.length > 0) {
      lines.push({
        text: `-- Entry Types --`,
        isCursor: false,
        isDim: true,
        isHeader: true,
      })
      activeTypes.forEach((type, i) => {
        const globalIdx = pack.directions.length + i
        const isCur = globalIdx === cursor
        const count = pack.indices.byType[type]?.length ?? 0
        lines.push({
          text: `${isCur ? '> ' : '  '}[${TYPE_ICON[type]}] ${type} (${count})`,
          isCursor: isCur,
          isDim: false,
          isHeader: false,
        })
      })
    }

    // Stats summary at bottom
    lines.push({ text: '', isCursor: false, isDim: true, isHeader: false })
    lines.push({
      text: `Stats: ${m.stats.entries_total} entries | ${m.stats.theorems} thms | ${m.stats.definitions} defs | ${m.stats.algorithms} algs | ${m.stats.results} results`,
      isCursor: false,
      isDim: true,
      isHeader: false,
    })
    if (
      m.stats.datasets > 0 ||
      m.stats.benchmarks > 0 ||
      m.stats.codebases > 0
    ) {
      lines.push({
        text: `Registries: ${m.stats.datasets} datasets | ${m.stats.benchmarks} benchmarks | ${m.stats.codebases} codebases`,
        isCursor: false,
        isDim: true,
        isHeader: false,
      })
    }

    const visibleLines = lines.slice(0, contentHeight)

    return (
      <Box flexDirection="column">
        <Text bold color="#818cf8">
          {`=== ${m.name} ===`}
        </Text>
        {searchMode !== 'off' && renderSearchInput()}
        {visibleLines.map((line, i) => (
          <Box key={i}>
            <Text
              bold={line.isCursor}
              color={line.isCursor ? '#818cf8' : undefined}
              dimColor={line.isDim && !line.isCursor}
            >
              {line.text}
            </Text>
          </Box>
        ))}
      </Box>
    )
  }

  function renderEntryList(): React.ReactNode {
    const ids = getEntryIdsForLevel(current)

    // Build title
    let title = 'Entries'
    switch (current.type) {
      case 'direction_entries':
        title = `Direction: ${current.directionName}`
        break
      case 'type_entries':
        title = `Type: ${current.entryType}`
        break
      case 'search_results':
        title = `Search: "${current.query}"`
        break
      case 'technique_results':
        title = `Technique: "${current.technique}"`
        break
    }

    if (ids.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold color="#818cf8">
            {`=== ${title} ===`}
          </Text>
          <Text />
          <Text dimColor>No entries found.</Text>
        </Box>
      )
    }

    const packName = (current as any).packName as string
    const visibleIds = ids.slice(0, contentHeight - 2)

    return (
      <Box flexDirection="column">
        <Text bold color="#818cf8">
          {`=== ${title} (${ids.length}) ===`}
        </Text>
        <Text />
        {visibleIds.map((id, i) => {
          const isCur = i === cursor
          const entry = loader.getEntry(packName, id)
          if (!entry) {
            return (
              <Box key={id}>
                <Text dimColor>
                  {isCur ? '> ' : '  '}[{id}] (not found)
                </Text>
              </Box>
            )
          }
          const typeIcon = TYPE_ICON[entry.type] ?? '?'
          const maxStmt = Math.max(
            10,
            contentWidth - id.length - entry.name.length - 16,
          )
          const preview =
            entry.statement.length > maxStmt
              ? entry.statement.slice(0, maxStmt - 3) + '...'
              : entry.statement
          return (
            <Box key={id}>
              <Text bold={isCur} color={isCur ? '#818cf8' : undefined}>
                {isCur ? '> ' : '  '}[{typeIcon}] {entry.label}: {entry.name}
              </Text>
              <Text dimColor={!isCur}>
                {' - '}
                {preview}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  }

  function renderEntryDetail(): React.ReactNode {
    if (current.type !== 'entry_detail') return null

    const entry = loader.getEntry(current.packName, current.entryId)
    if (!entry) {
      return (
        <Box>
          <Text color={theme.error}>Entry not found: {current.entryId}</Text>
        </Box>
      )
    }

    const lines: string[] = []
    lines.push(`[${entry.id}] ${entry.type} - ${entry.name}`)
    lines.push(`Label: ${entry.label}`)
    lines.push(
      `Source: ${entry.source.chapter}, ${entry.source.section} (p.${entry.source.page})`,
    )
    lines.push('')

    // Statement
    lines.push('Statement:')
    const stmtLines = wordWrap(entry.statement, contentWidth - 2)
    for (const sl of stmtLines) {
      lines.push(`  ${sl}`)
    }
    lines.push('')

    // Assumptions
    if (entry.assumptions && entry.assumptions.length > 0) {
      lines.push(`Assumptions (${entry.assumptions.length}):`)
      for (const a of entry.assumptions) {
        lines.push(`  [${a.strength}] ${a.text}`)
      }
      lines.push('')
    }

    // Proof info (theorem-specific)
    if (entry.proof_sketch || entry.proof_technique) {
      lines.push('Proof:')
      if (entry.proof_technique) {
        lines.push(`  Technique: ${entry.proof_technique}`)
      }
      if (entry.proof_difficulty) {
        lines.push(`  Difficulty: ${entry.proof_difficulty}`)
      }
      if (entry.proof_sketch) {
        lines.push('  Sketch:')
        const sketchLines = wordWrap(entry.proof_sketch, contentWidth - 4)
        for (const sl of sketchLines) {
          lines.push(`    ${sl}`)
        }
      }
      if (entry.full_proof_ref) {
        lines.push(`  Full proof: ${entry.full_proof_ref}`)
      }
      lines.push('')
    }

    // Algorithm-specific
    if (entry.pseudocode) {
      lines.push('Algorithm:')
      if (entry.inputs) lines.push(`  Inputs: ${entry.inputs}`)
      if (entry.outputs) lines.push(`  Outputs: ${entry.outputs}`)
      if (entry.complexity) lines.push(`  Complexity: ${entry.complexity}`)
      lines.push('  Pseudocode:')
      for (const pl of entry.pseudocode.split('\n')) {
        lines.push(`    ${pl}`)
      }
      lines.push('')
    }

    // Result-specific
    if (entry.experiment_setup || entry.key_numbers) {
      lines.push('Result:')
      if (entry.experiment_setup)
        lines.push(`  Setup: ${entry.experiment_setup}`)
      if (entry.key_numbers) lines.push(`  Key numbers: ${entry.key_numbers}`)
      if (entry.why_classic) lines.push(`  Why classic: ${entry.why_classic}`)
      lines.push('')
    }

    // Usability
    lines.push('Usability:')
    lines.push(`  Citable: ${entry.usability.citable ? 'yes' : 'no'}`)
    if (entry.usability.cite_as) {
      lines.push(`  Cite as: ${entry.usability.cite_as}`)
    }
    lines.push(`  Common use: ${entry.usability.common_use}`)
    if (entry.usability.adaptation_notes) {
      lines.push(`  Adaptation: ${entry.usability.adaptation_notes}`)
    }
    lines.push('')

    // Relations
    lines.push('Relations:')
    if (entry.relations.depends_on.length > 0) {
      lines.push(
        `  Depends on (${entry.relations.depends_on.length}): ${entry.relations.depends_on.join(', ')}`,
      )
    }
    if (entry.relations.used_by.length > 0) {
      lines.push(
        `  Used by (${entry.relations.used_by.length}): ${entry.relations.used_by.join(', ')}`,
      )
    }
    if (entry.relations.generalizes) {
      lines.push(`  Generalizes: ${entry.relations.generalizes}`)
    }
    if (entry.relations.specialized_by.length > 0) {
      lines.push(
        `  Specialized by: ${entry.relations.specialized_by.join(', ')}`,
      )
    }
    lines.push('')

    // Tags
    if (entry.tags.length > 0) {
      lines.push(`Tags: ${entry.tags.join(', ')}`)
    }

    const visible = lines.slice(scrollOffset, scrollOffset + contentHeight)

    return (
      <Box flexDirection="column">
        {visible.map((line, i) => (
          <Box key={i}>
            <Text
              color={
                line.startsWith('[') && i === 0 - scrollOffset
                  ? '#818cf8'
                  : undefined
              }
              bold={i + scrollOffset === 0}
            >
              {line}
            </Text>
          </Box>
        ))}
      </Box>
    )
  }

  function renderAssumptionGap(): React.ReactNode {
    if (current.type !== 'assumption_gap') return null

    const entry = loader.getEntry(current.packName, current.entryId)
    if (!entry || !entry.assumptions || entry.assumptions.length === 0) {
      return (
        <Box>
          <Text dimColor>No assumptions to check for {current.entryId}.</Text>
        </Box>
      )
    }

    const lines: string[] = []
    lines.push(`Assumption Gap Check: ${entry.label}`)
    lines.push(`Entry: [${entry.id}] ${entry.name}`)
    lines.push('')
    lines.push(
      'Check whether each assumption holds for your project data and setup.',
    )
    lines.push('')

    for (let i = 0; i < entry.assumptions.length; i++) {
      const a = entry.assumptions[i]
      const strengthLabel =
        a.strength === 'necessary_and_sufficient'
          ? 'NECESSARY & SUFFICIENT'
          : a.strength.toUpperCase()
      lines.push(`--- Assumption ${i + 1} [${strengthLabel}] ---`)
      lines.push(`  ID: ${a.id}`)
      lines.push(`  ${a.text}`)
      lines.push('')

      if (
        a.strength === 'strong' ||
        a.strength === 'necessary_and_sufficient'
      ) {
        lines.push('  ! This is a strong assumption. Verify carefully:')
        lines.push('    - Does your data/model satisfy this condition exactly?')
        lines.push(
          '    - If not, what is the gap, and can the theorem be relaxed?',
        )
      } else if (a.strength === 'technical') {
        lines.push('  ~ Technical assumption. Usually satisfied in practice:')
        lines.push(
          '    - Confirm your problem setup meets this technical condition.',
        )
      } else {
        lines.push('  Standard assumption:')
        lines.push(
          '    - Typically holds for common problem settings. Verify it applies.',
        )
      }
      lines.push('')
    }

    lines.push('--- Summary ---')
    const strongCount = entry.assumptions.filter(
      a => a.strength === 'strong' || a.strength === 'necessary_and_sufficient',
    ).length
    lines.push(`Total assumptions: ${entry.assumptions.length}`)
    lines.push(
      `Strong/critical: ${strongCount}${strongCount > 0 ? ' (review carefully)' : ''}`,
    )
    lines.push(
      `Technical: ${entry.assumptions.filter(a => a.strength === 'technical').length}`,
    )
    lines.push(
      `Standard: ${entry.assumptions.filter(a => a.strength === 'standard').length}`,
    )

    const visible = lines.slice(scrollOffset, scrollOffset + contentHeight)

    return (
      <Box flexDirection="column">
        {visible.map((line, i) => (
          <Box key={i}>
            <Text
              bold={i + scrollOffset === 0}
              color={
                line.startsWith('  !')
                  ? '#ef4444'
                  : line.startsWith('  ~')
                    ? '#eab308'
                    : line.startsWith('--- Assumption')
                      ? '#818cf8'
                      : i + scrollOffset === 0
                        ? '#818cf8'
                        : undefined
              }
            >
              {line}
            </Text>
          </Box>
        ))}
      </Box>
    )
  }

  // ── Main render ─────────────────────────────────────────

  switch (current.type) {
    case 'pack_list':
      return renderPackList()
    case 'pack_detail':
      return renderPackDetail()
    case 'direction_entries':
    case 'type_entries':
    case 'search_results':
    case 'technique_results':
      return renderEntryList()
    case 'entry_detail':
      return renderEntryDetail()
    case 'assumption_gap':
      return renderAssumptionGap()
    default:
      return null
  }
}

// ── Utility ─────────────────────────────────────────────

function wordWrap(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text]
  const lines: string[] = []
  const words = text.split(/\s+/)
  let currentLine = ''

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word
    } else if (currentLine.length + 1 + word.length <= maxWidth) {
      currentLine += ' ' + word
    } else {
      lines.push(currentLine)
      currentLine = word
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine)
  }

  return lines.length > 0 ? lines : ['']
}
