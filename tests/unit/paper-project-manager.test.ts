import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../src/paper/project-manager'
import type { ProjectState } from '../../src/paper/types'

describe('ProjectManager', () => {
  let tempDir: string
  let pm: ProjectManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-paper-test-'))
    pm = new ProjectManager(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('initProject', () => {
    test('creates project directory structure', () => {
      pm.initProject('GARCH model for Bitcoin volatility')

      const expectedDirs = [
        '.claude-paper',
        '.claude-paper/checkpoints',
        'literature/papers',
        'literature/index',
        'literature/notes',
        'proposals',
        'experiments/src',
        'experiments/data',
        'experiments/configs',
        'experiments/results/tables',
        'experiments/results/figures',
        'experiments/results/logs',
        'paper/sections',
        'paper/figures',
        'paper/tables',
        'reviews',
      ]

      for (const dir of expectedDirs) {
        expect(existsSync(join(tempDir, dir))).toBe(true)
      }
    })

    test('creates valid state.json', () => {
      const state = pm.initProject('GARCH model for Bitcoin volatility')

      expect(state.topic).toBe('GARCH model for Bitcoin volatility')
      expect(state.id).toBeTruthy()
      expect(state.model_assignments).toBeDefined()
      expect(state.artifacts).toBeDefined()

      // v3: no pipeline stages
      expect((state as any).stages).toBeUndefined()
      expect((state as any).current_stage).toBeUndefined()

      // Verify state.json file exists and is parseable
      const content = readFileSync(
        join(tempDir, '.claude-paper', 'state.json'),
        'utf-8',
      )
      const parsed = JSON.parse(content) as ProjectState
      expect(parsed.id).toBe(state.id)
    })

    test('creates config.json with defaults', () => {
      pm.initProject('Test topic')

      const configPath = join(tempDir, '.claude-paper', 'config.json')
      expect(existsSync(configPath)).toBe(true)

      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(config.paper.template).toBe('neurips')
      expect(config.literature.sources).toContain('arxiv')
      // v3: no pipeline config
      expect(config.pipeline).toBeUndefined()
    })

    test('writes history entry on init', () => {
      pm.initProject('Test topic')

      const history = pm.getHistory()
      expect(history.length).toBe(1)
      expect(history[0].action).toBe('init')
      expect(history[0].details).toContain('Test topic')
    })
  })

  describe('loadProject', () => {
    test('loads existing project', () => {
      const original = pm.initProject('Test topic')
      const pm2 = new ProjectManager(tempDir)
      const loaded = pm2.loadProject()

      expect(loaded.id).toBe(original.id)
      expect(loaded.topic).toBe(original.topic)
    })

    test('throws on missing project', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'claude-paper-empty-'))
      const pm2 = new ProjectManager(emptyDir)

      expect(() => pm2.loadProject()).toThrow('No project found')
      rmSync(emptyDir, { recursive: true, force: true })
    })
  })

  describe('updateArtifact', () => {
    test('updates artifact and persists', () => {
      pm.initProject('Test topic')
      pm.updateArtifact('selected_proposal', '/path/to/proposal.md')

      const pm2 = new ProjectManager(tempDir)
      pm2.loadProject()
      expect(pm2.getArtifacts().selected_proposal).toBe('/path/to/proposal.md')
    })
  })

  describe('isInitialized', () => {
    test('returns false for empty dir', () => {
      expect(pm.isInitialized()).toBe(false)
    })

    test('returns true after init', () => {
      pm.initProject('Test topic')
      expect(pm.isInitialized()).toBe(true)
    })
  })
})
