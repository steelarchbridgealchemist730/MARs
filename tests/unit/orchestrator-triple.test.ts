import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  Orchestrator,
  type OrchestratorCallbacks,
  type ExecutionResult,
} from '../../src/paper/orchestrator'
import {
  initializeFromProposal,
  type ResearchState,
} from '../../src/paper/research-state'
import { ClaimGraph, type ClaimInput } from '../../src/paper/claim-graph/index'
import { EvidencePoolManager } from '../../src/paper/evidence-pool'
import type {
  BuilderOutput,
  SkepticOutput,
  ArbiterOutput,
} from '../../src/paper/claim-graph/triple-role-types'
import { parseTripleRoleOutput } from '../../src/paper/json-repair'

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

function makeOrchestrator(tmpDir: string) {
  const callbacks = makeCallbacks()
  return Orchestrator.fromProposal(tmpDir, makeProposal(), callbacks, {
    mode: 'auto',
    budget_usd: 100,
  })
}

function makeGraphWithClaim(
  statement: string,
  opts?: {
    type?: string
    phase?: string
    confidence?: number
    evidenceType?: string
    layer?: string
    grounded?: string[]
    derived?: string[]
  },
): { graph: ClaimGraph; claimId: string } {
  const graph = new ClaimGraph()
  const claimId = graph.addClaim({
    type: (opts?.type as any) ?? 'hypothesis',
    epistemicLayer: (opts?.layer as any) ?? 'explanation',
    statement,
    phase: (opts?.phase as any) ?? 'proposed',
    evidence: {
      grounded: opts?.grounded ?? [],
      derived: opts?.derived ?? [],
    },
    strength: {
      confidence: opts?.confidence ?? 0.7,
      evidenceType: (opts?.evidenceType as any) ?? 'empirical_support',
      vulnerabilityScore: 0.3,
    },
    created_by: 'test',
  })
  return { graph, claimId }
}

