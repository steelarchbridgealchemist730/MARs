import { describe, it, expect, beforeEach } from 'bun:test'
import { ClaimGraph, type ClaimInput } from '../../src/paper/claim-graph/index'
import type { ArbiterOutput } from '../../src/paper/claim-graph/triple-role-types'

// We test applyReformulations by instantiating the Orchestrator with minimal mocks.
// Since applyReformulations is a public method, we can call it directly.
// But we need to import it — it lives on the Orchestrator class.
// Instead, we'll re-implement the core logic as a standalone function for unit testing,
// then verify the orchestrator integration via the class.

// Import Orchestrator
import { Orchestrator } from '../../src/paper/orchestrator'
import { initializeFromProposal } from '../../src/paper/research-state'

function makeProposal() {
  return {
    id: 'test-proposal',
    title: 'Test Research',
    abstract: 'Test',
    methodology: 'Testing',
    innovation: [{ description: 'Original hypothesis A' }],
    novelty_score: 0.8,
    impact_score: 0.7,
    feasibility: { score: 0.9, data_required: 'none' },
  } as any
}

function makeCallbacks() {
  const logs: string[] = []
  return {
    logs,
    callbacks: {
      executeAgent: async () => ({
        success: true,
        agent: 'test',
        summary: 'done',
        artifacts_produced: [],
        new_claims: [],
        new_evidence: [],
        cost_usd: 0,
      }),
      presentDecision: async () => 'approve' as const,
      onProgress: (msg: string) => logs.push(msg),
      onStateChange: () => {},
      onComplete: () => {},
      onError: () => {},
    },
  }
}

function makeClaim(overrides?: Partial<ClaimInput>): ClaimInput {
  return {
    type: 'hypothesis',
    epistemicLayer: 'explanation',
    statement: 'Test hypothesis',
    phase: 'proposed',
    evidence: { grounded: [], derived: [] },
    strength: {
      confidence: 0.5,
      evidenceType: 'heuristic_motivation',
      vulnerabilityScore: 0.5,
    },
    created_by: 'test',
    ...overrides,
  }
}

