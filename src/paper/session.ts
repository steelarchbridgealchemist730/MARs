import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'fs'
import { join, basename } from 'path'
import { getCwd } from '@utils/state'

const SESSIONS_DIR_NAME = '.claude-paper-research'
const SESSION_META = 'session.json'

export interface SessionMeta {
  id: string
  topic: string
  created_at: string
  last_active: string
}

function sanitizeTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

/**
 * Get the current research session directory.
 * Structure: {cwd}/.claude-paper-research/{session-slug}/
 *
 * If a session already exists (only one), returns it.
 * If multiple exist, returns the most recently active one.
 * If none exist, returns the base dir (for backward compat).
 */
export function getSessionDir(topic?: string): string {
  const cwd = getCwd()
  const baseDir = join(cwd, SESSIONS_DIR_NAME)

  // If a topic is provided, create/find a session for it
  if (topic) {
    const slug = sanitizeTopic(topic)
    const sessionDir = join(baseDir, slug)
    mkdirSync(sessionDir, { recursive: true })

    // Write/update session meta
    const metaPath = join(sessionDir, SESSION_META)
    let meta: SessionMeta
    if (existsSync(metaPath)) {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      meta.last_active = new Date().toISOString()
    } else {
      meta = {
        id: slug,
        topic,
        created_at: new Date().toISOString(),
        last_active: new Date().toISOString(),
      }
    }
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8')
    return sessionDir
  }

  // No topic: find existing session
  if (!existsSync(baseDir)) return baseDir

  try {
    const entries = readdirSync(baseDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const metaPath = join(baseDir, e.name, SESSION_META)
        if (existsSync(metaPath)) {
          try {
            const meta: SessionMeta = JSON.parse(
              readFileSync(metaPath, 'utf-8'),
            )
            return { dir: join(baseDir, e.name), meta }
          } catch {
            return null
          }
        }
        return null
      })
      .filter(Boolean) as Array<{ dir: string; meta: SessionMeta }>

    if (entries.length === 0) {
      // Backward compat: check if baseDir itself has research files
      if (
        existsSync(join(baseDir, 'literature')) ||
        existsSync(join(baseDir, 'discovered-papers.json'))
      ) {
        return baseDir
      }
      return baseDir
    }

    // Return most recently active session
    entries.sort(
      (a, b) =>
        new Date(b.meta.last_active).getTime() -
        new Date(a.meta.last_active).getTime(),
    )
    return entries[0].dir
  } catch {
    return baseDir
  }
}

/**
 * List all research sessions.
 */
export function listSessions(): SessionMeta[] {
  const cwd = getCwd()
  const baseDir = join(cwd, SESSIONS_DIR_NAME)
  if (!existsSync(baseDir)) return []

  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const metaPath = join(baseDir, e.name, SESSION_META)
        if (existsSync(metaPath)) {
          try {
            return JSON.parse(readFileSync(metaPath, 'utf-8')) as SessionMeta
          } catch {
            return null
          }
        }
        return null
      })
      .filter(Boolean) as SessionMeta[]
  } catch {
    return []
  }
}
