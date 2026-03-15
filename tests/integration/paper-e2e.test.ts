import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../src/paper/project-manager'

describe('Paper E2E: project lifecycle', () => {
  let tempDir: string
  let pm: ProjectManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-paper-e2e-'))
    pm = new ProjectManager(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('full project init creates all expected directories', () => {
    const state = pm.initProject('GARCH model for Bitcoin volatility')

    expect(state.topic).toBe('GARCH model for Bitcoin volatility')

    // Verify all directories exist
    expect(existsSync(join(tempDir, '.claude-paper'))).toBe(true)
    expect(existsSync(join(tempDir, 'literature/papers'))).toBe(true)
    expect(existsSync(join(tempDir, 'literature/notes'))).toBe(true)
    expect(existsSync(join(tempDir, 'proposals'))).toBe(true)
    expect(existsSync(join(tempDir, 'experiments/src'))).toBe(true)
    expect(existsSync(join(tempDir, 'experiments/results/tables'))).toBe(true)
    expect(existsSync(join(tempDir, 'experiments/results/figures'))).toBe(true)
    expect(existsSync(join(tempDir, 'paper/sections'))).toBe(true)
    expect(existsSync(join(tempDir, 'paper/figures'))).toBe(true)
    expect(existsSync(join(tempDir, 'reviews'))).toBe(true)

    // Verify state.json
    const stateFile = join(tempDir, '.claude-paper/state.json')
    expect(existsSync(stateFile)).toBe(true)
    const loaded = JSON.parse(readFileSync(stateFile, 'utf-8'))
    expect(loaded.topic).toBe('GARCH model for Bitcoin volatility')

    // Verify config.json
    const configFile = join(tempDir, '.claude-paper/config.json')
    expect(existsSync(configFile)).toBe(true)

    // Verify history
    const historyFile = join(tempDir, '.claude-paper/history.jsonl')
    expect(existsSync(historyFile)).toBe(true)
  })

  test('project state has no pipeline stages (v3 architecture)', () => {
    const state = pm.initProject('Test research')

    // v3: No stages, no pipeline status — orchestrator manages cognitive state
    expect((state as any).stages).toBeUndefined()
    expect((state as any).current_stage).toBeUndefined()
    expect((state as any).stage_status).toBeUndefined()

    // Has model assignments and artifacts
    expect(state.model_assignments).toBeDefined()
    expect(state.artifacts).toBeDefined()
  })

  test('checkpoint save and restore preserves state', () => {
    const state = pm.initProject('Checkpoint test')

    // Save checkpoint
    const filepath = pm.checkpoint.saveCheckpoint('research', pm.getState(), {
      test: true,
    })
    expect(existsSync(filepath)).toBe(true)

    // Load checkpoint
    const cp = pm.checkpoint.loadCheckpoint('research')
    expect(cp).not.toBeNull()
    expect(cp!.label).toBe('research')
    expect(cp!.state_snapshot.topic).toBe('Checkpoint test')
    expect(cp!.metadata.test).toBe(true)
  })

  test('project can be loaded after creation', () => {
    pm.initProject('Reload test')

    const pm2 = new ProjectManager(tempDir)
    const loaded = pm2.loadProject()

    expect(loaded.topic).toBe('Reload test')
  })
})

describe('Paper E2E: tool registration', () => {
  test('all paper tools are registered and have correct properties', async () => {
    const { getAllTools } = await import('../../src/tools/index')
    const tools = getAllTools()

    const paperToolNames = [
      'ArxivSearch',
      'SemanticScholarSearch',
      'SSRNSearch',
      'PaperDownload',
      'PaperQA',
      'LatexCompile',
      'ResultInsert',
    ]

    for (const name of paperToolNames) {
      const tool = tools.find((t: any) => t.name === name)
      expect(tool).toBeTruthy()
      expect(tool.inputSchema).toBeTruthy()
      expect(typeof tool.isReadOnly).toBe('function')
      expect(typeof tool.isConcurrencySafe).toBe('function')
      expect(typeof tool.needsPermissions).toBe('function')
    }

    // Verify read-only tools
    const readOnlyTools = ['ArxivSearch', 'SemanticScholarSearch', 'SSRNSearch']
    for (const name of readOnlyTools) {
      const tool = tools.find((t: any) => t.name === name)
      expect(tool.isReadOnly()).toBe(true)
    }

    // Verify write tools
    const writeTools = ['PaperDownload', 'LatexCompile', 'ResultInsert']
    for (const name of writeTools) {
      const tool = tools.find((t: any) => t.name === name)
      expect(tool.isReadOnly()).toBe(false)
    }
  })
})
