import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type {
  TemplateManifest,
  VenueConstraints,
  TemplateRegistry,
  TemplateRegistryEntry,
  ResolvedTemplate,
} from './template-types'

export class TemplateResolver {
  private templatesDir: string

  constructor(templatesDir?: string) {
    this.templatesDir =
      templatesDir ?? join(__dirname, '..', '..', '..', 'templates')
  }

  /**
   * List all available templates from registry + auto-discovered manifest dirs.
   */
  listTemplates(): TemplateRegistryEntry[] {
    const registry = this.loadRegistry()
    if (registry) return registry.templates

    // Fallback: auto-discover from directory listing
    return this.autoDiscover()
  }

  /**
   * Resolve a template by ID or alias. Returns manifest, constraints, and directory path.
   */
  resolve(idOrAlias: string): ResolvedTemplate {
    const entry = this.findEntry(idOrAlias)
    if (!entry) {
      const available = this.listTemplates()
        .map(t => t.id)
        .join(', ')
      throw new Error(
        `Template "${idOrAlias}" not found. Available: ${available}`,
      )
    }

    const dir = join(this.templatesDir, entry.path)
    const manifest = this.loadManifest(dir, entry)
    const constraints = this.loadConstraints(dir)

    return { manifest, constraints, directory: dir }
  }

  /**
   * Get venue constraints for a template. Returns null if no constraints file.
   */
  getConstraints(idOrAlias: string): VenueConstraints | null {
    const { constraints } = this.resolve(idOrAlias)
    return constraints
  }

  /**
   * Get absolute path to the template directory.
   */
  getTemplateDir(idOrAlias: string): string {
    const entry = this.findEntry(idOrAlias)
    if (!entry) {
      // Legacy fallback: treat as directory name
      const dir = join(this.templatesDir, idOrAlias)
      if (existsSync(dir)) return dir
      throw new Error(`Template "${idOrAlias}" not found.`)
    }
    return join(this.templatesDir, entry.path)
  }

  /**
   * Get absolute path to main.tex for a template.
   */
  getMainTexPath(idOrAlias: string): string {
    const { manifest, directory } = this.resolve(idOrAlias)
    return join(directory, manifest.template_files.main)
  }

  /**
   * Get the default template ID from registry.
   */
  getDefaultTemplateId(): string {
    const registry = this.loadRegistry()
    return registry?.default_template ?? 'neurips'
  }

  /**
   * Install a template from a local directory path.
   * Validates that the source contains a manifest.json, copies to templates dir,
   * and updates registry.json.
   */
  installFromLocal(sourcePath: string): TemplateRegistryEntry {
    if (!existsSync(sourcePath)) {
      throw new Error(`Source path does not exist: ${sourcePath}`)
    }

    const manifestPath = join(sourcePath, 'manifest.json')
    if (!existsSync(manifestPath)) {
      throw new Error(
        `No manifest.json found in ${sourcePath}. A valid template must contain a manifest.json file.`,
      )
    }

    let manifest: TemplateManifest
    try {
      manifest = JSON.parse(
        readFileSync(manifestPath, 'utf-8'),
      ) as TemplateManifest
    } catch {
      throw new Error(`Failed to parse manifest.json in ${sourcePath}`)
    }

    if (!manifest.id || !manifest.name) {
      throw new Error(
        'manifest.json must contain at least "id" and "name" fields',
      )
    }

    // Copy to templates directory
    const destDir = join(this.templatesDir, manifest.id)
    mkdirSync(destDir, { recursive: true })
    cpSync(sourcePath, destDir, { recursive: true })

    // Register in registry.json
    const entry: TemplateRegistryEntry = {
      id: manifest.id,
      name: manifest.name,
      aliases: [manifest.id],
      venue_type: manifest.venue_type ?? 'preprint',
      field: manifest.field ?? 'general',
      path: manifest.id,
    }
    this.registerTemplate(entry)

    return entry
  }

