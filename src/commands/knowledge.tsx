import React from 'react'
import type { Command } from '@commands'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { DKP_GLOBAL_DIR, DKP_PATHS } from '../paper/domain-knowledge/types'
import type {
  DKPManifest,
  DKPBuildConfig,
} from '../paper/domain-knowledge/types'
import { loadResearchState, saveResearchState } from '../paper/research-state'
import { getSessionDir } from '../paper/session'
import {
  DKPBuilder,
  buildConnectionGraph,
  buildIndices,
} from '../paper/domain-knowledge/pack-builder'
import type {
  PackBuildProgress,
  PackBuildResult,
} from '../paper/domain-knowledge/pack-builder'
import { DKPPlanner } from '../paper/domain-knowledge/planner'
import { parseConfigFile } from '../paper/domain-knowledge/config-parser'
import { EntryStore } from '../paper/domain-knowledge/entry-store'
import { TextbookParser } from '../paper/domain-knowledge/textbook-parser'
import { PaperParser } from '../paper/domain-knowledge/paper-parser'
import { RegistryBuilder } from '../paper/domain-knowledge/registry-builder'
import { pdfExtractor } from '../paper/pdf-extractor'
import { BuildProgressPanel } from '@components/BuildProgressPanel'
import { estimateTokens } from '../paper/claim-graph/token-utils'

// ── Helpers ─────────────────────────────────────────────

function getGlobalPacksDir(): string {
  return join(homedir(), DKP_GLOBAL_DIR)
}

function readManifest(packDir: string): DKPManifest | null {
  const manifestPath = join(packDir, DKP_PATHS.manifest)
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as DKPManifest
  } catch {
    return null
  }
}

function scanAvailablePacks(): DKPManifest[] {
  const dir = getGlobalPacksDir()
  if (!existsSync(dir)) return []
  const manifests: DKPManifest[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const m = readManifest(join(dir, entry.name))
      if (m) manifests.push(m)
    }
  } catch {
    // ignore
  }
  return manifests
}

// ── Simple Subcommands (return text) ────────────────────

function handleList(): string {
  const packs = scanAvailablePacks()
  if (packs.length === 0) {
    return `No knowledge packs found in ${getGlobalPacksDir()}\nBuild one with: /knowledge build "domain name"`
  }

  const lines = [`Available knowledge packs (${packs.length}):\n`]
  for (const p of packs) {
    lines.push(`  ${p.id}`)
    lines.push(`    ${p.description}`)
    lines.push(
      `    ${p.stats.entries_total} entries | ${p.stats.datasets} datasets | ${p.stats.benchmarks} benchmarks`,
    )
    lines.push(`    Built: ${p.built_at}`)
    lines.push('')
  }
  return lines.join('\n')
}

function handleLoad(packId: string): string {
  if (!packId) return 'Usage: /knowledge load <pack-id>'

  const packDir = join(getGlobalPacksDir(), packId)
  const manifest = readManifest(packDir)
  if (!manifest) {
    return `Pack "${packId}" not found. Run /knowledge list to see available packs.`
  }

  let sessionDir: string
  try {
    sessionDir = getSessionDir()
  } catch {
    return 'No active research session. Start one with /propose first.'
  }

  const state = loadResearchState(sessionDir)
  if (!state) {
    return 'No research state found. Start a session with /propose first.'
  }

  if (state.loaded_knowledge_packs?.includes(packId)) {
    return `Pack "${packId}" is already loaded.`
  }

  state.loaded_knowledge_packs = [
    ...(state.loaded_knowledge_packs ?? []),
    packId,
  ]
  saveResearchState(sessionDir, state)

  return `Loaded knowledge pack "${manifest.name}" (${manifest.stats.entries_total} entries). It will be available to the orchestrator on the next cycle.`
}

function handleUnload(packId: string): string {
  if (!packId) return 'Usage: /knowledge unload <pack-id>'

  let sessionDir: string
  try {
    sessionDir = getSessionDir()
  } catch {
    return 'No active research session.'
  }

  const state = loadResearchState(sessionDir)
  if (!state) {
    return 'No research state found.'
  }

  const packs = state.loaded_knowledge_packs ?? []
  if (!packs.includes(packId)) {
    return `Pack "${packId}" is not currently loaded.`
  }

  state.loaded_knowledge_packs = packs.filter(id => id !== packId)
  saveResearchState(sessionDir, state)

  return `Unloaded knowledge pack "${packId}". It will be removed from orchestrator context on the next cycle.`
}

