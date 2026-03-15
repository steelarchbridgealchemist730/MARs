import { describe, test, expect } from 'bun:test'
import { ClaimGraph } from '../../src/paper/claim-graph/index'
import type { ClaimInput } from '../../src/paper/claim-graph/index'
import { EvidencePoolManager } from '../../src/paper/evidence-pool'
import {
  buildL0,
  buildL1,
  buildL2,
} from '../../src/paper/claim-graph/context-views'
import { FocusSelector } from '../../src/paper/claim-graph/focus-selector'
import { allocateTokenBudget } from '../../src/paper/claim-graph/token-budget'
import { PromptAssembler } from '../../src/paper/claim-graph/prompt-assembler'
import { TrajectoryCompressor } from '../../src/paper/trajectory-compressor'
import { EvidencePoolCompressor } from '../../src/paper/evidence-pool-compressor'
import {
  estimateTokens,
  truncate,
  truncateToTokens,
} from '../../src/paper/claim-graph/token-utils'
import type {
  ResearchState,
  StabilityMetrics,
  TrajectoryEntry,
} from '../../src/paper/research-state'
import type {
  BuilderOutput,
  SkepticOutput,
} from '../../src/paper/claim-graph/triple-role-types'
import type {
  ClaimType,
  ClaimPhase,
  EpistemicLayer,
} from '../../src/paper/claim-graph/types'

// -- Test helpers --

const LAYERS: EpistemicLayer[] = [
  'observation',
  'explanation',
  'exploitation',
  'justification',
]
const PHASES: ClaimPhase[] = ['proposed', 'under_investigation', 'admitted']
const TYPES: ClaimType[] = [
  'observation',
  'hypothesis',
  'theorem',
  'empirical',
  'novelty',
]

function buildLargeGraph(n: number): {
  graph: ClaimGraph
  pool: EvidencePoolManager
} {
  const graph = new ClaimGraph()
  const pool = new EvidencePoolManager()
  const claimIds: string[] = []

  for (let i = 0; i < n; i++) {
    const id = graph.addClaim({
      type: TYPES[i % TYPES.length],
      epistemicLayer: LAYERS[i % LAYERS.length],
      statement: `Claim ${i}: A statement about research finding number ${i} that describes something meaningful`,
      phase: PHASES[i % PHASES.length],
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.5 + (i % 5) * 0.1,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.2 + (i % 4) * 0.2,
      },
      created_by: 'test',
    })
    claimIds.push(id)

    // Add evidence for some claims
    if (i % 2 === 0) {
      pool.addGrounded({
        claim: `Evidence for claim ${i}`,
        source_type: 'literature',
        source_ref: `paper-${i}`,
        verified: i % 3 === 0,
        supports_claims: [id],
        contradicts_claims: [],
        acquired_by: 'test',
      })
    }
    if (i % 3 === 0) {
      pool.addDerived({
        claim: `Derived evidence for claim ${i}`,
        method: 'experiment',
        reproducible: true,
        artifact_id: `artifact-${i}`,
        assumptions: [],
        supports_claims: [id],
        contradicts_claims: [],
        produced_by: 'test',
      })
    }
  }

  // Add edges between consecutive claims (same-layer or adjacent-layer only)
  for (let i = 1; i < claimIds.length; i++) {
    try {
      graph.addEdge({
        source: claimIds[i],
        target: claimIds[i - 1],
        relation: i % 3 === 0 ? 'depends_on' : 'supports',
        strength: 'moderate',
      })
    } catch {
      /* skip if layer mismatch */
    }
  }

  return { graph, pool }
}

