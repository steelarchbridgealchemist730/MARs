import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { executeAgent } from '../../src/paper/agent-dispatch'
import {
  initializeFromProposal,
  type ResearchState,
} from '../../src/paper/research-state'

function makeState(): ResearchState {
  return initializeFromProposal(
    {
      id: 'test',
      title: 'Test',
      abstract: 'Test',
      methodology: 'test',
      innovation: [],
      novelty_score: 0.5,
      impact_score: 0.5,
      feasibility: { score: 0.8, data_required: 'none' },
    } as any,
    { budget_usd: 50 },
  )
}

describe('executeAgent', () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
  })

  test('returns error for non-existent agent', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-dispatch-'))
    process.chdir(tmpDir)

    try {
      const result = await executeAgent(
        'nonexistent-agent',
        'do something',
        'context',
        makeState(),
      )
      expect(result.success).toBe(false)
      expect(result.summary).toContain('not found')
      expect(result.summary).toContain('nonexistent-agent')
    } finally {
      process.chdir(originalCwd)
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('lists available agents in error message', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-dispatch-'))
    const agentsDir = join(tmpDir, 'agents')
    mkdirSync(agentsDir, { recursive: true })

    // Create a mock agent
    writeFileSync(
      join(agentsDir, 'test-agent.md'),
      `---
name: test-agent
description: A test agent
---

You are a test agent.`,
      'utf-8',
    )

    process.chdir(tmpDir)

    try {
      const result = await executeAgent(
        'nonexistent',
        'task',
        'ctx',
        makeState(),
      )
      expect(result.success).toBe(false)
      expect(result.summary).toContain('Available')
      // Should list agents from the tmpDir/agents/ directory
      // Note: may also include real project agents if cwd resolves them
      expect(result.summary.length).toBeGreaterThan(20)
    } finally {
      process.chdir(originalCwd)
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('result has correct ExecutionResult structure', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-dispatch-'))
    process.chdir(tmpDir)

    try {
      const result = await executeAgent(
        'nonexistent',
        'task',
        'ctx',
        makeState(),
      )
      // Verify structure even on failure
      expect(typeof result.success).toBe('boolean')
      expect(typeof result.agent).toBe('string')
      expect(typeof result.summary).toBe('string')
      expect(Array.isArray(result.artifacts_produced)).toBe(true)
      expect(Array.isArray(result.new_claims)).toBe(true)
      expect(Array.isArray(result.new_evidence)).toBe(true)
      expect(typeof result.cost_usd).toBe('number')
    } finally {
      process.chdir(originalCwd)
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