function handleStatus(): string {
  let sessionDir: string
  try {
    sessionDir = getSessionDir()
  } catch {
    return 'No active research session.'
  }

  const state = loadResearchState(sessionDir)
  if (!state) {
    return 'No research state found.'
  }

  const packIds = state.loaded_knowledge_packs ?? []
  if (packIds.length === 0) {
    return 'No knowledge packs loaded in this session.\nUse /knowledge load <pack-id> to load one.'
  }

  const lines = [`Loaded knowledge packs (${packIds.length}):\n`]
  for (const packId of packIds) {
    const packDir = join(getGlobalPacksDir(), packId)
    const manifest = readManifest(packDir)
    if (manifest) {
      lines.push(`  ${manifest.id}: ${manifest.name}`)
      lines.push(
        `    ${manifest.stats.entries_total} entries | L0: ~${manifest.context_sizes.l0_overview_tokens} tokens | L1: ~${manifest.context_sizes.l1_directions_tokens} tokens`,
      )
      lines.push(
        `    Registries: ${manifest.stats.datasets} datasets, ${manifest.stats.benchmarks} benchmarks, ${manifest.stats.codebases} codebases`,
      )
    } else {
      lines.push(`  ${packId}: [pack not found on disk]`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function handleShow(packId: string): string {
  if (!packId) return 'Usage: /knowledge show <pack-id>'

  const packDir = join(getGlobalPacksDir(), packId)
  const manifest = readManifest(packDir)
  if (!manifest) {
    return `Pack "${packId}" not found. Run /knowledge list to see available packs.`
  }

  const overviewPath = join(packDir, DKP_PATHS.knowledge.overview)
  let overviewPreview = ''
  if (existsSync(overviewPath)) {
    const full = readFileSync(overviewPath, 'utf-8')
    overviewPreview = full.length > 500 ? full.slice(0, 500) + '...' : full
  }

  const lines = [
    `Pack: ${manifest.name} (${manifest.id})`,
    `Version: ${manifest.version}`,
    `Description: ${manifest.description}`,
    '',
    `Stats:`,
    `  Entries: ${manifest.stats.entries_total} (${manifest.stats.theorems} theorems, ${manifest.stats.definitions} definitions, ${manifest.stats.algorithms} algorithms, ${manifest.stats.results} results)`,
    `  Registries: ${manifest.stats.datasets} datasets, ${manifest.stats.benchmarks} benchmarks, ${manifest.stats.codebases} codebases`,
    '',
    `Context sizes:`,
    `  L0 (overview): ~${manifest.context_sizes.l0_overview_tokens} tokens`,
    `  L1 (directions): ~${manifest.context_sizes.l1_directions_tokens} tokens`,
    `  L2 (entry avg): ~${manifest.context_sizes.l2_entry_avg_tokens} tokens`,
    '',
    `Sources:`,
    `  Textbooks: ${manifest.sources.textbooks.map(t => t.id).join(', ') || 'none'}`,
    `  Papers: ${manifest.sources.papers.map(p => p.id).join(', ') || 'none'}`,
    '',
    `Built: ${manifest.built_at}`,
  ]

  if (overviewPreview) {
    lines.push('', '--- Overview (preview) ---', overviewPreview)
  }

  return lines.join('\n')
}

// ── Build (returns JSX) ────────────────────────────────

async function prepareBuildConfig(
  args: string,
): Promise<{ config: DKPBuildConfig; planSummary?: string }> {
  // Mode 1: /knowledge build --config path/to/config.yaml
  if (args.includes('--config')) {
    const configPath = args.replace('--config', '').trim()
    if (!configPath) {
      throw new Error('Usage: /knowledge build --config <path>')
    }
    const config = parseConfigFile(configPath)
    return { config }
  }

  // Mode 2: /knowledge build "domain name"
  const domain = args.replace(/^["']|["']$/g, '').trim()
  if (!domain) {
    throw new Error(
      'Usage:\n  /knowledge build "domain name"\n  /knowledge build --config path/to/config.yaml',
    )
  }

  const planner = new DKPPlanner()
  const plan = await planner.plan(domain)
  const config = planner.planToConfig(plan)

  const planLines = [
    `Domain: ${plan.domain}`,
    `Description: ${plan.description}`,
    '',
    `Sub-directions: ${plan.sub_directions.join(', ')}`,
    '',
    `Recommended textbooks (${plan.recommended_textbooks.length}):`,
    ...plan.recommended_textbooks.map(
      t => `  - ${t.title} (${t.authors.join(', ')}, ${t.year}) — ${t.reason}`,
    ),
    '',
    `Recommended papers (${plan.recommended_papers.length}):`,
    ...plan.recommended_papers.map(
      p =>
        `  - ${p.title} (${p.year})${p.arxiv_id ? ` [arXiv:${p.arxiv_id}]` : ''} — ${p.reason}`,
    ),
    '',
    `Search queries: ${plan.search_queries.map(q => q.query).join('; ')}`,
    '',
    'Note: Textbooks require local PDF paths. Papers will be auto-downloaded.',
  ]

  return { config, planSummary: planLines.join('\n') }
}

// ── Incremental Operations ──────────────────────────────

async function handleAddTextbook(
  packId: string,
  rest: string,
): Promise<string> {
  if (!packId || !rest) {
    return 'Usage: /knowledge add-textbook <pack-id> <pdf-path> [--chapters 1,2,3]'
  }

  const packDir = join(getGlobalPacksDir(), packId)
  const manifest = readManifest(packDir)
  if (!manifest) {
    return `Pack "${packId}" not found.`
  }

  // Parse path and optional --chapters
  const parts = rest.split('--chapters')
  const pdfPath = parts[0].trim().replace(/^["']|["']$/g, '')
  const focusChapters = parts[1]
    ? parts[1]
        .trim()
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n))
    : undefined

  if (!existsSync(pdfPath)) {
    return `File not found: ${pdfPath}`
  }

  const textbookId = pdfPath
    .split('/')
    .pop()!
    .replace('.pdf', '')
    .replace(/[^a-z0-9]/gi, '_')
    .toLowerCase()

  const entryStore = new EntryStore(packDir)
  const parser = new TextbookParser(entryStore, pdfExtractor)

  const result = await parser.parse(
    { path: pdfPath, id: textbookId, focus_chapters: focusChapters },
    packDir,
  )

  // Rebuild indices
  const allEntries = entryStore.loadAllEntries()
  const connectionGraph = buildConnectionGraph(allEntries)
  const indices = buildIndices(allEntries)

  const { writeFileSync, mkdirSync } = await import('fs')
  const { dirname } = await import('path')

  writeFileSync(
    join(packDir, DKP_PATHS.knowledge.connections),
    JSON.stringify(connectionGraph, null, 2),
    'utf-8',
  )

  for (const [key, path] of Object.entries(DKP_PATHS.index)) {
    const indexData = indices[key as keyof typeof indices]
    mkdirSync(dirname(join(packDir, path)), { recursive: true })
    writeFileSync(
      join(packDir, path),
      JSON.stringify(indexData, null, 2),
      'utf-8',
    )
  }

  // Update manifest stats
  const typeCounts: Record<string, number> = {}
  for (const entry of allEntries) {
    typeCounts[entry.type] = (typeCounts[entry.type] ?? 0) + 1
  }
  manifest.stats.entries_total = allEntries.length
  manifest.stats.theorems = typeCounts['theorem'] ?? 0
  manifest.stats.definitions = typeCounts['definition'] ?? 0
  manifest.stats.algorithms = typeCounts['algorithm'] ?? 0
  manifest.stats.results = typeCounts['result'] ?? 0
  manifest.built_at = new Date().toISOString()

  writeFileSync(
    join(packDir, DKP_PATHS.manifest),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  )

  return `Added textbook "${textbookId}" to pack "${packId}": ${result.entries_created} entries created (${result.errors.length} errors). Total: ${allEntries.length} entries.`
}

async function handleAddPaper(packId: string, rest: string): Promise<string> {
  if (!packId || !rest) {
    return 'Usage: /knowledge add-paper <pack-id> <pdf-path-or-arxiv-id>'
  }

  const packDir = join(getGlobalPacksDir(), packId)
  const manifest = readManifest(packDir)
  if (!manifest) {
    return `Pack "${packId}" not found.`
  }

  const input = rest.trim().replace(/^["']|["']$/g, '')
  let pdfPath = input
  let paperId: string

  // Check if it's an arXiv ID (e.g., 2301.12345 or arxiv:2301.12345)
  const arxivMatch = input.match(/^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)$/i)
  if (arxivMatch) {
    // Download via acquisition chain
    const { PaperAcquisitionChain } = await import('../paper/acquisition')
    const { mkdirSync } = await import('fs')
    const pdfsDir = join(packDir, 'sources', 'pdfs')
    mkdirSync(pdfsDir, { recursive: true })

    const chain = new PaperAcquisitionChain({ output_dir: pdfsDir })
    const result = await chain.acquire({
      title: arxivMatch[1],
      arxiv_id: arxivMatch[1],
    })

    if (!result.success || !result.pdf_path) {
      return `Failed to download arXiv:${arxivMatch[1]}: ${result.error || 'unknown error'}`
    }

    pdfPath = result.pdf_path
    paperId = `arxiv_${arxivMatch[1].replace(/[./]/g, '_')}`
  } else {
    if (!existsSync(pdfPath)) {
      return `File not found: ${pdfPath}`
    }
    paperId = pdfPath
      .split('/')
      .pop()!
      .replace('.pdf', '')
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase()
  }

  const entryStore = new EntryStore(packDir)
  const parser = new PaperParser(entryStore, pdfExtractor)

  const result = await parser.parse({ path: pdfPath, id: paperId }, packDir)

  // Rebuild indices (same as add-textbook)
  const allEntries = entryStore.loadAllEntries()
  const connectionGraph = buildConnectionGraph(allEntries)
  const indices = buildIndices(allEntries)

  const { writeFileSync, mkdirSync } = await import('fs')
  const { dirname } = await import('path')

  writeFileSync(
    join(packDir, DKP_PATHS.knowledge.connections),
    JSON.stringify(connectionGraph, null, 2),
    'utf-8',
  )

  for (const [key, path] of Object.entries(DKP_PATHS.index)) {
    const indexData = indices[key as keyof typeof indices]
    mkdirSync(dirname(join(packDir, path)), { recursive: true })
    writeFileSync(
      join(packDir, path),
      JSON.stringify(indexData, null, 2),
      'utf-8',
    )
  }

  // Update manifest
  const typeCounts: Record<string, number> = {}
  for (const entry of allEntries) {
    typeCounts[entry.type] = (typeCounts[entry.type] ?? 0) + 1
  }
  manifest.stats.entries_total = allEntries.length
  manifest.stats.theorems = typeCounts['theorem'] ?? 0
  manifest.stats.definitions = typeCounts['definition'] ?? 0
  manifest.stats.algorithms = typeCounts['algorithm'] ?? 0
  manifest.stats.results = typeCounts['result'] ?? 0
  manifest.built_at = new Date().toISOString()

  writeFileSync(
    join(packDir, DKP_PATHS.manifest),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  )

  return `Added paper "${paperId}" to pack "${packId}": ${result.entries_created} entries created. Total: ${allEntries.length} entries.`
}

async function handleRefreshRegistries(packId: string): Promise<string> {
  if (!packId) {
    return 'Usage: /knowledge refresh-registries <pack-id>'
  }

  const packDir = join(getGlobalPacksDir(), packId)
  const manifest = readManifest(packDir)
  if (!manifest) {
    return `Pack "${packId}" not found.`
  }

  const builder = new RegistryBuilder(packDir)
  const result = await builder.build(manifest.description, {
    search_datasets: true,
    search_benchmarks: true,
    search_codebases: true,
  })

  // Re-read registries for updated counts
  const { readFileSync: readFS } = await import('fs')
  const datasetsPath = join(packDir, DKP_PATHS.registries.datasets)
  const benchmarksPath = join(packDir, DKP_PATHS.registries.benchmarks)
  const codebasesPath = join(packDir, DKP_PATHS.registries.codebases)

  const ds = existsSync(datasetsPath)
    ? (JSON.parse(readFS(datasetsPath, 'utf-8')) as unknown[]).length
    : 0
  const bm = existsSync(benchmarksPath)
    ? (JSON.parse(readFS(benchmarksPath, 'utf-8')) as unknown[]).length
    : 0
  const cb = existsSync(codebasesPath)
    ? (JSON.parse(readFS(codebasesPath, 'utf-8')) as unknown[]).length
    : 0

  // Update manifest
  manifest.stats.datasets = ds
  manifest.stats.benchmarks = bm
  manifest.stats.codebases = cb
  manifest.built_at = new Date().toISOString()

  const { writeFileSync } = await import('fs')
  writeFileSync(
    join(packDir, DKP_PATHS.manifest),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  )

  return `Refreshed registries for "${packId}": ${ds} datasets, ${bm} benchmarks, ${cb} codebases. Cost: $${result.cost_usd.toFixed(2)}`
}

// ── Usage Help ──────────────────────────────────────────

function usageHelp(): string {
  return [
    'Usage:',
    '  /knowledge                             List available packs',
    '  /knowledge list                        List available packs',
    '  /knowledge build "domain name"         Build pack with auto-planning',
    '  /knowledge build --config <yaml>       Build pack from config file',
    '  /knowledge load <id>                   Load pack into session',
    '  /knowledge unload <id>                 Unload pack from session',
    '  /knowledge status                      Show loaded packs',
    '  /knowledge show <id>                   Show pack details',
    '  /knowledge add-textbook <id> <path>    Add textbook to existing pack',
    '  /knowledge add-paper <id> <path|arxiv> Add paper to existing pack',
    '  /knowledge refresh-registries <id>     Refresh datasets/benchmarks',
  ].join('\n')
}

// ── Command Export ──────────────────────────────────────

const knowledge: Command = {
  type: 'local-jsx',
  name: 'knowledge',
  userFacingName() {
    return 'knowledge'
  },
  description:
    'Manage domain knowledge packs (build, list, load, unload, add, status)',
  isEnabled: true,
  isHidden: false,
  argumentHint:
    '[build|list|load|unload|status|show|add-textbook|add-paper|refresh-registries] [args...]',
  aliases: ['dk'],

  async call(onDone, _context, args) {
    const rawArgs = (args ?? '').trim()
    const parts = rawArgs.split(/\s+/)
    const subcommand = parts[0] ?? ''
    const arg1 = parts[1] ?? ''
    const rest = parts.slice(2).join(' ')

    // Simple text-returning subcommands
    switch (subcommand) {
      case '':
      case 'list':
        onDone(handleList())
        return null
      case 'load':
        onDone(handleLoad(arg1))
        return null
      case 'unload':
        onDone(handleUnload(arg1))
        return null
      case 'status':
        onDone(handleStatus())
        return null
      case 'show':
        onDone(handleShow(arg1))
        return null
    }

    // Async text-returning subcommands
    switch (subcommand) {
      case 'add-textbook': {
        try {
          const result = await handleAddTextbook(arg1, rest)
          onDone(result)
        } catch (err) {
          onDone(`Error: ${err instanceof Error ? err.message : String(err)}`)
        }
        return null
      }
      case 'add-paper': {
        try {
          const result = await handleAddPaper(arg1, rest)
          onDone(result)
        } catch (err) {
          onDone(`Error: ${err instanceof Error ? err.message : String(err)}`)
        }
        return null
      }
      case 'refresh-registries': {
        try {
          const result = await handleRefreshRegistries(arg1)
          onDone(result)
        } catch (err) {
          onDone(`Error: ${err instanceof Error ? err.message : String(err)}`)
        }
        return null
      }
    }

    // Build subcommand — returns JSX progress panel
    if (subcommand === 'build') {
      const buildArgs = rawArgs.replace(/^build\s*/, '')

      let config: DKPBuildConfig
      let planSummary: string | undefined

      try {
        const prepared = await prepareBuildConfig(buildArgs)
        config = prepared.config
        planSummary = prepared.planSummary
      } catch (err) {
        onDone(`Error: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }

      if (planSummary) {
        // Log plan before starting build
        // (The plan will appear as text above the progress panel)
      }

      const builder = new DKPBuilder(pdfExtractor, getGlobalPacksDir())

      const runner = async (
        onProgress: (event: PackBuildProgress) => void,
      ): Promise<PackBuildResult> => {
        return builder.build(config, onProgress)
      }

      return (
        <BuildProgressPanel
          runner={runner}
          onDone={result => {
            const lines = [
              planSummary
                ? `\n--- Build Plan ---\n${planSummary}\n\n--- Build Complete ---`
                : '--- Build Complete ---',
              `Pack: ${result.manifest.name} (${result.manifest.id})`,
              `Location: ${result.packDir}`,
              `Entries: ${result.total_entries}`,
              `Cost: $${result.total_cost_usd.toFixed(2)}`,
            ]
            if (result.errors.length > 0) {
              lines.push(`Errors (${result.errors.length}):`)
              for (const err of result.errors.slice(0, 10)) {
                lines.push(`  - ${err}`)
              }
            }
            lines.push(
              '',
              `Load into session: /knowledge load ${result.manifest.id}`,
            )
            onDone(lines.join('\n'))
          }}
          onError={error => {
            onDone(`Build failed: ${error}`)
          }}
        />
      )
    }

    // Unknown subcommand
    onDone(usageHelp())
    return null
  },
}

export default knowledge