function buildTestState(
  graph: ClaimGraph,
  pool: EvidencePoolManager,
): ResearchState {
  return {
    id: 'test-state',
    proposal: {
      id: 'test-proposal',
      title: 'Test Proposal',
      abstract: 'A test abstract',
      methodology: 'Test methodology',
      innovation: ['Innovation 1'],
      feasibility: {
        data_required: 'none',
        compute_estimate: 'low',
        timeline_weeks: 4,
        score: 0.8,
      },
      risk: {
        level: 'low',
        description: 'Low risk',
      },
      novelty_score: 0.8,
      impact_score: 0.7,
      references: [],
      created_at: new Date().toISOString(),
    },
    paper_type: 'empirical',
    claimGraph: graph.toJSON(),
    evidencePool: pool.pool,
    stability: {
      convergenceScore: 0.5,
      admittedClaimCount: graph.getClaimsByPhase('admitted').length,
      proposedClaimCount: graph.getClaimsByPhase('proposed').length,
      weakestBridge: null,
      paperReadiness: 'needs_work',
      evidenceCoverage: 0.3,
      lastArbiterAssessment: '',
    },
    literature_awareness: {
      deeply_read: [],
      aware_but_unread: [],
      known_results: [],
      confirmed_gaps: [],
      last_comprehensive_search: null,
    },
    theory: { proofs: [] },
    budget: {
      total_usd: 50,
      spent_usd: 10,
      remaining_usd: 40,
      breakdown: [],
      warn_at_percent: 10,
    },
    time: {
      started_at: new Date().toISOString(),
      estimated_completion: null,
      deadline: null,
    },
    compute: null,
    artifacts: {
      entries: [],
      literature_db: null,
      selected_proposal: null,
      paper_tex: null,
      compiled_pdf: null,
    },
    trajectory: [],
    initialized: true,
    orchestrator_cycle_count: 0,
  }
}

function buildTrajectory(n: number): TrajectoryEntry[] {
  const entries: TrajectoryEntry[] = []
  for (let i = 0; i < n; i++) {
    entries.push({
      timestamp: new Date(Date.now() - (n - i) * 60000).toISOString(),
      action_type:
        i % 5 === 0 ? 'experiment' : i % 7 === 0 ? 'proof' : 'investigate',
      agent: i % 2 === 0 ? 'investigator' : 'experiment-runner',
      description: `Action ${i}: Performed research task number ${i}`,
      outcome: `Result ${i}: Found something interesting`,
      state_changes: [],
      claim_graph_delta: {
        claims_added: i % 3 === 0 ? 2 : 0,
        claims_admitted: i % 5 === 0 ? 1 : 0,
        claims_demoted: 0,
        claims_rejected: i % 10 === 0 ? 1 : 0,
        edges_added: 1,
      },
    })
  }
  return entries
}

const MOCK_BUILDER_OUTPUT: BuilderOutput = {
  narrative: 'Test narrative about research progress.',
  new_claims_proposed: [
    {
      type: 'hypothesis',
      epistemicLayer: 'explanation',
      statement: 'New hypothesis from builder',
      confidence: 0.7,
    },
  ],
  new_edges_proposed: [],
  recommended_next_actions: [
    {
      action: 'Run experiment on dataset X',
      delegate_to: 'experiment-runner',
      priority: 'high',
    },
  ],
}

const MOCK_SKEPTIC_OUTPUT: SkepticOutput = {
  internal_inconsistencies: [],
  bridge_gaps: [
    {
      from_claim: 'c1',
      to_claim: 'c2',
      severity: 'major',
      description: 'Skips explanation layer',
    },
  ],
  evidence_inflation: [
    {
      claim_id: 'c3',
      claimed_strength: 'theorem_support',
      actual_strength: 'consistent_with',
      reason: 'Weak correlation',
    },
  ],
  theorem_overreach: [],
  top3_collapse_points: [
    {
      claim_id: 'c4',
      vulnerability: 0.85,
      cascade_size: 5,
      falsification_experiment: 'Run ablation study',
    },
  ],
  admission_denials: [],
}

// -- Tests --

describe('Token Utilities', () => {
  test('estimateTokens returns reasonable count', () => {
    const text = 'Hello world, this is a test string.'
    const tokens = estimateTokens(text)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBe(Math.ceil(text.length / 4))
  })

  test('estimateTokens for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  test('truncate respects maxChars and adds ...', () => {
    const text = 'This is a fairly long sentence that should get truncated'
    const result = truncate(text, 20)
    expect(result.length).toBeLessThanOrEqual(23) // 20 + '...'
    expect(result).toEndWith('...')
  })

  test('truncate returns original if short enough', () => {
    const text = 'Short'
    expect(truncate(text, 100)).toBe(text)
  })

  test('truncateToTokens caps at token budget', () => {
    const text = 'x'.repeat(10000)
    const result = truncateToTokens(text, 100) // 100 tokens = 400 chars
    expect(result.length).toBeLessThanOrEqual(403) // 400 + '...'
  })

  test('truncateToTokens returns original if within budget', () => {
    const text = 'Short text'
    expect(truncateToTokens(text, 1000)).toBe(text)
  })
})

