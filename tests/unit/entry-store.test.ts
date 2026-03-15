import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EntryStore } from '../../src/paper/domain-knowledge/entry-store'
import type { KnowledgeEntry } from '../../src/paper/domain-knowledge/types'

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: 'thm-001',
    type: 'theorem',
    source: { id: 'test-book', chapter: '1', section: '1.1', page: 5 },
    label: 'Test Theorem',
    name: 'Test Theorem',
    statement: 'For all x, f(x) > 0.',
    usability: { citable: true, common_use: 'testing' },
    relations: {
      depends_on: [],
      used_by: [],
      generalizes: null,
      specialized_by: [],
    },
    tags: ['test'],
    ...overrides,
  }
}

describe('EntryStore', () => {
  let tempDir: string
  let store: EntryStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'entry-store-test-'))
    store = new EntryStore(tempDir)
    store.init()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('init() creates directory structure', () => {
    expect(existsSync(join(tempDir, 'knowledge', 'entries'))).toBe(true)
    expect(
      existsSync(join(tempDir, 'knowledge', 'entries', '.counters.json')),
    ).toBe(true)
  })

  test('nextId() generates sequential IDs per type', () => {
    expect(store.nextId('theorem')).toBe('thm-001')
    expect(store.nextId('theorem')).toBe('thm-002')
    expect(store.nextId('definition')).toBe('def-001')
    expect(store.nextId('theorem')).toBe('thm-003')
    expect(store.nextId('algorithm')).toBe('alg-001')
    expect(store.nextId('definition')).toBe('def-002')
  })

  test('nextId() uses correct prefixes for all types', () => {
    expect(store.nextId('theorem')).toBe('thm-001')
    expect(store.nextId('proposition')).toBe('prop-001')
    expect(store.nextId('lemma')).toBe('lem-001')
    expect(store.nextId('corollary')).toBe('cor-001')
    expect(store.nextId('definition')).toBe('def-001')
    expect(store.nextId('algorithm')).toBe('alg-001')
    expect(store.nextId('result')).toBe('res-001')
  })

  test('saveEntry() + getEntry() roundtrip', () => {
    const entry = makeEntry({ id: 'thm-001' })
    store.saveEntry(entry)

    const loaded = store.getEntry('thm-001')
    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe('thm-001')
    expect(loaded!.type).toBe('theorem')
    expect(loaded!.label).toBe('Test Theorem')
    expect(loaded!.statement).toBe('For all x, f(x) > 0.')
    expect(loaded!.tags).toEqual(['test'])
  })

  test('getEntry() returns null for missing ID', () => {
    expect(store.getEntry('nonexistent')).toBeNull()
  })

  test('listEntryIds() returns all saved IDs', () => {
    store.saveEntry(makeEntry({ id: 'thm-001' }))
    store.saveEntry(makeEntry({ id: 'def-001', type: 'definition' }))
    store.saveEntry(makeEntry({ id: 'alg-001', type: 'algorithm' }))

    const ids = store.listEntryIds()
    expect(ids).toContain('thm-001')
    expect(ids).toContain('def-001')
    expect(ids).toContain('alg-001')
    expect(ids).toHaveLength(3)
  })

  test('listEntryIds() excludes .counters.json', () => {
    store.saveEntry(makeEntry({ id: 'thm-001' }))
    const ids = store.listEntryIds()
    expect(ids).not.toContain('.counters')
    expect(ids).toHaveLength(1)
  })

  test('loadAllEntries() returns all entries', () => {
    store.saveEntry(makeEntry({ id: 'thm-001' }))
    store.saveEntry(
      makeEntry({ id: 'def-001', type: 'definition', label: 'A Definition' }),
    )

    const entries = store.loadAllEntries()
    expect(entries).toHaveLength(2)
    const labels = entries.map(e => e.label).sort()
    expect(labels).toEqual(['A Definition', 'Test Theorem'])
  })

  test('counter persistence across store instances', () => {
    store.nextId('theorem') // thm-001
    store.nextId('theorem') // thm-002
    store.nextId('definition') // def-001

    // Create a new store instance on the same directory
    const store2 = new EntryStore(tempDir)

    // IDs should continue from where the first store left off
    expect(store2.nextId('theorem')).toBe('thm-003')
    expect(store2.nextId('definition')).toBe('def-002')
  })

  test('entries are stored as valid JSON files', () => {
    const entry = makeEntry({ id: 'thm-001' })
    store.saveEntry(entry)

    const filePath = join(tempDir, 'knowledge', 'entries', 'thm-001.json')
    expect(existsSync(filePath)).toBe(true)

    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(raw.id).toBe('thm-001')
    expect(raw.type).toBe('theorem')
  })
})
