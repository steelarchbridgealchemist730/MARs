import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type {
  DKPManifest,
  DKPIndices,
  DKPRegistries,
  DirectionSummary,
  ConnectionGraph,
  KnowledgeEntry,
  KnowledgeEntryType,
  LoadedDKP,
} from './types'
import { DKP_GLOBAL_DIR, DKP_PATHS } from './types'
import { EntryStore } from './entry-store'

// ── Helpers ─────────────────────────────────────────────

function readJSON<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T
}

function readJSONOrDefault<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback
  try {
    return readJSON<T>(filePath)
  } catch {
    return fallback
  }
}

function readTextOrDefault(filePath: string, fallback: string): string {
  if (!existsSync(filePath)) return fallback
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return fallback
  }
}

// ── DKP Loader ──────────────────────────────────────────

export class DKPLoader {
  private globalPacksDir: string
  private loaded: Map<string, LoadedDKP> = new Map()
  private entryStores: Map<string, EntryStore> = new Map()
  private connectionsCache: Map<string, ConnectionGraph> = new Map()

  constructor(globalPacksDir?: string) {
    this.globalPacksDir = globalPacksDir ?? join(homedir(), DKP_GLOBAL_DIR)
  }

  /**
   * Load a knowledge pack into memory. Idempotent — returns cached pack on double-load.
   * Entries are NOT preloaded; use getEntry() for on-demand reads.
   */
  load(packName: string): LoadedDKP {
    const existing = this.loaded.get(packName)
    if (existing) return existing

    const packDir = this.getPackDir(packName)
    if (!existsSync(packDir)) {
      throw new Error(`Knowledge pack "${packName}" not found at ${packDir}`)
    }

    const manifestPath = join(packDir, DKP_PATHS.manifest)
    if (!existsSync(manifestPath)) {
      throw new Error(
        `Knowledge pack "${packName}" has no manifest at ${manifestPath}`,
      )
    }

    const manifest = readJSON<DKPManifest>(manifestPath)

    const overview = readTextOrDefault(
      join(packDir, DKP_PATHS.knowledge.overview),
      '',
    )

    // Read directions: prefer structured JSON, fallback to parsing .md files
    const directionsJsonPath = join(
      packDir,
      DKP_PATHS.knowledge.directions,
      'directions.json',
    )
    let directions: DirectionSummary[]
    if (existsSync(directionsJsonPath)) {
      directions = readJSONOrDefault<DirectionSummary[]>(directionsJsonPath, [])
    } else {
      directions = this.parseDirectionMarkdownFiles(packDir)
    }

    // Read indices
    const indices: DKPIndices = {
      byType: readJSONOrDefault(join(packDir, DKP_PATHS.index.byType), {
        theorem: [],
        proposition: [],
        lemma: [],
        corollary: [],
        definition: [],
        algorithm: [],
        result: [],
      }),
      byTopic: readJSONOrDefault(join(packDir, DKP_PATHS.index.byTopic), {}),
      bySource: readJSONOrDefault(join(packDir, DKP_PATHS.index.bySource), {}),
      fullText: readJSONOrDefault(join(packDir, DKP_PATHS.index.fullText), {}),
    }

    // Read registries
    const registries: DKPRegistries = {
      datasets: readJSONOrDefault(
        join(packDir, DKP_PATHS.registries.datasets),
        [],
      ),
      benchmarks: readJSONOrDefault(
        join(packDir, DKP_PATHS.registries.benchmarks),
        [],
      ),
      codebases: readJSONOrDefault(
        join(packDir, DKP_PATHS.registries.codebases),
        [],
      ),
    }

    // Create EntryStore for on-demand entry reads
    this.entryStores.set(packName, new EntryStore(packDir))

    const loaded: LoadedDKP = {
      manifest,
      packDir,
      overview,
      directions,
      indices,
      registries,
    }

    this.loaded.set(packName, loaded)
    return loaded
  }

  /** Remove a pack from memory. */
  unload(packName: string): void {
    this.loaded.delete(packName)
    this.entryStores.delete(packName)
    this.connectionsCache.delete(packName)
  }