describe('buildL0', () => {
  test('30-claim graph produces < 400 tokens', () => {
    const { graph, pool } = buildLargeGraph(30)
    const stability: StabilityMetrics = {
      convergenceScore: 0.5,
      admittedClaimCount: 10,
      proposedClaimCount: 10,
      weakestBridge: { claimId: 'test-id', vulnerability: 0.8 },
      paperReadiness: 'needs_work',
      evidenceCoverage: 0.3,
      lastArbiterAssessment: '',
    }
    const result = buildL0(graph, pool, stability)
    expect(estimateTokens(result)).toBeLessThan(400)
  })

  test('empty graph produces valid output', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()
    const stability: StabilityMetrics = {
      convergenceScore: 0,
      admittedClaimCount: 0,
      proposedClaimCount: 0,
      weakestBridge: null,
      paperReadiness: 'not_ready',
      evidenceCoverage: 0,
      lastArbiterAssessment: '',
    }
    const result = buildL0(graph, pool, stability)
    expect(result).toContain('Claims: 0')
    expect(result).toContain('Convergence:')
  })

  test('includes convergence and readiness', () => {
    const { graph, pool } = buildLargeGraph(5)
    const stability: StabilityMetrics = {
      convergenceScore: 0.75,
      admittedClaimCount: 3,
      proposedClaimCount: 2,
      weakestBridge: null,
      paperReadiness: 'nearly_ready',
      evidenceCoverage: 0.6,
      lastArbiterAssessment: '',
    }
    const result = buildL0(graph, pool, stability)
    expect(result).toContain('0.75')
    expect(result).toContain('nearly_ready')
  })
})

describe('buildL1', () => {
  test('30-claim graph produces < 2000 tokens', () => {
    const { graph } = buildLargeGraph(30)
    const result = buildL1(graph)
    expect(estimateTokens(result)).toBeLessThan(2000)
  })

  test('shows admitted claims', () => {
    const { graph } = buildLargeGraph(10)
    const result = buildL1(graph)
    expect(result).toContain('Key Claims')
    // Should contain at least some admitted claims (every 3rd claim is admitted)
    if (graph.getClaimsByPhase('admitted').length > 0) {
      expect(result).toContain('Admitted (paper backbone)')
    }
  })

  test('shows weakest bridges', () => {
    const { graph } = buildLargeGraph(10)
    const result = buildL1(graph)
    if (graph.findWeakestBridges().length > 0) {
      expect(result).toContain('Weakest Bridges')
    }
  })

  test('shows contradictions when present', () => {
    const graph = new ClaimGraph()
    const id1 = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'explanation',
      statement: 'Hypothesis A',
      phase: 'proposed',
      evidence: { grounded: ['e1'], derived: [] },
      strength: {
        confidence: 0.7,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.3,
      },
      created_by: 'test',
    })
    const id2 = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'explanation',
      statement: 'Hypothesis B contradicts A',
      phase: 'proposed',
      evidence: { grounded: [], derived: ['d1'] },
      strength: {
        confidence: 0.6,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.4,
      },
      created_by: 'test',
    })
    graph.addEdge({
      source: id1,
      target: id2,
      relation: 'contradicts',
      strength: 'strong',
    })
    const result = buildL1(graph)
    expect(result).toContain('Contradictions')
  })
})