describe('Orchestrator Triple-Role Methods', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-triple-'))
    if (!process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy-key-for-unit-tests'
    }
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── parseTripleRoleOutput ──────────────────────────────

  test('parseTripleRoleOutput parses valid JSON', () => {
    const text =
      'Here is my analysis:\n{"narrative": "test", "new_claims_proposed": []}'
    const result = parseTripleRoleOutput<BuilderOutput>(text, 'builder')
    expect(result.narrative).toBe('test')
    expect(result.new_claims_proposed).toEqual([])
  })

  test('parseTripleRoleOutput repairs truncated JSON', () => {
    // JSON with unclosed brace and array — simulates max_tokens cutoff
    const text =
      'Here is the output:\n{"narrative": "test value", "items": [{"a": 1}]'
    const result = parseTripleRoleOutput<any>(text, 'builder')
    expect(result.narrative).toBe('test value')
    expect(result.items).toBeDefined()
  })

  test('parseTripleRoleOutput throws on non-JSON', () => {
    expect(() => parseTripleRoleOutput('no json here', 'builder')).toThrow(
      'Failed to parse builder output',
    )
  })

  // ── arbiterToDecision ──────────────────────────────────

  test('arbiterToDecision produces valid OrchestratorDecision', () => {
    const orch = makeOrchestrator(tmpDir) as any
    const arbiter: ArbiterOutput = {
      claim_updates: [],
      contracted_claims: [],
      next_action: {
        action: 'Run experiment on dataset A',
        delegate_to: 'experiment-runner',
        context: 'Execute benchmark suite',
        priority: 'high',
        estimated_cost_usd: 5.0,
        if_this_fails: 'Try smaller dataset',
      },
      overall_assessment: 'Good progress overall',
    }

    const decision = orch.arbiterToDecision(arbiter)
    expect(decision.reasoning).toBe('Good progress overall')
    expect(decision.action.type).toBe('Run experiment on dataset A')
    expect(decision.action.delegate_to).toBe('experiment-runner')
    expect(decision.action.priority).toBe('high')
    expect(decision.action.estimated_cost_usd).toBe(5.0)
    expect(decision.action.if_this_fails).toBe('Try smaller dataset')
    expect(decision.action.model_preference).toBe('default')
  })

  test('arbiterToDecision validates priority enum', () => {
    const orch = makeOrchestrator(tmpDir) as any
    const arbiter: ArbiterOutput = {
      claim_updates: [],
      contracted_claims: [],
      next_action: {
        action: 'test',
        delegate_to: 'investigator',
        context: 'test',
        priority: 'invalid_priority',
        estimated_cost_usd: 0,
        if_this_fails: 'fallback',
      },
      overall_assessment: 'test',
    }

    const decision = orch.arbiterToDecision(arbiter)
    expect(decision.action.priority).toBe('normal') // fallback
  })

  // ── applyClaimUpdates ─────────────────────────────────

  test('applyClaimUpdates: admit passes admission gate', () => {
    const orch = makeOrchestrator(tmpDir) as any
    const { graph, claimId } = makeGraphWithClaim('Admitted claim', {
      confidence: 0.8,
      evidenceType: 'empirical_support',
      grounded: ['ev1'],
    })
    const pool = new EvidencePoolManager({ grounded: [], derived: [] })

    const arbiter: ArbiterOutput = {
      claim_updates: [
        { claim_id: claimId, action: 'admit', reason: 'well supported' },
      ],
      contracted_claims: [],
      next_action: {
        action: 'x',
        delegate_to: 'x',
        context: '',
        priority: 'normal',
        estimated_cost_usd: 0,
        if_this_fails: '',
      },
      overall_assessment: '',
    }

    const counts = orch.applyClaimUpdates(arbiter, graph, pool)
    const claim = graph.getClaim(claimId)
    expect(claim!.phase).toBe('admitted')
    expect(counts.admitted).toBe(1)
  })

  test('applyClaimUpdates: admit blocked by gate (no evidence)', () => {
    const orch = makeOrchestrator(tmpDir) as any
    const { graph, claimId } = makeGraphWithClaim('No evidence claim', {
      confidence: 0.8,
      evidenceType: 'empirical_support',
      // no grounded or derived evidence
    })
    const pool = new EvidencePoolManager({ grounded: [], derived: [] })

    const arbiter: ArbiterOutput = {
      claim_updates: [
        { claim_id: claimId, action: 'admit', reason: 'try to admit' },
      ],
      contracted_claims: [],
      next_action: {
        action: 'x',
        delegate_to: 'x',
        context: '',
        priority: 'normal',
        estimated_cost_usd: 0,
        if_this_fails: '',
      },
      overall_assessment: '',
    }

    const counts = orch.applyClaimUpdates(arbiter, graph, pool)
    const claim = graph.getClaim(claimId)
    // Should NOT be admitted — gate blocked
    expect(claim!.phase).toBe('proposed')
    expect(counts.admitted).toBe(0)
  })

  test('applyClaimUpdates: demote sets phase=demoted', () => {
    const orch = makeOrchestrator(tmpDir) as any
    const { graph, claimId } = makeGraphWithClaim('Demote this')
    const pool = new EvidencePoolManager({ grounded: [], derived: [] })

    const arbiter: ArbiterOutput = {
      claim_updates: [
        { claim_id: claimId, action: 'demote', reason: 'weak evidence' },
      ],
      contracted_claims: [],
      next_action: {
        action: 'x',
        delegate_to: 'x',
        context: '',
        priority: 'normal',
        estimated_cost_usd: 0,
        if_this_fails: '',
      },
      overall_assessment: '',
    }

    const counts = orch.applyClaimUpdates(arbiter, graph, pool)
    expect(graph.getClaim(claimId)!.phase).toBe('demoted')
    expect(counts.demoted).toBe(1)
  })

  test('applyClaimUpdates: reject sets phase=rejected', () => {
    const orch = makeOrchestrator(tmpDir) as any
    const { graph, claimId } = makeGraphWithClaim('Reject this')
    const pool = new EvidencePoolManager({ grounded: [], derived: [] })

    const arbiter: ArbiterOutput = {
      claim_updates: [
        { claim_id: claimId, action: 'reject', reason: 'contradicted' },
      ],
      contracted_claims: [],
      next_action: {
        action: 'x',
        delegate_to: 'x',
        context: '',
        priority: 'normal',
        estimated_cost_usd: 0,
        if_this_fails: '',
      },
      overall_assessment: '',
    }

    const counts = orch.applyClaimUpdates(arbiter, graph, pool)
    expect(graph.getClaim(claimId)!.phase).toBe('rejected')
    expect(counts.rejected).toBe(1)
  })

  test('applyClaimUpdates: keep with new_confidence updates strength', () => {
    const orch = makeOrchestrator(tmpDir) as any
    const { graph, claimId } = makeGraphWithClaim('Keep this', {
      confidence: 0.5,
    })
    const pool = new EvidencePoolManager({ grounded: [], derived: [] })

    const arbiter: ArbiterOutput = {
      claim_updates: [
        {
          claim_id: claimId,
          action: 'keep',
          new_confidence: 0.9,
          reason: 'more evidence',
        },
      ],
      contracted_claims: [],
      next_action: {
        action: 'x',
        delegate_to: 'x',
        context: '',
        priority: 'normal',
        estimated_cost_usd: 0,
        if_this_fails: '',
      },
      overall_assessment: '',
    }

    const counts = orch.applyClaimUpdates(arbiter, graph, pool)
    expect(graph.getClaim(claimId)!.strength.confidence).toBe(0.9)
    expect(counts.kept).toBe(1)
  })

  test('applyClaimUpdates: handles unknown claim_id gracefully', () => {
    const orch = makeOrchestrator(tmpDir) as any
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager({ grounded: [], derived: [] })

    const arbiter: ArbiterOutput = {
      claim_updates: [
        { claim_id: 'nonexistent-id', action: 'admit', reason: 'nope' },
      ],
      contracted_claims: [],
      next_action: {
        action: 'x',
        delegate_to: 'x',
        context: '',
        priority: 'normal',
        estimated_cost_usd: 0,
        if_this_fails: '',
      },
      overall_assessment: '',
    }

    // Should not throw
    const counts = orch.applyClaimUpdates(arbiter, graph, pool)
    expect(counts.admitted).toBe(0)
    expect(counts.demoted).toBe(0)
    expect(counts.rejected).toBe(0)
    expect(counts.kept).toBe(0)
  })

  // ── applyContractions ─────────────────────────────────

  test('applyContractions updates layer + statement, reverts to proposed', () => {
    const orch = makeOrchestrator(tmpDir) as any
    const { graph, claimId } = makeGraphWithClaim('Original claim', {
      layer: 'exploitation',
      phase: 'under_investigation',
    })

    const arbiter: ArbiterOutput = {
      claim_updates: [],
      contracted_claims: [
        {
          claim_id: claimId,
          new_layer: 'explanation',
          contracted_statement: 'Weaker version of original claim',
        },
      ],
      next_action: {
        action: 'x',
        delegate_to: 'x',
        context: '',
        priority: 'normal',
        estimated_cost_usd: 0,
        if_this_fails: '',
      },
      overall_assessment: '',
    }

    const count = orch.applyContractions(arbiter, graph)
    const claim = graph.getClaim(claimId)
    expect(count).toBe(1)
    expect(claim!.epistemicLayer).toBe('explanation')
    expect(claim!.statement).toBe('Weaker version of original claim')
    expect(claim!.phase).toBe('proposed')
  })

  // ── addBuilderClaimsToGraph ───────────────────────────

  test('addBuilderClaimsToGraph adds proposed claims and patches IDs', () => {
    const orch = makeOrchestrator(tmpDir) as any
    const graph = new ClaimGraph()

    const builder: BuilderOutput = {
      narrative: 'test narrative',
      new_claims_proposed: [
        {
          type: 'hypothesis',
          epistemicLayer: 'explanation',
          statement: 'New hypothesis from builder',
          confidence: 0.6,
        },
        {
          type: 'empirical',
          epistemicLayer: 'observation',
          statement: 'Observed result A > B',
          confidence: 0.8,
        },
      ],
      new_edges_proposed: [],
      recommended_next_actions: [],
    }

    const ids = orch.addBuilderClaimsToGraph(builder, graph)
    expect(ids.length).toBe(2)
    // IDs should be patched back into builder output
    expect(builder.new_claims_proposed[0].id).toBe(ids[0])
    expect(builder.new_claims_proposed[1].id).toBe(ids[1])
    // Claims should be in graph
    expect(graph.getClaim(ids[0])!.statement).toBe(
      'New hypothesis from builder',
    )
    expect(graph.getClaim(ids[0])!.phase).toBe('proposed')
    expect(graph.getClaim(ids[1])!.statement).toBe('Observed result A > B')
  })

  test('addBuilderClaimsToGraph adds edges between existing claims', () => {
    const orch = makeOrchestrator(tmpDir) as any
    const graph = new ClaimGraph()
    const id1 = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'explanation',
      statement: 'Claim A',
      phase: 'proposed',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.5,
        evidenceType: 'heuristic_motivation',
        vulnerabilityScore: 0.5,
      },
      created_by: 'test',
    })
    const id2 = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'explanation',
      statement: 'Claim B',
      phase: 'proposed',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.5,
        evidenceType: 'heuristic_motivation',
        vulnerabilityScore: 0.5,
      },
      created_by: 'test',
    })

    const builder: BuilderOutput = {
      narrative: 'linking claims',
      new_claims_proposed: [],
      new_edges_proposed: [
        {
          source_id: id1,
          target_id: id2,
          relation: 'supports',
          strength: 'moderate',
        },
      ],
      recommended_next_actions: [],
    }

    orch.addBuilderClaimsToGraph(builder, graph)
    const stats = graph.getStatistics()
    expect(stats.supports).toBe(1)
  })

  // ── registerEvidence ──────────────────────────────────

  test('registerEvidence adds grounded + derived to pool', () => {
    const orch = makeOrchestrator(tmpDir) as any
    const pool = new EvidencePoolManager({ grounded: [], derived: [] })

    const result: ExecutionResult = {
      success: true,
      agent: 'experiment-runner',
      summary: 'Ran experiment',
      artifacts_produced: [],
      new_claims: [],
      new_evidence: [
        { claim_statement: 'X > Y', kind: 'grounded', source_ref: 'exp1' },
        {
          claim_statement: 'Derived Z',
          kind: 'derived',
          method: 'computation',
        },
      ],
      cost_usd: 1.0,
    }

    orch.registerEvidence(result, pool)
    expect(pool.pool.grounded.length).toBe(1)
    expect(pool.pool.derived.length).toBe(1)
    expect(pool.pool.grounded[0].claim).toBe('X > Y')
    expect(pool.pool.derived[0].claim).toBe('Derived Z')
  })

  // ── summarizeSkepticForTrajectory ─────────────────────

  test('summarizeSkepticForTrajectory returns concise summary', () => {
    const orch = makeOrchestrator(tmpDir) as any

    const skeptic: SkepticOutput = {
      internal_inconsistencies: [{ description: 'x', claim_ids: [] }],
      bridge_gaps: [
        {
          from_claim: 'a',
          to_claim: 'b',
          severity: 'high',
          description: 'gap',
        },
      ],
      evidence_inflation: [],
      theorem_overreach: [],
      top3_collapse_points: [
        {
          claim_id: 'c1',
          vulnerability: 0.8,
          cascade_size: 3,
          falsification_experiment: 'test',
        },
      ],
      admission_denials: [],
    }

    const summary = orch.summarizeSkepticForTrajectory(skeptic)
    expect(summary).toContain('1 inconsistencies')
    expect(summary).toContain('1 bridge gaps')
    expect(summary).toContain('1 collapse points')
  })

  test('summarizeSkepticForTrajectory handles empty skeptic', () => {
    const orch = makeOrchestrator(tmpDir) as any

    const skeptic: SkepticOutput = {
      internal_inconsistencies: [],
      bridge_gaps: [],
      evidence_inflation: [],
      theorem_overreach: [],
      top3_collapse_points: [],
      admission_denials: [],
    }

    const summary = orch.summarizeSkepticForTrajectory(skeptic)
    expect(summary).toBe('no challenges')
  })

  // ── digest no longer modifies claims ──────────────────

  test('digest no longer modifies claims (only literature/theory)', async () => {
    const orch = makeOrchestrator(tmpDir) as any
    const stateBefore = orch.getState() as ResearchState
    const claimCountBefore = stateBefore.claimGraph.claims.length

    const result: ExecutionResult = {
      success: true,
      agent: 'investigator',
      summary: 'Found papers',
      artifacts_produced: [],
      new_claims: [
        { statement: 'Should not be added by digest', confidence: 0.5 },
      ],
      new_evidence: [
        { claim_statement: 'Should not be added by digest', kind: 'grounded' },
      ],
      cost_usd: 1.0,
    }

    const newState = await orch.digest(result)
    // Claims should NOT be added by digest — that's the run loop's job
    expect(newState.claimGraph.claims.length).toBe(claimCountBefore)
    // Evidence should NOT be added by digest
    expect(newState.evidencePool.grounded.length).toBe(0)
    // Spending should be recorded
    expect(newState.budget.spent_usd).toBeGreaterThan(
      stateBefore.budget.spent_usd,
    )
  })
})
