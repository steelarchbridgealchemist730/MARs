import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'fs'
import { join } from 'path'
import type { KnowledgeEntry, KnowledgeEntryType } from './types'
import { DKP_PATHS } from './types'

// ── ID Prefix Map ───────────────────────────────────────

const TYPE_PREFIX: Record<KnowledgeEntryType, string> = {
  theorem: 'thm',
  proposition: 'prop',
  lemma: 'lem',
  corollary: 'cor',
  definition: 'def',
  algorithm: 'alg',
  result: 'res',
}

// ── Entry Store ─────────────────────────────────────────

export class EntryStore {
  private entriesDir: string
  private countersPath: string
  private counters: Record<string, number>

  constructor(private packDir: string) {
    this.entriesDir = join(packDir, DKP_PATHS.knowledge.entries)
    this.countersPath = join(this.entriesDir, '.counters.json')
    this.counters = this.loadCounters()
  }

  /** Initialize directory structure. */
  init(): void {
    mkdirSync(this.entriesDir, { recursive: true })
    this.saveCounters()
  }

  /** Generate next ID for a given entry type. e.g. type="theorem" -> "thm-004" */
  nextId(type: KnowledgeEntryType): string {
    const prefix = TYPE_PREFIX[type]
    if (!prefix) {
      throw new Error(`Unknown entry type: ${type}`)
    }
    const count = (this.counters[prefix] ?? 0) + 1
    this.counters[prefix] = count
    this.saveCounters()
    return `${prefix}-${String(count).padStart(3, '0')}`
  }

  /** Save a single entry to disk as JSON. */
  saveEntry(entry: KnowledgeEntry): void {
    mkdirSync(this.entriesDir, { recursive: true })
    const filePath = join(this.entriesDir, `${entry.id}.json`)
    writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8')
  }

  /** Read a single entry by ID. */
  getEntry(entryId: string): KnowledgeEntry | null {
    const filePath = join(this.entriesDir, `${entryId}.json`)
    if (!existsSync(filePath)) return null
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as KnowledgeEntry
    } catch {
      return null
    }
  }

  /** List all entry IDs in the store. */
  listEntryIds(): string[] {
    if (!existsSync(this.entriesDir)) return []
    return readdirSync(this.entriesDir)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => f.replace('.json', ''))
      .sort()
  }

  /** Load all entries. */
  loadAllEntries(): KnowledgeEntry[] {
    const ids = this.listEntryIds()
    const entries: KnowledgeEntry[] = []
    for (const id of ids) {
      const entry = this.getEntry(id)
      if (entry) entries.push(entry)
    }
    return entries
  }

  private saveCounters(): void {
    mkdirSync(this.entriesDir, { recursive: true })
    writeFileSync(
      this.countersPath,
      JSON.stringify(this.counters, null, 2),
      'utf-8',
    )
  }

  private loadCounters(): Record<string, number> {
    if (!existsSync(this.countersPath)) return {}
    try {
      return JSON.parse(readFileSync(this.countersPath, 'utf-8'))
    } catch {
      return {}
    }
  }
}