describe('buildL2', () => {
  test('respects token budget', () => {
    const { graph, pool } = buildLargeGraph(30)
    const focusIds = graph
      .getClaimsByPhase('proposed')
      .map(c => c.id)
      .slice(0, 10)
    const result = buildL2(graph, focusIds, pool, 500)
    expect(estimateTokens(result)).toBeLessThan(600) // some overhead for header
  })

  test('truncates gracefully with remaining IDs', () => {
    const { graph, pool } = buildLargeGraph(30)
    const focusIds = graph.allClaims.map(c => c.id)
    const result = buildL2(graph, focusIds, pool, 300) // very tight budget
    expect(result).toContain('more in focus, truncated')
  })

  test('sorts by vulnerability descending', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()
    const lowVuln = graph.addClaim({
      type: 'observation',
      epistemicLayer: 'observation',
      statement: 'Low vulnerability claim',
      phase: 'admitted',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.9,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.1,
      },
      created_by: 'test',
    })
    const highVuln = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'explanation',
      statement: 'High vulnerability claim',
      phase: 'proposed',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.3,
        evidenceType: 'heuristic_motivation',
        vulnerabilityScore: 0.9,
      },
      created_by: 'test',
    })
    const result = buildL2(graph, [lowVuln, highVuln], pool, 5000)
    const highPos = result.indexOf('High vulnerability')
    const lowPos = result.indexOf('Low vulnerability')
    expect(highPos).toBeLessThan(lowPos) // high vulnerability appears first
  })

  test('shows edges within focus set', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()
    const id1 = graph.addClaim({
      type: 'observation',
      epistemicLayer: 'observation',
      statement: 'Obs',
      phase: 'admitted',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.8,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.2,
      },
      created_by: 'test',
    })
    const id2 = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'explanation',
      statement: 'Hyp',
      phase: 'proposed',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.5,
        evidenceType: 'heuristic_motivation',
        vulnerabilityScore: 0.5,
      },
      created_by: 'test',
    })
    graph.addEdge({
      source: id2,
      target: id1,
      relation: 'depends_on',
      strength: 'moderate',
    })
    const result = buildL2(graph, [id1, id2], pool, 5000)
    expect(result).toContain('Edges')
    expect(result).toContain('depends_on')
  })
})

describe('FocusSelector', () => {
  const selector = new FocusSelector()

  test('selectForBuilder returns frontier + neighbors', () => {
    const { graph } = buildLargeGraph(10)
    const ids = selector.selectForBuilder(graph)
    expect(ids.length).toBeGreaterThan(0)
    // Should include all proposed and under_investigation claims
    const frontier = [
      ...graph.getClaimsByPhase('proposed'),
      ...graph.getClaimsByPhase('under_investigation'),
    ]
    for (const c of frontier) {
      expect(ids).toContain(c.id)
    }
  })

  test('selectForSkeptic includes bridges + cascade', () => {
    const { graph } = buildLargeGraph(15)
    const ids = selector.selectForSkeptic(graph, MOCK_BUILDER_OUTPUT)
    expect(ids.length).toBeGreaterThan(0)
    // Should include weak bridges
    const bridges = graph.findWeakestBridges().slice(0, 5)
    for (const b of bridges) {
      expect(ids).toContain(b.claim.id)
    }
  })

  test('selectForArbiter includes disputed claims', () => {
    const { graph } = buildLargeGraph(10)
    const claimIds = graph.allClaims.map(c => c.id)
    const skepticOutput: SkepticOutput = {
      internal_inconsistencies: [],
      bridge_gaps: [
        {
          from_claim: claimIds[0],
          to_claim: claimIds[1],
          severity: 'major',
          description: 'Gap',
        },
      ],
      evidence_inflation: [
        {
          claim_id: claimIds[2],
          claimed_strength: 'strong',
          actual_strength: 'weak',
          reason: 'test',
        },
      ],
      theorem_overreach: [],
      top3_collapse_points: [],
      admission_denials: [],
    }
    const ids = selector.selectForArbiter(
      graph,
      MOCK_BUILDER_OUTPUT,
      skepticOutput,
    )
    expect(ids).toContain(claimIds[0])
    expect(ids).toContain(claimIds[1])
    expect(ids).toContain(claimIds[2])
  })

  test('handles empty outputs gracefully', () => {
    const graph = new ClaimGraph()
    const emptyBuilder: BuilderOutput = {
      narrative: '',
      new_claims_proposed: [],
      new_edges_proposed: [],
      recommended_next_actions: [],
    }
    const emptySkeptic: SkepticOutput = {
      internal_inconsistencies: [],
      bridge_gaps: [],
      evidence_inflation: [],
      theorem_overreach: [],
      top3_collapse_points: [],
      admission_denials: [],
    }
    expect(selector.selectForBuilder(graph)).toEqual([])
    expect(selector.selectForSkeptic(graph, emptyBuilder)).toEqual([])
    expect(
      selector.selectForArbiter(graph, emptyBuilder, emptySkeptic),
    ).toEqual([])
  })
})