  /**
   * Install a template from a URL (tar.gz or zip archive).
   * Downloads to a temp directory, extracts, validates manifest, and installs.
   */
  async installFromUrl(url: string): Promise<TemplateRegistryEntry> {
    const tmpDir = join(tmpdir(), `cpaper-url-install-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
        )
      }

      const contentType = response.headers.get('content-type') ?? ''
      const buffer = Buffer.from(await response.arrayBuffer())

      const isZip = contentType.includes('zip') || url.endsWith('.zip')
      const isTarGz =
        contentType.includes('gzip') ||
        contentType.includes('tar') ||
        url.endsWith('.tar.gz') ||
        url.endsWith('.tgz')

      const extractDir = join(tmpDir, 'extracted')
      mkdirSync(extractDir, { recursive: true })

      if (isTarGz) {
        const archivePath = join(tmpDir, 'template.tar.gz')
        writeFileSync(archivePath, buffer)
        const proc = Bun.spawnSync(
          ['tar', 'xzf', archivePath, '-C', extractDir],
          { stderr: 'pipe' },
        )
        if (proc.exitCode !== 0) {
          throw new Error(`Failed to extract tar.gz: ${proc.stderr.toString()}`)
        }
      } else if (isZip) {
        const archivePath = join(tmpDir, 'template.zip')
        writeFileSync(archivePath, buffer)
        const proc = Bun.spawnSync(
          ['unzip', '-o', archivePath, '-d', extractDir],
          { stderr: 'pipe' },
        )
        if (proc.exitCode !== 0) {
          throw new Error(`Failed to extract zip: ${proc.stderr.toString()}`)
        }
      } else {
        throw new Error(
          `Unsupported archive format. URL must point to a .tar.gz or .zip file.`,
        )
      }

      // Find the directory containing manifest.json (may be nested one level)
      let templateDir = extractDir
      if (!existsSync(join(templateDir, 'manifest.json'))) {
        const subdirs = readdirSync(extractDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)
        const found = subdirs.find(d =>
          existsSync(join(extractDir, d, 'manifest.json')),
        )
        if (found) {
          templateDir = join(extractDir, found)
        }
      }

      return this.installFromLocal(templateDir)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  /**
   * Add or update a template entry in registry.json.
   */
  registerTemplate(entry: TemplateRegistryEntry): void {
    const registryPath = join(this.templatesDir, 'registry.json')
    let registry: TemplateRegistry

    if (existsSync(registryPath)) {
      try {
        registry = JSON.parse(
          readFileSync(registryPath, 'utf-8'),
        ) as TemplateRegistry
      } catch {
        registry = { version: 1, default_template: 'neurips', templates: [] }
      }
    } else {
      registry = { version: 1, default_template: 'neurips', templates: [] }
    }

    // Replace existing entry or append
    const idx = registry.templates.findIndex(t => t.id === entry.id)
    if (idx >= 0) {
      registry.templates[idx] = entry
    } else {
      registry.templates.push(entry)
    }

    writeFileSync(
      registryPath,
      JSON.stringify(registry, null, 2) + '\n',
      'utf-8',
    )
  }

  // ── Private helpers ─────────────────────────────────────────

  private loadRegistry(): TemplateRegistry | null {
    const registryPath = join(this.templatesDir, 'registry.json')
    if (!existsSync(registryPath)) return null
    try {
      return JSON.parse(readFileSync(registryPath, 'utf-8')) as TemplateRegistry
    } catch {
      return null
    }
  }

  private findEntry(idOrAlias: string): TemplateRegistryEntry | null {
    const templates = this.listTemplates()
    const lower = idOrAlias.toLowerCase()

    // Match by ID first
    const byId = templates.find(t => t.id === lower)
    if (byId) return byId

    // Match by alias
    const byAlias = templates.find(t =>
      t.aliases.some(a => a.toLowerCase() === lower),
    )
    if (byAlias) return byAlias

    return null
  }

  private loadManifest(
    dir: string,
    entry: TemplateRegistryEntry,
  ): TemplateManifest {
    const manifestPath = join(dir, 'manifest.json')
    if (existsSync(manifestPath)) {
      try {
        return JSON.parse(
          readFileSync(manifestPath, 'utf-8'),
        ) as TemplateManifest
      } catch {
        // Fall through to synthesized manifest
      }
    }

    // Legacy fallback: synthesize manifest from directory contents
    return this.synthesizeManifest(dir, entry)
  }

  private synthesizeManifest(
    dir: string,
    entry: TemplateRegistryEntry,
  ): TemplateManifest {
    const hasMainTex = existsSync(join(dir, 'main.tex'))
    const hasMakefile = existsSync(join(dir, 'Makefile'))

    return {
      id: entry.id,
      name: entry.name,
      venue_type: entry.venue_type as TemplateManifest['venue_type'],
      field: entry.field,
      description: `${entry.name} template`,
      template_files: {
        main: hasMainTex ? 'main.tex' : 'main.tex',
        makefile: hasMakefile ? 'Makefile' : undefined,
      },
      compilation: {
        engine: 'pdflatex',
        bibtex: 'bibtex',
        sequence: ['pdflatex', 'bibtex', 'pdflatex', 'pdflatex'],
        extra_packages: [],
      },
    }
  }

  private loadConstraints(dir: string): VenueConstraints | null {
    const constraintsPath = join(dir, 'constraints.json')
    if (!existsSync(constraintsPath)) return null
    try {
      return JSON.parse(
        readFileSync(constraintsPath, 'utf-8'),
      ) as VenueConstraints
    } catch {
      return null
    }
  }

  private autoDiscover(): TemplateRegistryEntry[] {
    if (!existsSync(this.templatesDir)) return []

    const entries: TemplateRegistryEntry[] = []
    const dirs = readdirSync(this.templatesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)

    for (const dirName of dirs) {
      const dir = join(this.templatesDir, dirName)
      if (!existsSync(join(dir, 'main.tex'))) continue

      // Try to read manifest for metadata
      const manifestPath = join(dir, 'manifest.json')
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(
            readFileSync(manifestPath, 'utf-8'),
          ) as TemplateManifest
          entries.push({
            id: manifest.id,
            name: manifest.name,
            aliases: [manifest.id],
            venue_type: manifest.venue_type,
            field: manifest.field,
            path: dirName,
          })
          continue
        } catch {
          // Fall through
        }
      }

      // Minimal entry from directory name
      entries.push({
        id: dirName,
        name: dirName,
        aliases: [dirName],
        venue_type: 'preprint',
        field: 'general',
        path: dirName,
      })
    }

    return entries
  }
}
