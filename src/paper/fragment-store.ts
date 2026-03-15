import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'fs'
import { join, relative } from 'path'
import { randomUUID } from 'crypto'

// ── Types ────────────────────────────────────────────────

export type FragmentType =
  | 'proofs'
  | 'derivations'
  | 'algorithms'
  | 'definitions'
  | 'experiments'
  | 'related_work'
  | 'figures'
  | 'tables'

export interface FragmentMeta {
  id: string
  type: FragmentType
  file_path: string // relative to project root
  title: string
  related_claims: string[] // claim ids
  status: 'draft' | 'reviewed' | 'finalized'
  created_by: string // agent name
  dependencies: string[] // other fragment ids
  notes: string
  estimated_pages: number
  created_at: string
  updated_at: string
}

export interface FragmentIndex {
  fragments: Record<string, FragmentMeta>
  paper_structure: Record<string, string[]> // section name → fragment ids
}

// ── Fragment Store ───────────────────────────────────────

export class FragmentStore {
  private projectDir: string
  private fragmentDir: string
  private indexPath: string
  private index: FragmentIndex

  constructor(projectDir: string) {
    this.projectDir = projectDir
    this.fragmentDir = join(projectDir, 'fragments')
    this.indexPath = join(this.fragmentDir, 'index.json')
    this.index = this.loadIndex()
  }

  /**
   * Initialize the fragments directory structure.
   */
  init(): void {
    const dirs: FragmentType[] = [
      'proofs',
      'derivations',
      'algorithms',
      'definitions',
      'experiments',
      'related_work',
      'figures',
      'tables',
    ]
    for (const dir of dirs) {
      mkdirSync(join(this.fragmentDir, dir), { recursive: true })
    }
    this.saveIndex()
  }

  /**
   * Create a new fragment.
   */
  create(
    type: FragmentType,
    title: string,
    content: string,
    options?: {
      created_by?: string
      related_claims?: string[]
      dependencies?: string[]
      notes?: string
      estimated_pages?: number
    },
  ): FragmentMeta {
    const id = `${type.replace(/_/g, '-')}-${randomUUID().slice(0, 8)}`
    const fileName = `${id}.tex`
    const filePath = join('fragments', type, fileName)
    const fullPath = join(this.projectDir, filePath)

    // Ensure directory exists
    mkdirSync(join(this.fragmentDir, type), { recursive: true })

    // Write the .tex file
    writeFileSync(fullPath, content, 'utf-8')

    const now = new Date().toISOString()
    const meta: FragmentMeta = {
      id,
      type,
      file_path: filePath,
      title,
      related_claims: options?.related_claims ?? [],
      status: 'draft',
      created_by: options?.created_by ?? 'user',
      dependencies: options?.dependencies ?? [],
      notes: options?.notes ?? '',
      estimated_pages: options?.estimated_pages ?? 0.5,
      created_at: now,
      updated_at: now,
    }

    this.index.fragments[id] = meta
    this.saveIndex()
    return meta
  }

  /**
   * Get a fragment by ID.
   */
  get(id: string): FragmentMeta | null {
    return this.index.fragments[id] ?? null
  }

  /**
   * Read fragment content from disk.
   */
  readContent(id: string): string | null {
    const meta = this.get(id)
    if (!meta) return null
    const fullPath = join(this.projectDir, meta.file_path)
    if (!existsSync(fullPath)) return null
    return readFileSync(fullPath, 'utf-8')
  }

  /**
   * Update fragment content.
   */
  updateContent(id: string, content: string): boolean {
    const meta = this.get(id)
    if (!meta) return false
    const fullPath = join(this.projectDir, meta.file_path)
    writeFileSync(fullPath, content, 'utf-8')
    meta.updated_at = new Date().toISOString()
    this.saveIndex()
    return true
  }

  /**
   * Update fragment metadata.
   */
  updateMeta(
    id: string,
    updates: Partial<Omit<FragmentMeta, 'id' | 'created_at'>>,
  ): boolean {
    const meta = this.get(id)
    if (!meta) return false
    Object.assign(meta, updates, { updated_at: new Date().toISOString() })
    this.saveIndex()
    return true
  }

  /**
   * Delete a fragment.
   */
  delete(id: string): boolean {
    const meta = this.get(id)
    if (!meta) return false

    // Remove from index
    delete this.index.fragments[id]

    // Remove from paper structure
    for (const section of Object.keys(this.index.paper_structure)) {
      this.index.paper_structure[section] = this.index.paper_structure[
        section
      ].filter(fid => fid !== id)
    }

    this.saveIndex()
    // Note: we don't delete the .tex file to allow recovery
    return true
  }

  /**
   * List all fragments, optionally filtered by type.
   */
  list(type?: FragmentType): FragmentMeta[] {
    const all = Object.values(this.index.fragments)
    if (!type) return all
    return all.filter(f => f.type === type)
  }

  /**
   * Set paper structure: mapping of section names to fragment IDs.
   */
  setPaperStructure(structure: Record<string, string[]>): void {
    this.index.paper_structure = structure
    this.saveIndex()
  }

  /**
   * Get paper structure.
   */
  getPaperStructure(): Record<string, string[]> {
    return this.index.paper_structure
  }

  /**
   * Assign a fragment to a section.
   */
  assignToSection(sectionName: string, fragmentId: string): void {
    if (!this.index.paper_structure[sectionName]) {
      this.index.paper_structure[sectionName] = []
    }
    if (!this.index.paper_structure[sectionName].includes(fragmentId)) {
      this.index.paper_structure[sectionName].push(fragmentId)
    }
    this.saveIndex()
  }

  /**
   * Get unassigned fragments (not in any section).
   */
  getUnassigned(): FragmentMeta[] {
    const assigned = new Set<string>()
    for (const ids of Object.values(this.index.paper_structure)) {
      for (const id of ids) assigned.add(id)
    }
    return Object.values(this.index.fragments).filter(f => !assigned.has(f.id))
  }

  /**
   * Get estimated total pages.
   */
  estimatePages(): number {
    return Object.values(this.index.fragments).reduce(
      (sum, f) => sum + f.estimated_pages,
      0,
    )
  }

  /**
   * Get the full index.
   */
  getIndex(): FragmentIndex {
    return this.index
  }

  // ── Private ──────────────────────────────────────────

  private loadIndex(): FragmentIndex {
    if (existsSync(this.indexPath)) {
      const content = readFileSync(this.indexPath, 'utf-8')
      return JSON.parse(content) as FragmentIndex
    }
    return { fragments: {}, paper_structure: {} }
  }

  private saveIndex(): void {
    mkdirSync(this.fragmentDir, { recursive: true })
    writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8')
  }
}
