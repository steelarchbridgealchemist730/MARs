import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  Orchestrator,
  type OrchestratorCallbacks,
  type OrchestratorDecision,
  type ExecutionResult,
} from '../../src/paper/orchestrator'
import {
  initializeFromProposal,
  type ResearchState,
} from '../../src/paper/research-state'
import { ClaimGraph, type ClaimInput } from '../../src/paper/claim-graph/index'
import { estimateTokens } from '../../src/paper/claim-graph/token-utils'
import type { ArbiterOutput } from '../../src/paper/claim-graph/triple-role-types'

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

function addClaim(
  graph: ClaimGraph,
  statement: string,
  opts?: {
    type?: string
    phase?: string
    layer?: string
    id?: string
  },
): string {
  return graph.addClaim({
    type: (opts?.type as any) ?? 'hypothesis',
    epistemicLayer: (opts?.layer as any) ?? 'explanation',
    statement,
    phase: (opts?.phase as any) ?? 'proposed',
    confidence: 0.7,
    evidence: { grounded: [], derived: [] },
  } as ClaimInput)
}

/** Access the private buildSubAgentContext method. */
function callBuildSubAgentContext(
  orch: Orchestrator,
  agentType: string,
  action: OrchestratorDecision['action'],
): string {
  return (orch as any).buildSubAgentContext(agentType, action)
}