  /** Get all currently loaded packs. */
  getLoadedPacks(): LoadedDKP[] {
    return Array.from(this.loaded.values())
  }

  /** Get a specific loaded pack, or null if not loaded. */
  getLoadedPack(packName: string): LoadedDKP | null {
    return this.loaded.get(packName) ?? null
  }

  /** Read a single entry on demand. */
  getEntry(packName: string, entryId: string): KnowledgeEntry | null {
    const store = this.entryStores.get(packName)
    if (!store) return null
    return store.getEntry(entryId)
  }

  /** Read multiple entries on demand. */
  getEntries(packName: string, entryIds: string[]): KnowledgeEntry[] {
    const store = this.entryStores.get(packName)
    if (!store) return []
    const entries: KnowledgeEntry[] = []
    for (const id of entryIds) {
      const entry = store.getEntry(id)
      if (entry) entries.push(entry)
    }
    return entries
  }

  /** Get entries by type using the type index. */
  getEntriesByType(
    packName: string,
    type: KnowledgeEntryType,
  ): KnowledgeEntry[] {
    const pack = this.loaded.get(packName)
    if (!pack) return []
    const ids = pack.indices.byType[type] ?? []
    return this.getEntries(packName, ids)
  }

  /** Get the connection graph (lazily loaded + cached). */
  getConnections(packName: string): ConnectionGraph {
    const cached = this.connectionsCache.get(packName)
    if (cached) return cached

    const pack = this.loaded.get(packName)
    if (!pack) return { edges: [] }

    const connPath = join(pack.packDir, DKP_PATHS.knowledge.connections)
    const graph = readJSONOrDefault<ConnectionGraph>(connPath, { edges: [] })
    this.connectionsCache.set(packName, graph)
    return graph
  }

  /** Scan global packs directory and return manifests of all available packs. */
  listAvailablePacks(): DKPManifest[] {
    if (!existsSync(this.globalPacksDir)) return []

    const manifests: DKPManifest[] = []
    try {
      const entries = readdirSync(this.globalPacksDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const manifestPath = join(
          this.globalPacksDir,
          entry.name,
          DKP_PATHS.manifest,
        )
        if (!existsSync(manifestPath)) continue
        try {
          manifests.push(readJSON<DKPManifest>(manifestPath))
        } catch {
          // Skip packs with invalid manifests
        }
      }
    } catch {
      // Directory read failed
    }
    return manifests
  }

  /** Get the directory path for a named pack. */
  getPackDir(packName: string): string {
    return join(this.globalPacksDir, packName)
  }

  // ── Private Helpers ─────────────────────────────────────

  /** Fallback: parse direction .md files when directions.json is missing. */
  private parseDirectionMarkdownFiles(packDir: string): DirectionSummary[] {
    const dirDir = join(packDir, DKP_PATHS.knowledge.directions)
    if (!existsSync(dirDir)) return []

    const directions: DirectionSummary[] = []
    try {
      const files = readdirSync(dirDir).filter(
        f => f.endsWith('.md') && f !== 'README.md',
      )
      for (const file of files) {
        const content = readFileSync(join(dirDir, file), 'utf-8')
        const id = file.replace('.md', '')
        const nameMatch = content.match(/^# (.+)$/m)
        const name = nameMatch ? nameMatch[1] : id

        // Extract key entries from the "## Key Entries" section
        const keyEntriesMatch = content.match(/## Key Entries\n((?:- .+\n?)*)/)
        const key_entries = keyEntriesMatch
          ? keyEntriesMatch[1]
              .split('\n')
              .map(l => l.replace(/^- /, '').trim())
              .filter(Boolean)
          : []

        // Summary is everything between title and Key Entries section
        const summaryMatch = content.match(
          /^# .+\n\n([\s\S]*?)(?:\n## Key Entries|$)/,
        )
        const summary = summaryMatch ? summaryMatch[1].trim() : ''

        directions.push({
          id,
          name,
          summary,
          entry_count: key_entries.length,
          key_entries,
        })
      }
    } catch {
      // Ignore read errors
    }
    return directions
  }
}
