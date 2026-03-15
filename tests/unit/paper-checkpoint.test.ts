import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CheckpointManager } from '../../src/paper/checkpoint'
import type { ProjectState } from '../../src/paper/types'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../../src/paper/types'

function createTestState(): ProjectState {
  return {
    id: 'test-id',
    name: 'test',
    topic: 'Test topic',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    model_assignments: { ...DEFAULT_MODEL_ASSIGNMENTS },
    artifacts: {
      literature_db: '/test',
      selected_proposal: null,
      experiment_code: null,
      results_dir: null,
      paper_tex: null,
      compiled_pdf: null,
    },
  }
}

describe('CheckpointManager', () => {
  let tempDir: string
  let cm: CheckpointManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-paper-cp-'))
    cm = new CheckpointManager(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('saves and loads checkpoint', () => {
    const state = createTestState()
    cm.saveCheckpoint('research', state, { note: 'test' })

    const loaded = cm.loadCheckpoint('research')
    expect(loaded).not.toBeNull()
    expect(loaded!.label).toBe('research')
    expect(loaded!.state_snapshot.id).toBe('test-id')
    expect(loaded!.metadata.note).toBe('test')
  })

  test('returns null for missing checkpoint', () => {
    expect(cm.loadCheckpoint('proposal')).toBeNull()
  })

  test('loads latest checkpoint by timestamp', async () => {
    const state = createTestState()
    cm.saveCheckpoint('aaa-first', state)

    // Ensure different timestamp in filename
    await new Promise(resolve => setTimeout(resolve, 15))

    const state2 = { ...state, topic: 'Updated topic' }
    cm.saveCheckpoint('aaa-second', state2)

    const latest = cm.loadLatestCheckpoint()
    expect(latest).not.toBeNull()
    // Latest by filename sort (both start with aaa-, so timestamp part determines order)
    expect(latest!.state_snapshot.topic).toBe('Updated topic')
  })

  test('lists all checkpoints', () => {
    const state = createTestState()
    cm.saveCheckpoint('research', state)
    cm.saveCheckpoint('experiment', state)

    const list = cm.listCheckpoints()
    expect(list.length).toBe(2)
    expect(list.map(c => c.label)).toContain('research')
    expect(list.map(c => c.label)).toContain('experiment')
  })
})