describe('SubAgent Context Trimming', () => {
  let tmpDir: string
  let orch: Orchestrator

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'subagent-ctx-'))
    orch = makeOrchestrator(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('math-reasoner', () => {
    test('target claim + assumptions + lemmas present, unrelated excluded', () => {
      const state = orch.getState()
      const graph = ClaimGraph.fromJSON(state.claimGraph)

      // Target theorem
      const theoremId = addClaim(graph, 'CLT holds under mixing conditions', {
        type: 'theorem',
        phase: 'proposed',
      })

      // Two assumption dependencies
      const asm1Id = addClaim(graph, 'Stationarity assumption', {
        type: 'assumption',
        phase: 'admitted',
      })
      const asm2Id = addClaim(graph, 'Finite variance assumption', {
        type: 'assumption',
        phase: 'admitted',
      })
      graph.addEdge({
        source: theoremId,
        target: asm1Id,
        relation: 'depends_on',
        strength: 'strong',
      })
      graph.addEdge({
        source: theoremId,
        target: asm2Id,
        relation: 'depends_on',
        strength: 'strong',
      })

      // One admitted lemma
      const lemmaId = addClaim(graph, 'Mixing rate decay lemma', {
        type: 'theorem',
        phase: 'admitted',
      })

      // Three unrelated claims
      const unrel1 = addClaim(graph, 'Data preprocessing pipeline works', {
        type: 'hypothesis',
        phase: 'proposed',
      })
      const unrel2 = addClaim(graph, 'GPU cluster available', {
        type: 'assumption',
        phase: 'proposed',
      })
      const unrel3 = addClaim(graph, 'Related work is sparse', {
        type: 'hypothesis',
        phase: 'proposed',
      })

      // Serialize graph back to state
      state.claimGraph = graph.toJSON()

      const result = callBuildSubAgentContext(orch, 'math-reasoner', {
        type: 'Prove CLT under mixing conditions',
        delegate_to: 'math-reasoner',
        context: 'Original context',
        model_preference: 'default',
        estimated_cost_usd: 1,
        priority: 'normal',
        if_this_fails: 'skip',
        targets_claim: theoremId,
      })

      // Should contain theorem statement
      expect(result).toContain('CLT holds under mixing conditions')
      // Should contain assumptions
      expect(result).toContain('Stationarity assumption')
      expect(result).toContain('Finite variance assumption')
      // Should contain lemma
      expect(result).toContain('Mixing rate decay lemma')
      // Should NOT contain unrelated claims
      expect(result).not.toContain('Data preprocessing pipeline works')
      expect(result).not.toContain('GPU cluster available')
      expect(result).not.toContain('Related work is sparse')
    })

    test('fallback when targets_claim is missing', () => {
      const result = callBuildSubAgentContext(orch, 'math-reasoner', {
        type: 'Prove convergence theorem',
        delegate_to: 'math-reasoner',
        context: 'Original context',
        model_preference: 'default',
        estimated_cost_usd: 1,
        priority: 'normal',
        if_this_fails: 'skip',
        // No targets_claim
      })

      expect(result).toContain('## Task: Prove convergence theorem')
      // Should not crash
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('experiment-runner', () => {
    test('target claim + data summary', () => {
      const state = orch.getState()
      const graph = ClaimGraph.fromJSON(state.claimGraph)

      const claimId = addClaim(graph, 'Method achieves 95% accuracy on MNIST', {
        type: 'hypothesis',
        phase: 'proposed',
      })
      state.claimGraph = graph.toJSON()

      const result = callBuildSubAgentContext(orch, 'experiment-runner', {
        type: 'Run MNIST benchmark with augmentation',
        delegate_to: 'experiment-runner',
        context: 'Original context',
        model_preference: 'default',
        estimated_cost_usd: 2,
        priority: 'high',
        if_this_fails: 'fallback',
        targets_claim: claimId,
      })

      expect(result).toContain(
        '## Verify: Method achieves 95% accuracy on MNIST',
      )
      expect(result).toContain('## Design:')
      expect(result).toContain('## Data:')
    })
  })

  describe('investigator', () => {
    test('literature knowledge summary', () => {
      const state = orch.getState()
      state.literature_awareness.known_results = [
        {
          statement: 'Mixing CLTs require sub-exponential decay',
          source: 'Bradley (1986)',
          confidence: 0.9,
          implications_for_us: 'supports our approach',
        } as any,
      ]
      state.literature_awareness.confirmed_gaps = [
        {
          description: 'No CLT for heavy-tailed mixing processes',
          last_checked: '2026-01-01',
          checked_sources: ['arXiv', 'S2'],
        } as any,
      ]
      state.literature_awareness.deeply_read = [
        {
          paper_id: 'bradley1986',
          relevance_to_us: 'foundational',
          key_takeaways: ['mixing rates matter'],
          potential_conflicts: [],
        } as any,
      ]
      state.literature_awareness.aware_but_unread = [
        { paper_id: 'rio2017' } as any,
      ]

      const result = callBuildSubAgentContext(orch, 'investigator', {
        type: 'Find recent mixing CLT results',
        delegate_to: 'investigator',
        context: 'Original context',
        model_preference: 'default',
        estimated_cost_usd: 0.5,
        priority: 'normal',
        if_this_fails: 'skip',
      })

      expect(result).toContain('## Question: Find recent mixing CLT results')
      expect(result).toContain('Mixing CLTs require sub-exponential decay')
      expect(result).toContain('Bradley (1986)')
      expect(result).toContain('No CLT for heavy-tailed mixing processes')
      expect(result).toContain('1 papers deeply read, 1 more aware of')
    })
  })

  describe('fragment-writer', () => {
    test('only admitted related claims included', () => {
      const state = orch.getState()
      const graph = ClaimGraph.fromJSON(state.claimGraph)

      // 3 admitted claims
      const adm1 = addClaim(graph, 'Admitted claim alpha', {
        type: 'theorem',
        phase: 'admitted',
      })
      const adm2 = addClaim(graph, 'Admitted claim beta', {
        type: 'hypothesis',
        phase: 'admitted',
      })
      const adm3 = addClaim(graph, 'Admitted claim gamma', {
        type: 'assumption',
        phase: 'admitted',
      })

      // 2 proposed claims
      const prop1 = addClaim(graph, 'Proposed claim delta', {
        type: 'hypothesis',
        phase: 'proposed',
      })
      const prop2 = addClaim(graph, 'Proposed claim epsilon', {
        type: 'hypothesis',
        phase: 'proposed',
      })

      state.claimGraph = graph.toJSON()

      const result = callBuildSubAgentContext(orch, 'fragment-writer', {
        type: 'Write related work section',
        delegate_to: 'fragment-writer',
        context: 'Original context',
        model_preference: 'default',
        estimated_cost_usd: 0.3,
        priority: 'normal',
        if_this_fails: 'skip',
        related_claims: [adm1, adm2, adm3, prop1, prop2],
      })

      expect(result).toContain('## Write: Write related work section')
      // Only admitted claims
      expect(result).toContain('Admitted claim alpha')
      expect(result).toContain('Admitted claim beta')
      expect(result).toContain('Admitted claim gamma')
      // Proposed claims excluded
      expect(result).not.toContain('Proposed claim delta')
      expect(result).not.toContain('Proposed claim epsilon')
    })
  })

  describe('default agent', () => {
    test('unknown agent gets Task heading with action context', () => {
      const result = callBuildSubAgentContext(orch, 'paper-assembler', {
        type: 'Assemble final paper',
        delegate_to: 'paper-assembler',
        context: 'Use all fragments from the store.',
        model_preference: 'default',
        estimated_cost_usd: 1,
        priority: 'normal',
        if_this_fails: 'skip',
      })

      expect(result).toContain('## Task: Assemble final paper')
      expect(result).toContain('Use all fragments from the store.')
    })
  })

  describe('token limits', () => {
    test('each agent type produces output under 3K tokens', () => {
      const state = orch.getState()
      const graph = ClaimGraph.fromJSON(state.claimGraph)

      // Create a large graph: 30+ claims with many lemmas
      const claimIds: string[] = []
      for (let i = 0; i < 35; i++) {
        const id = addClaim(
          graph,
          `Claim statement number ${i} with a reasonably long description that simulates real research content about statistical theory`,
          {
            type:
              i % 3 === 0
                ? 'theorem'
                : i % 3 === 1
                  ? 'assumption'
                  : 'hypothesis',
            phase: i % 2 === 0 ? 'admitted' : 'proposed',
          },
        )
        claimIds.push(id)
      }

      // Add many dependency edges
      for (let i = 1; i < claimIds.length; i++) {
        graph.addEdge({
          source: claimIds[0],
          target: claimIds[i],
          relation: 'depends_on',
          strength: 'strong',
        })
      }

      state.claimGraph = graph.toJSON()

      // Add experiment artifacts
      for (let i = 0; i < 20; i++) {
        state.artifacts.entries.push({
          id: `exp-${i}`,
          type: 'experiment_result',
          path: `/tmp/exp-${i}.json`,
          created_by: 'experiment-runner',
          created_at: new Date().toISOString(),
          description: `Experiment ${i}: tested convergence rate with parameter set ${i} yielding accuracy of ${90 + i}%`,
        })
      }

      // Add literature
      for (let i = 0; i < 20; i++) {
        state.literature_awareness.known_results.push({
          statement: `Known result ${i} about mixing condition convergence rates in high dimensions`,
          source: `Author${i} (2025)`,
          confidence: 0.8,
          implications_for_us: 'relevant',
        } as any)
      }

      const agentTypes = [
        'math-reasoner',
        'experiment-runner',
        'investigator',
        'fragment-writer',
        'paper-assembler',
      ]

      for (const agent of agentTypes) {
        const result = callBuildSubAgentContext(orch, agent, {
          type: 'Large context test task',
          delegate_to: agent,
          context: 'Some original context that should be trimmed',
          model_preference: 'default',
          estimated_cost_usd: 1,
          priority: 'normal',
          if_this_fails: 'skip',
          targets_claim: claimIds[0],
          related_claims: claimIds,
        })

        const tokens = estimateTokens(result)
        expect(tokens).toBeLessThanOrEqual(3000)
      }
    })
  })

  describe('arbiterToDecision', () => {
    test('passes through targets_claim and related_claims', () => {
      const arbiterOutput: ArbiterOutput = {
        claim_updates: [],
        contracted_claims: [],
        next_action: {
          action: 'Prove main theorem',
          delegate_to: 'math-reasoner',
          context: 'Focus on the CLT proof',
          priority: 'high',
          estimated_cost_usd: 2.5,
          if_this_fails: 'Try simpler approach',
          targets_claim: 'claim-123',
          related_claims: ['claim-456', 'claim-789'],
        },
        overall_assessment: 'Good progress',
      }

      const decision = (orch as any).arbiterToDecision(arbiterOutput)

      expect(decision.action.targets_claim).toBe('claim-123')
      expect(decision.action.related_claims).toEqual(['claim-456', 'claim-789'])
      expect(decision.action.type).toBe('Prove main theorem')
      expect(decision.action.delegate_to).toBe('math-reasoner')
    })
  })

  describe('no unrelated claims leak', () => {
    test('math-reasoner only sees target + deps, not other claims', () => {
      const state = orch.getState()
      const graph = ClaimGraph.fromJSON(state.claimGraph)

      // Target theorem
      const targetId = addClaim(graph, 'Main theorem on ergodicity', {
        type: 'theorem',
        phase: 'proposed',
      })

      // 2 dependencies
      const dep1 = addClaim(graph, 'Markov property holds', {
        type: 'assumption',
        phase: 'admitted',
      })
      const dep2 = addClaim(graph, 'State space is compact', {
        type: 'assumption',
        phase: 'admitted',
      })
      graph.addEdge({
        source: targetId,
        target: dep1,
        relation: 'depends_on',
        strength: 'strong',
      })
      graph.addEdge({
        source: targetId,
        target: dep2,
        relation: 'depends_on',
        strength: 'strong',
      })

      // 7 unrelated claims
      const unrelatedStatements = [
        'Dataset contains 10K samples',
        'Baseline accuracy is 85%',
        'Training converges in 50 epochs',
        'GPU memory is sufficient',
        'Related work covers 15 papers',
        'Figure 3 shows convergence plot',
        'Table 2 summarizes results',
      ]
      for (const stmt of unrelatedStatements) {
        addClaim(graph, stmt, { type: 'hypothesis', phase: 'proposed' })
      }

      state.claimGraph = graph.toJSON()

      const result = callBuildSubAgentContext(orch, 'math-reasoner', {
        type: 'Prove ergodicity',
        delegate_to: 'math-reasoner',
        context: 'Original',
        model_preference: 'default',
        estimated_cost_usd: 1,
        priority: 'normal',
        if_this_fails: 'skip',
        targets_claim: targetId,
      })

      // Should contain target and deps
      expect(result).toContain('Main theorem on ergodicity')
      expect(result).toContain('Markov property holds')
      expect(result).toContain('State space is compact')

      // None of the 7 unrelated claims should appear
      for (const stmt of unrelatedStatements) {
        expect(result).not.toContain(stmt)
      }
    })
  })
})