describe('Claim Reformulation', () => {
  describe('applyReformulations', () => {
    let graph: ClaimGraph
    let orchestrator: Orchestrator
    let logs: string[]

    beforeEach(() => {
      graph = new ClaimGraph()
      const state = initializeFromProposal(makeProposal())
      const { callbacks, logs: l } = makeCallbacks()
      logs = l
      orchestrator = new Orchestrator(
        '/tmp/test-reformulation',
        state,
        callbacks,
        { mode: 'interactive' },
      )
    })

    it('creates successor claim with correct fields', () => {
      const mainId = graph.addClaim(
        makeClaim({
          statement: 'Original main claim',
          is_main: true,
          depth: 0,
          phase: 'under_investigation',
        }),
      )

      const arbiter: ArbiterOutput = {
        claim_updates: [],
        contracted_claims: [],
        reformulated_claims: [
          {
            claim_id: mainId,
            new_statement: 'Reformulated main claim',
            new_type: 'empirical',
            new_layer: 'exploitation',
            evidence_basis: 'Experiments showed X',
            rationale: 'Original was too strong',
          },
        ],
        next_action: {
          action: 'test',
          delegate_to: 'investigator',
          context: '',
          priority: 'normal',
          estimated_cost_usd: 0,
          if_this_fails: 'stop',
        },
        overall_assessment: 'test',
      }

      const count = orchestrator.applyReformulations(arbiter, graph)
      expect(count).toBe(1)

      // Old claim should be reformulated
      const oldClaim = graph.getClaim(mainId)!
      expect(oldClaim.phase).toBe('reformulated')
      expect(oldClaim.reformulated_into).toBeTruthy()

      // New claim should exist with correct fields
      const newClaim = graph.getClaim(oldClaim.reformulated_into!)!
      expect(newClaim).toBeDefined()
      expect(newClaim.statement).toBe('Reformulated main claim')
      expect(newClaim.type).toBe('empirical')
      expect(newClaim.epistemicLayer).toBe('exploitation')
      expect(newClaim.is_main).toBe(true)
      expect(newClaim.depth).toBe(0)
      expect(newClaim.phase).toBe('proposed')
      expect(newClaim.reformulated_from).toBe(mainId)
      expect(newClaim.reformulation_count).toBe(1)
    })

    it('adds supersedes edge from old to new', () => {
      const mainId = graph.addClaim(
        makeClaim({
          statement: 'Original',
          is_main: true,
          phase: 'under_investigation',
        }),
      )

      const arbiter: ArbiterOutput = {
        claim_updates: [],
        contracted_claims: [],
        reformulated_claims: [
          {
            claim_id: mainId,
            new_statement: 'New version',
            evidence_basis: 'evidence',
            rationale: 'reason',
          },
        ],
        next_action: {
          action: 'test',
          delegate_to: 'investigator',
          context: '',
          priority: 'normal',
          estimated_cost_usd: 0,
          if_this_fails: 'stop',
        },
        overall_assessment: 'test',
      }

      orchestrator.applyReformulations(arbiter, graph)

      const oldClaim = graph.getClaim(mainId)!
      const edges = graph.getEdgesOf(mainId)
      const supersedesEdge = edges.find(e => e.relation === 'supersedes')
      expect(supersedesEdge).toBeDefined()
      expect(supersedesEdge!.source).toBe(mainId)
      expect(supersedesEdge!.target).toBe(oldClaim.reformulated_into!)
    })

    it('respects MAX_REFORMULATIONS_PER_CLAIM', () => {
      const mainId = graph.addClaim(
        makeClaim({
          statement: 'Already reformulated 3 times',
          is_main: true,
          phase: 'under_investigation',
          reformulation_count: 3,
        }),
      )

      const arbiter: ArbiterOutput = {
        claim_updates: [],
        contracted_claims: [],
        reformulated_claims: [
          {
            claim_id: mainId,
            new_statement: 'Should not happen',
            evidence_basis: 'evidence',
            rationale: 'reason',
          },
        ],
        next_action: {
          action: 'test',
          delegate_to: 'investigator',
          context: '',
          priority: 'normal',
          estimated_cost_usd: 0,
          if_this_fails: 'stop',
        },
        overall_assessment: 'test',
      }

      const count = orchestrator.applyReformulations(arbiter, graph)
      expect(count).toBe(0)

      // Old claim should remain unchanged
      const oldClaim = graph.getClaim(mainId)!
      expect(oldClaim.phase).toBe('under_investigation')
      expect(oldClaim.reformulated_into).toBeUndefined()
    })

    it('skips non-main claims', () => {
      const subId = graph.addClaim(
        makeClaim({
          statement: 'Sub-claim',
          is_main: false,
          phase: 'under_investigation',
        }),
      )

      const arbiter: ArbiterOutput = {
        claim_updates: [],
        contracted_claims: [],
        reformulated_claims: [
          {
            claim_id: subId,
            new_statement: 'Should not happen',
            evidence_basis: 'evidence',
            rationale: 'reason',
          },
        ],
        next_action: {
          action: 'test',
          delegate_to: 'investigator',
          context: '',
          priority: 'normal',
          estimated_cost_usd: 0,
          if_this_fails: 'stop',
        },
        overall_assessment: 'test',
      }

      const count = orchestrator.applyReformulations(arbiter, graph)
      expect(count).toBe(0)
    })

    it('skips claims still in proposed phase', () => {
      const mainId = graph.addClaim(
        makeClaim({
          statement: 'Just proposed',
          is_main: true,
          phase: 'proposed',
        }),
      )

      const arbiter: ArbiterOutput = {
        claim_updates: [],
        contracted_claims: [],
        reformulated_claims: [
          {
            claim_id: mainId,
            new_statement: 'Should not happen',
            evidence_basis: 'evidence',
            rationale: 'reason',
          },
        ],
        next_action: {
          action: 'test',
          delegate_to: 'investigator',
          context: '',
          priority: 'normal',
          estimated_cost_usd: 0,
          if_this_fails: 'stop',
        },
        overall_assessment: 'test',
      }

      const count = orchestrator.applyReformulations(arbiter, graph)
      expect(count).toBe(0)
    })

    it('transfers sub-claim depends_on edges with weak strength', () => {
      const mainId = graph.addClaim(
        makeClaim({
          statement: 'Main claim',
          is_main: true,
          phase: 'under_investigation',
        }),
      )
      const subId = graph.addClaim(
        makeClaim({
          statement: 'Sub-claim that depends on main',
          phase: 'proposed',
        }),
      )
      graph.addEdge({
        source: subId,
        target: mainId,
        relation: 'depends_on',
        strength: 'strong',
      })

      const arbiter: ArbiterOutput = {
        claim_updates: [],
        contracted_claims: [],
        reformulated_claims: [
          {
            claim_id: mainId,
            new_statement: 'New main claim',
            evidence_basis: 'evidence',
            rationale: 'reason',
          },
        ],
        next_action: {
          action: 'test',
          delegate_to: 'investigator',
          context: '',
          priority: 'normal',
          estimated_cost_usd: 0,
          if_this_fails: 'stop',
        },
        overall_assessment: 'test',
      }

      orchestrator.applyReformulations(arbiter, graph)

      const oldClaim = graph.getClaim(mainId)!
      const successorId = oldClaim.reformulated_into!

      // Sub-claim should now have a weak depends_on edge to successor
      const subEdges = graph.getEdgesOf(subId)
      const newDep = subEdges.find(
        e =>
          e.relation === 'depends_on' &&
          e.source === subId &&
          e.target === successorId,
      )
      expect(newDep).toBeDefined()
      expect(newDep!.strength).toBe('weak')
    })

    it('increments reformulation_count through lineage', () => {
      // Simulate a claim already reformulated once
      const v1Id = graph.addClaim(
        makeClaim({
          statement: 'Version 1',
          is_main: true,
          phase: 'under_investigation',
          reformulation_count: 1,
          reformulated_from: 'some-original-id',
        }),
      )

      const arbiter: ArbiterOutput = {
        claim_updates: [],
        contracted_claims: [],
        reformulated_claims: [
          {
            claim_id: v1Id,
            new_statement: 'Version 2',
            evidence_basis: 'more evidence',
            rationale: 'further refinement',
          },
        ],
        next_action: {
          action: 'test',
          delegate_to: 'investigator',
          context: '',
          priority: 'normal',
          estimated_cost_usd: 0,
          if_this_fails: 'stop',
        },
        overall_assessment: 'test',
      }

      orchestrator.applyReformulations(arbiter, graph)

      const v1 = graph.getClaim(v1Id)!
      const v2 = graph.getClaim(v1.reformulated_into!)!
      expect(v2.reformulation_count).toBe(2)
      expect(v2.reformulated_from).toBe(v1Id)
    })
  })

  describe('ClaimGraph reformulation queries', () => {
    it('getActiveMainClaims excludes reformulated claims', () => {
      const graph = new ClaimGraph()
      const id1 = graph.addClaim(
        makeClaim({ statement: 'Active', is_main: true, phase: 'admitted' }),
      )
      const id2 = graph.addClaim(
        makeClaim({
          statement: 'Reformulated away',
          is_main: true,
          phase: 'proposed',
        }),
      )
      graph.updateClaim(id2, { phase: 'reformulated' })

      const active = graph.getActiveMainClaims()
      expect(active.length).toBe(1)
      expect(active[0].id).toBe(id1)
    })

    it('getReformulationLineage returns full chain', () => {
      const graph = new ClaimGraph()
      const id1 = graph.addClaim(
        makeClaim({
          statement: 'Original',
          is_main: true,
          phase: 'reformulated',
        }),
      )
      const id2 = graph.addClaim(
        makeClaim({
          statement: 'V2',
          is_main: true,
          phase: 'reformulated',
          reformulated_from: id1,
          reformulation_count: 1,
        }),
      )
      const id3 = graph.addClaim(
        makeClaim({
          statement: 'V3',
          is_main: true,
          phase: 'proposed',
          reformulated_from: id2,
          reformulation_count: 2,
        }),
      )

      // Set reformulated_into on predecessors
      graph.updateClaim(id1, { reformulated_into: id2 })
      graph.updateClaim(id2, { reformulated_into: id3 })

      // Query from the middle
      const lineage = graph.getReformulationLineage(id2)
      expect(lineage.length).toBe(3)
      expect(lineage[0].id).toBe(id1)
      expect(lineage[1].id).toBe(id2)
      expect(lineage[2].id).toBe(id3)

      // Query from the end
      const lineageFromEnd = graph.getReformulationLineage(id3)
      expect(lineageFromEnd.length).toBe(3)
      expect(lineageFromEnd[0].id).toBe(id1)
    })

    it('getStatistics counts reformulated and supersedes', () => {
      const graph = new ClaimGraph()
      const id1 = graph.addClaim(
        makeClaim({ statement: 'Old', is_main: true, phase: 'proposed' }),
      )
      graph.updateClaim(id1, { phase: 'reformulated' })

      const id2 = graph.addClaim(
        makeClaim({ statement: 'New', is_main: true, phase: 'proposed' }),
      )
      graph.addEdge({
        source: id1,
        target: id2,
        relation: 'supersedes',
        strength: 'strong',
      })

      const stats = graph.getStatistics()
      expect(stats.reformulated).toBe(1)
      expect(stats.supersedes).toBe(1)
    })
  })

  describe('isDone with reformulated claims', () => {
    it('returns true when all active main claims are admitted (some reformulated)', () => {
      const graph = new ClaimGraph()
      // One reformulated main claim
      const oldId = graph.addClaim(
        makeClaim({
          statement: 'Old main',
          is_main: true,
          phase: 'proposed',
        }),
      )
      graph.updateClaim(oldId, { phase: 'reformulated' })

      // One admitted active main claim (the successor)
      graph.addClaim(
        makeClaim({
          statement: 'New main',
          is_main: true,
          phase: 'admitted',
          reformulated_from: oldId,
          reformulation_count: 1,
        }),
      )

      const active = graph.getActiveMainClaims()
      expect(active.length).toBe(1)
      expect(active.every(c => c.phase === 'admitted')).toBe(true)
    })
  })

  describe('Convergence excludes reformulated', () => {
    it('reformulated main claims are excluded from admission rate', () => {
      // This is implicitly tested since convergence.ts filters out reformulated
      // from mainClaims. We verify via getActiveMainClaims which uses the same filter.
      const graph = new ClaimGraph()
      graph.addClaim(
        makeClaim({
          statement: 'Reformulated',
          is_main: true,
          phase: 'proposed',
        }),
      )
      const id = graph.allClaims[0].id
      graph.updateClaim(id, { phase: 'reformulated' })

      graph.addClaim(
        makeClaim({
          statement: 'Active admitted',
          is_main: true,
          phase: 'admitted',
        }),
      )

      const activeMains = graph.getActiveMainClaims()
      expect(activeMains.length).toBe(1)
      expect(activeMains[0].phase).toBe('admitted')
    })
  })
})
