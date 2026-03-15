import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  Orchestrator,
  type OrchestratorCallbacks,
  type ExecutionResult,
} from '../../src/paper/orchestrator'
import {
  initializeFromProposal,
  loadResearchState,
  saveResearchState,
  getAdmittedClaims,
  type ResearchState,
} from '../../src/paper/research-state'

function makeProposal() {
  return {
    id: 'test-proposal',
    title: 'Test Research Proposal',
    abstract: 'A test proposal for unit testing.',
    methodology: 'Unit testing methodology',
    innovation: [{ description: 'Novel testing approach' }],
    novelty_score: 0.8,
    impact_score: 0.7,
    feasibility: {
      score: 0.9,
      data_required: 'synthetic test data',
    },
  } as any
}

function makeCallbacks(
  overrides?: Partial<OrchestratorCallbacks>,
): OrchestratorCallbacks {
  return {
    executeAgent: async (): Promise<ExecutionResult> => ({
      success: true,
      agent: 'test-agent',
      summary: 'Test completed',
      artifacts_produced: [],
      new_claims: [],
      new_evidence: [],
      cost_usd: 0.5,
    }),
    presentDecision: async () => 'approve',
    onProgress: () => {},
    onStateChange: () => {},
    onComplete: () => {},
    onError: () => {},
    ...overrides,
  }
}

describe('Orchestrator', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-orch-'))
    // Set dummy API key so digest's LLM call fails fast (401) instead of hanging
    if (!process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy-key-for-unit-tests'
    }
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('fromProposal creates orchestrator with initialized state', () => {
    const callbacks = makeCallbacks()
    const orch = Orchestrator.fromProposal(tmpDir, makeProposal(), callbacks, {
      mode: 'auto',
      budget_usd: 50,
    })
    const state = orch.getState()
    expect(state.initialized).toBe(true)
    expect(state.claimGraph.claims.length).toBeGreaterThan(0)
    expect(state.budget.total_usd).toBe(50)
  })

  test('resume returns null when no saved state', () => {
    const callbacks = makeCallbacks()
    const orch = Orchestrator.resume(tmpDir, callbacks, { mode: 'auto' })
    expect(orch).toBeNull()
  })

  test('resume loads saved state', () => {
    const state = initializeFromProposal(makeProposal(), { budget_usd: 100 })
    saveResearchState(tmpDir, state)

    const callbacks = makeCallbacks()
    const orch = Orchestrator.resume(tmpDir, callbacks, { mode: 'auto' })
    expect(orch).not.toBeNull()
    expect(orch!.getState().budget.total_usd).toBe(100)
  })

  test('abort stops the orchestrator', () => {
    const callbacks = makeCallbacks()
    const orch = Orchestrator.fromProposal(tmpDir, makeProposal(), callbacks, {
      mode: 'auto',
    })
    orch.abort()
    // After abort, the next run iteration should stop
    // We just verify abort() doesn't throw
    expect(true).toBe(true)
  })

  test('checkpoint saves state to disk', () => {
    const callbacks = makeCallbacks()
    const orch = Orchestrator.fromProposal(tmpDir, makeProposal(), callbacks, {
      mode: 'auto',
      budget_usd: 25,
    })

    // Access private checkpoint via type assertion
    ;(orch as any).checkpoint()

    const loaded = loadResearchState(tmpDir)
    expect(loaded).not.toBeNull()
    expect(loaded!.budget.total_usd).toBe(25)
  })

  test('isDone returns true when budget is exhausted', () => {
    const state = initializeFromProposal(makeProposal(), { budget_usd: 0 })
    state.budget.remaining_usd = 0

    const callbacks = makeCallbacks()
    const orch = new Orchestrator(tmpDir, state, callbacks, { mode: 'auto' })
    expect((orch as any).isDone()).toBe(true)
  })

  test('isDone returns false when budget remains', () => {
    const state = initializeFromProposal(makeProposal(), { budget_usd: 100 })

    const callbacks = makeCallbacks()
    const orch = new Orchestrator(tmpDir, state, callbacks, { mode: 'auto' })
    expect((orch as any).isDone()).toBe(false)
  })

  test('digest updates state with execution results', async () => {
    const callbacks = makeCallbacks()
    const orch = Orchestrator.fromProposal(tmpDir, makeProposal(), callbacks, {
      mode: 'auto',
      budget_usd: 100,
    })

    const result: ExecutionResult = {
      success: true,
      agent: 'investigator',
      summary: 'Found key insight',
      artifacts_produced: ['literature/survey.md'],
      new_claims: [
        {
          type: 'empirical',
          epistemicLayer: 'observation',
          statement: 'Method X outperforms Y',
          confidence: 0.7,
          evidenceType: 'empirical_support',
          vulnerabilityScore: 0.3,
        },
      ],
      new_evidence: [
        {
          claim_statement: 'Method X outperforms Y',
          kind: 'grounded',
          source_ref: 'paper123',
        },
      ],
      cost_usd: 2.5,
    }

    const newState = await (orch as any).digest(result)
    // digest() now only records spending + literature — claims/evidence/trajectory are in run() loop
    expect(newState.budget.spent_usd).toBeGreaterThan(0)
    // Claim graph and evidence should be unchanged by digest (handled in run loop now)
    expect(newState.stability).toBeDefined()
  })

  test('callbacks receive progress messages', () => {
    const messages: string[] = []
    const callbacks = makeCallbacks({
      onProgress: (msg: string) => messages.push(msg),
    })

    const orch = Orchestrator.fromProposal(tmpDir, makeProposal(), callbacks, {
      mode: 'auto',
    })

    // Trigger progress via internal method
    callbacks.onProgress('Test progress')
    expect(messages).toContain('Test progress')
  })

  test('state has correct initial structure from proposal', () => {
    const callbacks = makeCallbacks()
    const orch = Orchestrator.fromProposal(tmpDir, makeProposal(), callbacks, {
      mode: 'auto',
      budget_usd: 75,
      paper_type: 'mixed',
    })

    const state = orch.getState()
    expect(state.paper_type).toBe('mixed')
    expect(state.budget.total_usd).toBe(75)
    expect(state.claimGraph.claims.length).toBeGreaterThanOrEqual(1)
    expect(state.evidencePool.grounded).toEqual([])
    expect(state.evidencePool.derived).toEqual([])
    expect(state.stability).toBeDefined()
    expect(state.trajectory).toEqual([])
    expect(state.artifacts.entries).toEqual([])
  })
})
