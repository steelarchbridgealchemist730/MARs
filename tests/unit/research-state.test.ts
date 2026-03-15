import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import {
  initializeFromProposal,
  addTrajectoryEntry,
  recordSpending,
  addArtifact,
  isBudgetLow,
  saveResearchState,
  loadResearchState,
  buildStateContext,
  serializeState,
  deserializeState,
  computeBasicStability,
  createEmptyStability,
  getClaimsByPhase,
  getUnresolvedClaims,
  getAdmittedClaims,
  generateFallbackClaims,
  type ResearchState,
} from '../../src/paper/research-state'
import { ClaimGraph } from '../../src/paper/claim-graph/index'
import { EvidencePoolManager } from '../../src/paper/evidence-pool'
import type { Proposal } from '../../src/paper/proposal/types'

const TEST_DIR = join(process.cwd(), '.test-research-state')

const MOCK_PROPOSAL: Proposal = {
  id: 'test-proposal-1',
  title: 'Neural Rough Volatility via Jump-Diffusion',
  abstract: 'We propose a novel approach...',
  innovation: [
    'Novel jump-diffusion model for rough volatility',
    'Efficient neural network estimator',
  ],
  methodology: 'Combine rough vol models with neural networks',
  feasibility: {
    data_required: 'High-frequency equity data',
    compute_estimate: '4 GPU-hours',
    timeline_weeks: 2,
    score: 0.8,
  },
  risk: {
    level: 'medium',
    description: 'Data quality may be insufficient',
  },
  novelty_score: 0.7,
  impact_score: 0.6,
  references: ['gatheral2018', 'bayer2016'],
  created_at: '2026-03-08T00:00:00Z',
}