describe('TokenBudget', () => {
  test('correct tier allocation for small graph', () => {
    const budget = allocateTokenBudget(5, false)
    expect(budget.l1KeyClaims).toBe(1000)
    expect(budget.l2FocusSubgraph).toBe(3000)
    expect(budget.trajectory).toBe(700)
    expect(budget.domainKnowledge).toBe(0)
  })

  test('correct tier allocation for medium graph', () => {
    const budget = allocateTokenBudget(20, false)
    expect(budget.l1KeyClaims).toBe(1500)
    expect(budget.l2FocusSubgraph).toBe(2500)
    expect(budget.trajectory).toBe(700)
  })

  test('correct tier allocation for large graph', () => {
    const budget = allocateTokenBudget(50, false)
    expect(budget.l1KeyClaims).toBe(2000)
    expect(budget.l2FocusSubgraph).toBe(2000)
    expect(budget.trajectory).toBe(500)
    expect(budget.evidence).toBe(800)
  })

  test('domainKnowledge is 0 when false', () => {
    const budget = allocateTokenBudget(10, false)
    expect(budget.domainKnowledge).toBe(0)
  })

  test('domainKnowledge is 600 when true', () => {
    const budget = allocateTokenBudget(10, true)
    expect(budget.domainKnowledge).toBe(600)
  })
})

describe('TrajectoryCompressor', () => {
  const compressor = new TrajectoryCompressor()

  test('empty trajectory returns valid string', () => {
    const result = compressor.compress([])
    expect(result).toContain('Trajectory')
    expect(result).toContain('No actions taken yet')
  })

  test('40 entries stays under 800 tokens', () => {
    const trajectory = buildTrajectory(40)
    const result = compressor.compress(trajectory, 800)
    expect(estimateTokens(result)).toBeLessThan(800)
  })

  test('last 3 entries shown in full detail', () => {
    const trajectory = buildTrajectory(10)
    const result = compressor.compress(trajectory)
    // Last 3 entries should appear with their details
    expect(result).toContain('Action 9')
    expect(result).toContain('Action 8')
    expect(result).toContain('Action 7')
  })

  test('milestones from earlier entries', () => {
    const trajectory = buildTrajectory(20)
    const result = compressor.compress(trajectory)
    expect(result).toContain('Earlier Milestones')
    expect(result).toContain('earlier cycles')
  })

  test('single entry shows full detail', () => {
    const trajectory = buildTrajectory(1)
    const result = compressor.compress(trajectory)
    expect(result).toContain('Action 0')
    expect(result).toContain('Result 0')
  })
})

describe('EvidencePoolCompressor', () => {
  const compressor = new EvidencePoolCompressor()

  test('empty pool returns stats', () => {
    const pool = new EvidencePoolManager()
    const result = compressor.compress(pool, [])
    expect(result).toContain('Evidence: 0G')
    expect(result).toContain('0D')
  })

  test('contradictions shown', () => {
    const pool = new EvidencePoolManager()
    pool.addGrounded({
      claim: 'Contradicting evidence',
      source_type: 'literature',
      source_ref: 'paper-1',
      verified: true,
      supports_claims: [],
      contradicts_claims: ['c1'],
      acquired_by: 'test',
    })
    const result = compressor.compress(pool, ['c1'])
    expect(result).toContain('Contradictory')
    expect(result).toContain('Contradicting evidence')
  })

  test('focus evidence respects budget', () => {
    const pool = new EvidencePoolManager()
    const claimIds: string[] = []
    // Add lots of evidence
    for (let i = 0; i < 50; i++) {
      const claimId = `claim-${i}`
      claimIds.push(claimId)
      pool.addGrounded({
        claim: `Evidence for claim ${i} with long description that takes up tokens`,
        source_type: 'literature',
        source_ref: `paper-${i}`,
        verified: true,
        supports_claims: [claimId],
        contradicts_claims: [],
        acquired_by: 'test',
      })
    }
    const result = compressor.compress(pool, claimIds, 200)
    // Should truncate before showing all 50
    expect(result).toContain('truncated')
  })
})

