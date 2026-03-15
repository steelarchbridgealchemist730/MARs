import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import yaml from 'js-yaml'
import type {
  DKPBuildConfig,
  TextbookConfig,
  PaperSourceConfig,
  ExtraSearchConfig,
} from './types'

// ── Types ───────────────────────────────────────────────

export interface RawBuildConfig {
  name?: unknown
  description?: unknown
  textbooks?: unknown[]
  papers?: unknown[]
  extra_searches?: unknown[]
  registries?: unknown
}

export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigParseError'
  }
}

// ── Path Expansion ──────────────────────────────────────

/** Expand ~ to home directory and resolve to absolute path. */
export function expandPath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(2))
  }
  return resolve(p)
}

// ── Config Parsing ──────────────────────────────────────

/** Parse a YAML config file into a validated DKPBuildConfig. */
export function parseConfigFile(filePath: string): DKPBuildConfig {
  const absPath = expandPath(filePath)
  if (!existsSync(absPath)) {
    throw new ConfigParseError(`Config file not found: ${absPath}`)
  }

  const raw = readFileSync(absPath, 'utf-8')
  return parseConfigYAML(raw)
}

/** Parse a YAML string into a validated DKPBuildConfig. */
export function parseConfigYAML(yamlStr: string): DKPBuildConfig {
  let parsed: unknown
  try {
    parsed = yaml.load(yamlStr)
  } catch (err) {
    throw new ConfigParseError(
      `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigParseError('Config must be a YAML object')
  }

  const raw = parsed as RawBuildConfig
  return validateConfig(raw)
}

// ── Validation ──────────────────────────────────────────

function validateConfig(raw: RawBuildConfig): DKPBuildConfig {
  // Required: name
  if (!raw.name || typeof raw.name !== 'string') {
    throw new ConfigParseError('Config must have a "name" string field')
  }

  // Required: description
  if (!raw.description || typeof raw.description !== 'string') {
    throw new ConfigParseError('Config must have a "description" string field')
  }

  const config: DKPBuildConfig = {
    name: raw.name,
    description: raw.description,
  }

  // Optional: textbooks
  if (raw.textbooks) {
    if (!Array.isArray(raw.textbooks)) {
      throw new ConfigParseError('"textbooks" must be an array')
    }
    config.textbooks = raw.textbooks.map(validateTextbook)
  }

  // Optional: papers
  if (raw.papers) {
    if (!Array.isArray(raw.papers)) {
      throw new ConfigParseError('"papers" must be an array')
    }
    config.papers = raw.papers.map(validatePaper)
  }

  // Optional: extra_searches
  if (raw.extra_searches) {
    if (!Array.isArray(raw.extra_searches)) {
      throw new ConfigParseError('"extra_searches" must be an array')
    }
    config.extra_searches = raw.extra_searches.map(validateExtraSearch)
  }

  // Optional: registries
  if (raw.registries && typeof raw.registries === 'object') {
    const reg = raw.registries as Record<string, unknown>
    config.registries = {
      search_datasets: reg.search_datasets === true,
      search_benchmarks: reg.search_benchmarks === true,
      search_codebases: reg.search_codebases === true,
    }
  }

  return config
}

function validateTextbook(raw: unknown): TextbookConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigParseError('Each textbook must be an object')
  }
  const obj = raw as Record<string, unknown>

  if (!obj.path || typeof obj.path !== 'string') {
    throw new ConfigParseError('Each textbook must have a "path" string')
  }
  if (!obj.id || typeof obj.id !== 'string') {
    throw new ConfigParseError('Each textbook must have an "id" string')
  }

  const result: TextbookConfig = {
    path: expandPath(obj.path),
    id: obj.id,
  }

  if (Array.isArray(obj.focus_chapters)) {
    result.focus_chapters = obj.focus_chapters.filter(
      (ch): ch is number => typeof ch === 'number',
    )
  }

  return result
}

function validatePaper(raw: unknown): PaperSourceConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigParseError('Each paper must be an object')
  }
  const obj = raw as Record<string, unknown>

  if (!obj.id || typeof obj.id !== 'string') {
    throw new ConfigParseError('Each paper must have an "id" string')
  }

  const result: PaperSourceConfig = { id: obj.id }

  if (typeof obj.path === 'string') {
    result.path = expandPath(obj.path)
  }

  if (typeof obj.source === 'string') {
    if (obj.source === 'semantic_scholar' || obj.source === 'arxiv') {
      result.source = obj.source
    } else {
      throw new ConfigParseError(
        `Paper "${obj.id}": source must be "semantic_scholar" or "arxiv"`,
      )
    }
  }

  return result
}

function validateExtraSearch(raw: unknown): ExtraSearchConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigParseError('Each extra_search must be an object')
  }
  const obj = raw as Record<string, unknown>

  if (!obj.query || typeof obj.query !== 'string') {
    throw new ConfigParseError('Each extra_search must have a "query" string')
  }

  return {
    query: obj.query,
    max_results: typeof obj.max_results === 'number' ? obj.max_results : 10,
    year_from: typeof obj.year_from === 'number' ? obj.year_from : undefined,
  }
}