describe('ResearchState', () => {
  let state: ResearchState

  beforeEach(() => {
    state = initializeFromProposal(MOCK_PROPOSAL, {
      budget_usd: 50,
      paper_type: 'mixed',
    })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true })
    }
  })

  describe('initializeFromProposal', () => {
    it('creates state with correct proposal', () => {
      expect(state.proposal.title).toBe(MOCK_PROPOSAL.title)
      expect(state.paper_type).toBe('mixed')
      expect(state.initialized).toBe(true)
      expect(state.orchestrator_cycle_count).toBe(0)
    })

    it('creates ClaimGraph with initial claims', () => {
      // 1 methodology assumption + 2 innovation hypotheses + 1 risk limitation = 4
      expect(state.claimGraph.claims.length).toBe(4)
      // All should start as proposed
      expect(state.claimGraph.claims.every(c => c.phase === 'proposed')).toBe(
        true,
      )
    })

    it('creates empty EvidencePool', () => {
      expect(state.evidencePool.grounded.length).toBe(0)
      expect(state.evidencePool.derived.length).toBe(0)
    })

    it('creates empty StabilityMetrics', () => {
      expect(state.stability.convergenceScore).toBe(0)
      expect(state.stability.admittedClaimCount).toBe(0)
      expect(state.stability.paperReadiness).toBe('not_ready')
    })

    it('proposal innovations become hypothesis claims', () => {
      const hypotheses = state.claimGraph.claims.filter(
        c => c.type === 'hypothesis',
      )
      expect(hypotheses.length).toBe(2)
      expect(
        hypotheses.some(h => h.statement.includes('jump-diffusion model')),
      ).toBe(true)
      expect(
        hypotheses.some(h => h.statement.includes('neural network estimator')),
      ).toBe(true)
    })

    it('proposal risk becomes limitation claim', () => {
      const limitations = state.claimGraph.claims.filter(
        c => c.type === 'limitation',
      )
      expect(limitations.length).toBe(1)
      expect(limitations[0].statement).toBe('Data quality may be insufficient')
    })

    it('proposal methodology becomes assumption claim', () => {
      const assumptions = state.claimGraph.claims.filter(
        c => c.type === 'assumption',
      )
      expect(assumptions.length).toBe(1)
      expect(assumptions[0].statement).toContain(
        'Combine rough vol models with neural networks',
      )
    })

    it('initializes budget correctly', () => {
      expect(state.budget.total_usd).toBe(50)
      expect(state.budget.spent_usd).toBe(0)
      expect(state.budget.remaining_usd).toBe(50)
    })

    it('initializes empty literature awareness', () => {
      expect(state.literature_awareness.deeply_read).toEqual([])
      expect(state.literature_awareness.known_results).toEqual([])
      expect(state.literature_awareness.confirmed_gaps).toEqual([])
    })
  })

  describe('generateFallbackClaims', () => {
    it('creates claims from proposal', () => {
      const claims = generateFallbackClaims(MOCK_PROPOSAL)
      expect(claims.length).toBe(4)
      expect(claims[0].type).toBe('assumption')
      expect(claims[1].type).toBe('hypothesis')
      expect(claims[2].type).toBe('hypothesis')
      expect(claims[3].type).toBe('limitation')
    })

    it('handles proposal without risk', () => {
      const noRiskProposal = { ...MOCK_PROPOSAL, risk: undefined }
      const claims = generateFallbackClaims(noRiskProposal)
      expect(claims.length).toBe(3) // no limitation claim
    })
  })

  describe('computeBasicStability', () => {
    it('returns low convergence for all proposed', () => {
      const graph = ClaimGraph.fromJSON(state.claimGraph)
      const pool = new EvidencePoolManager(state.evidencePool)
      const stability = computeBasicStability(graph, pool)
      expect(stability.paperReadiness).toBe('not_ready')
      expect(stability.proposedClaimCount).toBeGreaterThan(0)
    })

    it('returns higher convergence when claims admitted', () => {
      const graph = ClaimGraph.fromJSON(state.claimGraph)
      // Admit all claims
      for (const claim of graph.allClaims) {
        graph.updateClaim(claim.id, { phase: 'admitted' })
      }
      const pool = new EvidencePoolManager(state.evidencePool)
      const stability = computeBasicStability(graph, pool)
      expect(stability.convergenceScore).toBeGreaterThan(0)
      expect(stability.admittedClaimCount).toBeGreaterThan(0)
    })

    it('tracks weakest bridge', () => {
      const graph = new ClaimGraph()
      // Add claims with varying vulnerability
      const c1 = graph.addClaim({
        type: 'hypothesis',
        epistemicLayer: 'explanation',
        statement: 'Claim 1',
        phase: 'admitted',
        evidence: { grounded: [], derived: [] },
        strength: {
          confidence: 0.3,
          evidenceType: 'heuristic_motivation',
          vulnerabilityScore: 0.9,
        },
        created_by: 'test',
      })
      graph.addClaim({
        type: 'hypothesis',
        epistemicLayer: 'explanation',
        statement: 'Claim 2',
        phase: 'admitted',
        evidence: { grounded: ['e1'], derived: ['e2'] },
        strength: {
          confidence: 0.9,
          evidenceType: 'empirical_support',
          vulnerabilityScore: 0.1,
        },
        created_by: 'test',
      })
      const pool = new EvidencePoolManager()
      const stability = computeBasicStability(graph, pool)
      expect(stability.weakestBridge).not.toBeNull()
    })
  })

  describe('claim query helpers', () => {
    it('getClaimsByPhase filters correctly', () => {
      const proposed = getClaimsByPhase(state, 'proposed')
      expect(proposed.length).toBe(state.claimGraph.claims.length)

      const admitted = getClaimsByPhase(state, 'admitted')
      expect(admitted.length).toBe(0)
    })

    it('getUnresolvedClaims returns proposed + investigating', () => {
      // All initial claims are proposed
      const unresolved = getUnresolvedClaims(state)
      expect(unresolved.length).toBe(state.claimGraph.claims.length)

      // Modify one to admitted — it should not appear
      const graph = ClaimGraph.fromJSON(state.claimGraph)
      graph.updateClaim(graph.allClaims[0].id, { phase: 'admitted' })
      const modifiedState = {
        ...state,
        claimGraph: graph.toJSON(),
      }
      const unresolvedAfter = getUnresolvedClaims(modifiedState)
      expect(unresolvedAfter.length).toBe(state.claimGraph.claims.length - 1)
    })

    it('getAdmittedClaims returns only admitted', () => {
      expect(getAdmittedClaims(state).length).toBe(0)

      const graph = ClaimGraph.fromJSON(state.claimGraph)
      graph.updateClaim(graph.allClaims[0].id, { phase: 'admitted' })
      const modifiedState = {
        ...state,
        claimGraph: graph.toJSON(),
      }
      expect(getAdmittedClaims(modifiedState).length).toBe(1)
    })
  })

  describe('createEmptyStability', () => {
    it('returns zeroed metrics', () => {
      const s = createEmptyStability()
      expect(s.convergenceScore).toBe(0)
      expect(s.admittedClaimCount).toBe(0)
      expect(s.proposedClaimCount).toBe(0)
      expect(s.weakestBridge).toBeNull()
      expect(s.paperReadiness).toBe('not_ready')
      expect(s.evidenceCoverage).toBe(0)
      expect(s.lastArbiterAssessment).toBe('')
    })
  })

  describe('trajectory and budget', () => {
    it('adds trajectory entry and increments cycle count', () => {
      const newState = addTrajectoryEntry(state, {
        action_type: 'experiment',
        agent: 'experiment-runner',
        description: 'Run baseline experiment',
        outcome: 'Success',
        state_changes: ['claim confidence 0.5→0.8'],
      })
      expect(newState.trajectory.length).toBe(1)
      expect(newState.orchestrator_cycle_count).toBe(1)
      expect(newState.trajectory[0].timestamp).toBeTruthy()
    })

    it('supports claim_graph_delta in trajectory', () => {
      const newState = addTrajectoryEntry(state, {
        action_type: 'experiment',
        agent: 'experiment-runner',
        description: 'Run experiment',
        outcome: 'Success',
        state_changes: [],
        claim_graph_delta: {
          claims_added: 2,
          claims_admitted: 1,
          claims_demoted: 0,
          claims_rejected: 0,
          edges_added: 1,
        },
      })
      expect(newState.trajectory[0].claim_graph_delta).toBeDefined()
      expect(newState.trajectory[0].claim_graph_delta!.claims_added).toBe(2)
    })

    it('records spending correctly', () => {
      let s = recordSpending(state, 'research', 5)
      s = recordSpending(s, 'experiment', 10)
      s = recordSpending(s, 'research', 3)
      expect(s.budget.spent_usd).toBe(18)
      expect(s.budget.remaining_usd).toBe(32)
      expect(s.budget.breakdown).toEqual([
        { category: 'research', spent_usd: 8 },
        { category: 'experiment', spent_usd: 10 },
      ])
    })

    it('isBudgetLow detects low budget', () => {
      expect(isBudgetLow(state)).toBe(false)
      const s = recordSpending(state, 'test', 45) // 90% spent
      expect(isBudgetLow(s)).toBe(true)
    })
  })

  describe('serialization', () => {
    it('serializes and deserializes correctly', () => {
      const json = serializeState(state)
      const restored = deserializeState(json)
      expect(restored.proposal.title).toBe(state.proposal.title)
      expect(restored.claimGraph.claims.length).toBe(
        state.claimGraph.claims.length,
      )
      expect(restored.budget.total_usd).toBe(state.budget.total_usd)
    })

    it('round-trips claimGraph', () => {
      const json = serializeState(state)
      const restored = deserializeState(json)
      expect(restored.claimGraph.claims.length).toBe(
        state.claimGraph.claims.length,
      )
      for (let i = 0; i < state.claimGraph.claims.length; i++) {
        expect(restored.claimGraph.claims[i].statement).toBe(
          state.claimGraph.claims[i].statement,
        )
        expect(restored.claimGraph.claims[i].type).toBe(
          state.claimGraph.claims[i].type,
        )
        expect(restored.claimGraph.claims[i].phase).toBe(
          state.claimGraph.claims[i].phase,
        )
      }
    })

    it('round-trips evidencePool', () => {
      // Add some evidence first
      const pool = new EvidencePoolManager(state.evidencePool)
      pool.addGrounded({
        claim: 'Test claim',
        source_type: 'literature',
        source_ref: 'paper1',
        verified: true,
        supports_claims: [],
        contradicts_claims: [],
        acquired_by: 'test',
      })
      pool.addDerived({
        claim: 'Test derived',
        method: 'computation',
        reproducible: true,
        artifact_id: 'art1',
        assumptions: ['a1'],
        supports_claims: [],
        contradicts_claims: [],
        produced_by: 'test',
      })
      const withEvidence = { ...state, evidencePool: pool.pool }

      const json = serializeState(withEvidence)
      const restored = deserializeState(json)
      expect(restored.evidencePool.grounded.length).toBe(1)
      expect(restored.evidencePool.derived.length).toBe(1)
      expect(restored.evidencePool.grounded[0].source_ref).toBe('paper1')
    })

    it('saves and loads from disk', () => {
      saveResearchState(TEST_DIR, state)
      const loaded = loadResearchState(TEST_DIR)
      expect(loaded).not.toBeNull()
      expect(loaded!.proposal.title).toBe(state.proposal.title)
      expect(loaded!.claimGraph.claims.length).toBe(
        state.claimGraph.claims.length,
      )
    })

    it('save/load round-trip with claimGraph', () => {
      saveResearchState(TEST_DIR, state)
      const loaded = loadResearchState(TEST_DIR)!
      expect(loaded.claimGraph.claims.length).toBe(
        state.claimGraph.claims.length,
      )
      expect(loaded.evidencePool.grounded).toEqual([])
      expect(loaded.stability.convergenceScore).toBe(0)
    })

    it('returns null when no state file exists', () => {
      const loaded = loadResearchState(join(TEST_DIR, 'nonexistent'))
      expect(loaded).toBeNull()
    })
  })

  describe('buildStateContext', () => {
    it('produces a non-empty summary with claim graph section', () => {
      const ctx = buildStateContext(state)
      expect(ctx).toContain(state.proposal.title)
      expect(ctx).toContain('Claim Graph')
      expect(ctx).toContain('Convergence')
    })

    it('includes admitted claims section when present', () => {
      const graph = ClaimGraph.fromJSON(state.claimGraph)
      graph.updateClaim(graph.allClaims[0].id, { phase: 'admitted' })
      const modified = { ...state, claimGraph: graph.toJSON() }
      const ctx = buildStateContext(modified)
      expect(ctx).toContain('Admitted Claims')
    })

    it('does not mention old beliefs/uncertainties/risks', () => {
      const ctx = buildStateContext(state)
      expect(ctx).not.toContain('### Beliefs')
      expect(ctx).not.toContain('### Open Uncertainties')
      expect(ctx).not.toContain('### Active Risks')
      expect(ctx).not.toContain('### Uninvestigated Surprises')
    })

    it('includes budget info', () => {
      const ctx = buildStateContext(state)
      expect(ctx).toContain('$50')
    })

    it('includes evidence pool summary', () => {
      const ctx = buildStateContext(state)
      expect(ctx).toContain('Evidence Pool')
    })
  })

  describe('addArtifact', () => {
    it('adds an artifact entry', () => {
      const s = addArtifact(state, {
        type: 'experiment_result',
        path: 'experiments/results/run1.json',
        created_by: 'experiment-runner',
        description: 'Baseline experiment results',
      })
      expect(s.artifacts.entries.length).toBe(1)
      expect(s.artifacts.entries[0].id).toBeTruthy()
      expect(s.artifacts.entries[0].created_at).toBeTruthy()
    })
  })
})