describe('PromptAssembler', () => {
  test('assembleBuilder produces < 12K tokens', () => {
    const { graph, pool } = buildLargeGraph(30)
    const state = buildTestState(graph, pool)
    const assembler = new PromptAssembler(graph, pool, state)
    const prompt = assembler.assembleBuilder()
    expect(estimateTokens(prompt)).toBeLessThan(12000)
  })

  test('assembleSkeptic produces < 12K tokens', () => {
    const { graph, pool } = buildLargeGraph(30)
    const state = buildTestState(graph, pool)
    const assembler = new PromptAssembler(graph, pool, state)
    const prompt = assembler.assembleSkeptic(MOCK_BUILDER_OUTPUT)
    expect(estimateTokens(prompt)).toBeLessThan(12000)
  })

  test('assembleArbiter produces < 12K tokens', () => {
    const { graph, pool } = buildLargeGraph(30)
    const state = buildTestState(graph, pool)
    const assembler = new PromptAssembler(graph, pool, state)
    const prompt = assembler.assembleArbiter(
      MOCK_BUILDER_OUTPUT,
      MOCK_SKEPTIC_OUTPUT,
    )
    expect(estimateTokens(prompt)).toBeLessThan(12000)
  })

  test('builder includes literature context', () => {
    const { graph, pool } = buildLargeGraph(5)
    const state = buildTestState(graph, pool)
    state.literature_awareness.known_results = [
      {
        statement: 'Known theorem X',
        source: 'paper-A',
        confidence: 0.9,
        directly_usable: true,
      },
    ]
    const assembler = new PromptAssembler(graph, pool, state)
    const prompt = assembler.assembleBuilder()
    expect(prompt).toContain('Literature')
    expect(prompt).toContain('Known theorem X')
  })

  test('skeptic excludes literature', () => {
    const { graph, pool } = buildLargeGraph(5)
    const state = buildTestState(graph, pool)
    state.literature_awareness.known_results = [
      {
        statement: 'Known theorem X',
        source: 'paper-A',
        confidence: 0.9,
        directly_usable: true,
      },
    ]
    const assembler = new PromptAssembler(graph, pool, state)
    const prompt = assembler.assembleSkeptic(MOCK_BUILDER_OUTPUT)
    // Skeptic should NOT have literature section
    expect(prompt).not.toContain('## Literature')
  })

  test('arbiter includes convergence context', () => {
    const { graph, pool } = buildLargeGraph(5)
    const state = buildTestState(graph, pool)
    const assembler = new PromptAssembler(graph, pool, state)
    const prompt = assembler.assembleArbiter(
      MOCK_BUILDER_OUTPUT,
      MOCK_SKEPTIC_OUTPUT,
    )
    expect(prompt).toContain('Convergence')
    expect(prompt).toContain('Readiness')
  })

  test('builder includes budget context', () => {
    const { graph, pool } = buildLargeGraph(5)
    const state = buildTestState(graph, pool)
    const assembler = new PromptAssembler(graph, pool, state)
    const prompt = assembler.assembleBuilder()
    expect(prompt).toContain('Budget')
    expect(prompt).toContain('$40.00')
  })

  test('update() changes references', () => {
    const { graph: g1, pool: p1 } = buildLargeGraph(5)
    const state1 = buildTestState(g1, p1)
    const assembler = new PromptAssembler(g1, p1, state1)

    const { graph: g2, pool: p2 } = buildLargeGraph(15)
    const state2 = buildTestState(g2, p2)
    assembler.update(g2, p2, state2)

    const prompt = assembler.assembleBuilder()
    // Should reflect the 15-claim graph, not the 5-claim one
    expect(prompt).toContain('15') // total claims in L0
  })

  test('works with empty graph', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()
    const state = buildTestState(graph, pool)
    const assembler = new PromptAssembler(graph, pool, state)

    // Should not throw
    const builder = assembler.assembleBuilder()
    expect(builder).toContain('BUILDER')

    const skeptic = assembler.assembleSkeptic(MOCK_BUILDER_OUTPUT)
    expect(skeptic).toContain('SKEPTIC')

    const arbiter = assembler.assembleArbiter(
      MOCK_BUILDER_OUTPUT,
      MOCK_SKEPTIC_OUTPUT,
    )
    expect(arbiter).toContain('ARBITER')
  })
})
