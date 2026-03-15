import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { FragmentStore } from '../../src/paper/fragment-store'

const TEST_DIR = join(process.cwd(), '.test-fragment-store')

describe('FragmentStore', () => {
  let store: FragmentStore

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    store = new FragmentStore(TEST_DIR)
    store.init()
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true })
    }
  })

  describe('init', () => {
    it('creates fragment directories', () => {
      expect(existsSync(join(TEST_DIR, 'fragments', 'proofs'))).toBe(true)
      expect(existsSync(join(TEST_DIR, 'fragments', 'tables'))).toBe(true)
      expect(existsSync(join(TEST_DIR, 'fragments', 'figures'))).toBe(true)
      expect(existsSync(join(TEST_DIR, 'fragments', 'related_work'))).toBe(true)
    })

    it('creates index.json', () => {
      expect(existsSync(join(TEST_DIR, 'fragments', 'index.json'))).toBe(true)
    })
  })

  describe('create', () => {
    it('creates a fragment file and index entry', () => {
      const meta = store.create(
        'proofs',
        'Main Theorem',
        '\\begin{theorem}\nTest\n\\end{theorem}',
      )

      expect(meta.id).toMatch(/^proofs-/)
      expect(meta.type).toBe('proofs')
      expect(meta.title).toBe('Main Theorem')
      expect(meta.status).toBe('draft')

      // Check file exists
      const fullPath = join(TEST_DIR, meta.file_path)
      expect(existsSync(fullPath)).toBe(true)
      expect(readFileSync(fullPath, 'utf-8')).toContain('\\begin{theorem}')
    })

    it('records creation metadata', () => {
      const meta = store.create(
        'tables',
        'Results Table',
        '\\begin{table}...',
        {
          created_by: 'result-analyzer',
          notes: 'Baseline comparison',
          estimated_pages: 0.3,
        },
      )

      expect(meta.created_by).toBe('result-analyzer')
      expect(meta.notes).toBe('Baseline comparison')
      expect(meta.estimated_pages).toBe(0.3)
    })
  })

  describe('get and readContent', () => {
    it('retrieves fragment metadata', () => {
      const created = store.create('proofs', 'Lemma 1', 'proof content')
      const retrieved = store.get(created.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.title).toBe('Lemma 1')
    })

    it('reads fragment content', () => {
      const created = store.create(
        'algorithms',
        'Algorithm 1',
        '\\begin{algorithm}...',
      )
      const content = store.readContent(created.id)
      expect(content).toBe('\\begin{algorithm}...')
    })

    it('returns null for non-existent fragment', () => {
      expect(store.get('nonexistent')).toBeNull()
      expect(store.readContent('nonexistent')).toBeNull()
    })
  })

  describe('updateContent and updateMeta', () => {
    it('updates fragment content', () => {
      const meta = store.create('proofs', 'Theorem', 'old content')
      const updated = store.updateContent(meta.id, 'new content')
      expect(updated).toBe(true)
      expect(store.readContent(meta.id)).toBe('new content')
    })

    it('updates fragment metadata', () => {
      const meta = store.create('proofs', 'Theorem', 'content')
      store.updateMeta(meta.id, { status: 'reviewed', notes: 'Looks good' })
      const refreshed = store.get(meta.id)!
      expect(refreshed.status).toBe('reviewed')
      expect(refreshed.notes).toBe('Looks good')
    })
  })

  describe('delete', () => {
    it('removes fragment from index', () => {
      const meta = store.create('proofs', 'Theorem', 'content')
      expect(store.list().length).toBe(1)
      store.delete(meta.id)
      expect(store.list().length).toBe(0)
    })

    it('removes fragment from paper structure', () => {
      const meta = store.create('proofs', 'Theorem', 'content')
      store.assignToSection('Methods', meta.id)
      store.delete(meta.id)
      expect(store.getPaperStructure()['Methods']).toEqual([])
    })
  })

  describe('list', () => {
    it('lists all fragments', () => {
      store.create('proofs', 'Theorem 1', 'content 1')
      store.create('tables', 'Table 1', 'content 2')
      store.create('proofs', 'Theorem 2', 'content 3')
      expect(store.list().length).toBe(3)
    })

    it('filters by type', () => {
      store.create('proofs', 'Theorem 1', 'content 1')
      store.create('tables', 'Table 1', 'content 2')
      expect(store.list('proofs').length).toBe(1)
      expect(store.list('tables').length).toBe(1)
    })
  })

  describe('paper structure', () => {
    it('assigns fragments to sections', () => {
      const f1 = store.create('proofs', 'Theorem', 'content')
      const f2 = store.create('experiments', 'Setup', 'content')
      store.assignToSection('Methods', f1.id)
      store.assignToSection('Experiments', f2.id)

      const structure = store.getPaperStructure()
      expect(structure['Methods']).toEqual([f1.id])
      expect(structure['Experiments']).toEqual([f2.id])
    })

    it('does not duplicate assignments', () => {
      const f = store.create('proofs', 'Theorem', 'content')
      store.assignToSection('Methods', f.id)
      store.assignToSection('Methods', f.id)
      expect(store.getPaperStructure()['Methods'].length).toBe(1)
    })

    it('identifies unassigned fragments', () => {
      const f1 = store.create('proofs', 'Theorem', 'content')
      const f2 = store.create('tables', 'Table', 'content')
      store.assignToSection('Methods', f1.id)
      const unassigned = store.getUnassigned()
      expect(unassigned.length).toBe(1)
      expect(unassigned[0].id).toBe(f2.id)
    })
  })

  describe('estimatePages', () => {
    it('sums estimated pages', () => {
      store.create('proofs', 'Theorem', 'content', {
        estimated_pages: 1.0,
      })
      store.create('tables', 'Table', 'content', {
        estimated_pages: 0.5,
      })
      expect(store.estimatePages()).toBe(1.5)
    })
  })

  describe('persistence', () => {
    it('persists across store instances', () => {
      store.create('proofs', 'Theorem', 'content')
      store.assignToSection('Methods', store.list()[0].id)

      // Create a new store instance pointing to the same dir
      const store2 = new FragmentStore(TEST_DIR)
      expect(store2.list().length).toBe(1)
      expect(store2.getPaperStructure()['Methods'].length).toBe(1)
    })
  })
})
