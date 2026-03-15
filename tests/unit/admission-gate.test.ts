import { describe, it, expect, beforeEach } from 'bun:test'
import { ClaimGraph } from '../../src/paper/claim-graph/index'
import type { ClaimInput } from '../../src/paper/claim-graph/index'
import { EvidencePoolManager } from '../../src/paper/evidence-pool'
import { canAdmit } from '../../src/paper/admission-gate'
import { suggestContraction } from '../../src/paper/claim-contraction'

function makeClaim(overrides?: Partial<ClaimInput>): ClaimInput {
  return {
    type: 'hypothesis',
    epistemicLayer: 'explanation',
    statement: 'Test hypothesis',
    phase: 'proposed',
    evidence: { grounded: ['ev1'], derived: ['ev2'] },
    strength: {
      confidence: 0.8,
      evidenceType: 'empirical_support',
      vulnerabilityScore: 0.3,
    },
    created_by: 'test',
    ...overrides,
  }
}

describe('canAdmit', () => {
  let graph: ClaimGraph
  let pool: EvidencePoolManager

  beforeEach(() => {
    graph = new ClaimGraph()
    pool = new EvidencePoolManager()
  })

  // ── R1: No evidence ────────────────────────────────

  it('R1: rejects claim with no evidence', () => {
    const id = graph.addClaim(
      makeClaim({ evidence: { grounded: [], derived: [] } }),
    )
    const result = canAdmit(id, graph, pool)
    expect(result.admit).toBe(false)
    expect(result.reason).toBe('No evidence')
  })

  it('R1: passes with grounded only', () => {
    const id = graph.addClaim(
      makeClaim({ evidence: { grounded: ['ev1'], derived: [] } }),
    )
    const result = canAdmit(id, graph, pool)
    // Should NOT fail on R1 (may pass or fail on other rules)
    expect(result.reason !== 'No evidence').toBe(true)
  })

  // ── R2: theorem/novelty need both ──────────────────

  it('R2: rejects theorem without grounded evidence', () => {
    const id = graph.addClaim(
      makeClaim({
        type: 'theorem',
        evidence: { grounded: [], derived: ['ev1'] },
      }),
    )
    const result = canAdmit(id, graph, pool)
    expect(result.admit).toBe(false)
    expect(result.reason).toContain('theorem needs both')
  })

  it('R2: rejects theorem without derived evidence', () => {
    const id = graph.addClaim(
      makeClaim({
        type: 'theorem',
        evidence: { grounded: ['ev1'], derived: [] },
      }),
    )
    const result = canAdmit(id, graph, pool)
    expect(result.admit).toBe(false)
    expect(result.reason).toContain('theorem needs both')
  })

  it('R2: rejects novelty without both evidence types', () => {
    const id = graph.addClaim(
      makeClaim({
        type: 'novelty',
        evidence: { grounded: ['ev1'], derived: [] },
      }),
    )
    const result = canAdmit(id, graph, pool)
    expect(result.admit).toBe(false)
    expect(result.reason).toContain('novelty needs both')
  })

  it('R2: hypothesis skips R2 with only grounded evidence', () => {
    const id = graph.addClaim(
      makeClaim({
        type: 'hypothesis',
        evidence: { grounded: ['ev1'], derived: [] },
      }),
    )
    const result = canAdmit(id, graph, pool)
    // Should NOT fail on R2
    if (!result.admit) {
      expect(result.reason).not.toContain('needs both')
    }
  })

  // ── R3: Unadmitted dependencies ───────────────────

  it('R3: rejects when dependency is not admitted', () => {
    const dep = graph.addClaim(makeClaim({ phase: 'proposed' }))
    const id = graph.addClaim(makeClaim())
    graph.addEdge({
      source: id,
      target: dep,
      relation: 'depends_on',
      strength: 'strong',
    })
    const result = canAdmit(id, graph, pool)
    expect(result.admit).toBe(false)
    expect(result.reason).toContain('Unadmitted deps')
  })

  it('R3: passes when all deps are admitted', () => {
    const dep = graph.addClaim(makeClaim({ phase: 'admitted' }))
    const id = graph.addClaim(makeClaim())
    graph.addEdge({
      source: id,
      target: dep,
      relation: 'depends_on',
      strength: 'strong',
    })
    const result = canAdmit(id, graph, pool)
    // Should NOT fail on R3
    if (!result.admit) {
      expect(result.reason).not.toContain('Unadmitted deps')
    }
  })

  it('R3: passes when claim has no dependencies', () => {
    const id = graph.addClaim(makeClaim())
    const result = canAdmit(id, graph, pool)
    // Should NOT fail on R3
    if (!result.admit) {
      expect(result.reason).not.toContain('Unadmitted deps')
    }
  })

  // ── R4: Confidence threshold ──────────────────────

  it('R4: rejects confidence 0.59', () => {
    const id = graph.addClaim(
      makeClaim({
        strength: {
          confidence: 0.59,
          evidenceType: 'empirical_support',
          vulnerabilityScore: 0.3,
        },
      }),
    )
    const result = canAdmit(id, graph, pool)
    expect(result.admit).toBe(false)
    expect(result.reason).toContain('< 0.6')
  })

  it('R4: passes confidence 0.6', () => {
    const id = graph.addClaim(
      makeClaim({
        strength: {
          confidence: 0.6,
          evidenceType: 'empirical_support',
          vulnerabilityScore: 0.3,
        },
      }),
    )
    const result = canAdmit(id, graph, pool)
    // Should NOT fail on R4
    if (!result.admit) {
      expect(result.reason).not.toContain('< 0.6')
    }
  })

  // ── R5: Evidence type ─────────────────────────────

  it('R5: rejects consistent_with evidence type', () => {
    const id = graph.addClaim(
      makeClaim({
        strength: {
          confidence: 0.8,
          evidenceType: 'consistent_with',
          vulnerabilityScore: 0.3,
        },
      }),
    )
    const result = canAdmit(id, graph, pool)
    expect(result.admit).toBe(false)
    expect(result.reason).toContain('Consistent with')
  })

  it('R5: passes empirical_support evidence type', () => {
    const id = graph.addClaim(
      makeClaim({
        strength: {
          confidence: 0.8,
          evidenceType: 'empirical_support',
          vulnerabilityScore: 0.3,
        },
      }),
    )
    const result = canAdmit(id, graph, pool)
    // Should NOT fail on R5
    if (!result.admit) {
      expect(result.reason).not.toContain('Consistent with')
    }
  })

  // ── R6: Layer skips ───────────────────────────────

  it('R6: rejects when layer skip exists', () => {
    const obs = graph.addClaim(
      makeClaim({ epistemicLayer: 'observation', phase: 'admitted' }),
    )
    const expt = graph.addClaim(makeClaim({ epistemicLayer: 'exploitation' }))
    // exploitation depends on observation — skips explanation
    graph.addEdge({
      source: expt,
      target: obs,
      relation: 'depends_on',
      strength: 'strong',
    })
    const result = canAdmit(expt, graph, pool)
    expect(result.admit).toBe(false)
    expect(result.reason).toContain('Layer skip')
  })

  it('R6: passes with adjacent layer dependency', () => {
    const obs = graph.addClaim(
      makeClaim({ epistemicLayer: 'observation', phase: 'admitted' }),
    )
    const expl = graph.addClaim(makeClaim({ epistemicLayer: 'explanation' }))
    graph.addEdge({
      source: expl,
      target: obs,
      relation: 'depends_on',
      strength: 'strong',
    })
    const result = canAdmit(expl, graph, pool)
    // Should NOT fail on R6
    if (!result.admit) {
      expect(result.reason).not.toContain('Layer skip')
    }
  })

  // ── All pass / edge cases ─────────────────────────

  it('admits claim that passes all 6 rules', () => {
    // Create a fully compliant claim: hypothesis, has evidence, good confidence,
    // empirical_support, no deps, no layer skips
    const id = graph.addClaim(
      makeClaim({
        type: 'hypothesis',
        epistemicLayer: 'explanation',
        evidence: { grounded: ['ev1'], derived: ['ev2'] },
        strength: {
          confidence: 0.8,
          evidenceType: 'empirical_support',
          vulnerabilityScore: 0.2,
        },
      }),
    )
    const result = canAdmit(id, graph, pool)
    expect(result.admit).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('rejects nonexistent claim', () => {
    const result = canAdmit('nonexistent-id', graph, pool)
    expect(result.admit).toBe(false)
    expect(result.reason).toBe('Not found')
  })
})

describe('canAdmit (exploratory stance)', () => {
  let graph: ClaimGraph
  let pool: EvidencePoolManager

  beforeEach(() => {
    graph = new ClaimGraph()
    pool = new EvidencePoolManager()
  })

  // R1 unchanged in exploratory
  it('R1: still rejects claim with no evidence in exploratory', () => {
    const id = graph.addClaim(
      makeClaim({ evidence: { grounded: [], derived: [] } }),
    )
    const result = canAdmit(id, graph, pool, 'exploratory')
    expect(result.admit).toBe(false)
    expect(result.reason).toBe('No evidence')
  })

  // R2 relaxed: theorem with only one evidence type admitted
  it('R2: admits theorem with only derived evidence in exploratory', () => {
    const id = graph.addClaim(
      makeClaim({
        type: 'theorem',
        evidence: { grounded: [], derived: ['ev1'] },
        strength: {
          confidence: 0.8,
          evidenceType: 'empirical_support',
          vulnerabilityScore: 0.3,
        },
      }),
    )
    const result = canAdmit(id, graph, pool, 'exploratory')
    expect(result.admit).toBe(true)
  })

  it('R2: still rejects theorem with only derived evidence in standard', () => {
    const id = graph.addClaim(
      makeClaim({
        type: 'theorem',
        evidence: { grounded: [], derived: ['ev1'] },
        strength: {
          confidence: 0.8,
          evidenceType: 'empirical_support',
          vulnerabilityScore: 0.3,
        },
      }),
    )
    const result = canAdmit(id, graph, pool, 'standard')
    expect(result.admit).toBe(false)
    expect(result.reason).toContain('theorem needs both')
  })

  // R3 relaxed: allow under_investigation deps
  it('R3: admits when dependency is under_investigation in exploratory', () => {
    const dep = graph.addClaim(makeClaim({ phase: 'under_investigation' }))
    const id = graph.addClaim(makeClaim())
    graph.addEdge({
      source: id,
      target: dep,
      relation: 'depends_on',
      strength: 'strong',
    })
    const result = canAdmit(id, graph, pool, 'exploratory')
    // Should NOT fail on R3 (dep is under_investigation, which is allowed in exploratory)
    if (!result.admit) {
      expect(result.reason).not.toContain('Unadmitted deps')
    }
  })

  it('R3: still rejects proposed deps in exploratory', () => {
    const dep = graph.addClaim(makeClaim({ phase: 'proposed' }))
    const id = graph.addClaim(makeClaim())
    graph.addEdge({
      source: id,
      target: dep,
      relation: 'depends_on',
      strength: 'strong',
    })
    const result = canAdmit(id, graph, pool, 'exploratory')
    expect(result.admit).toBe(false)
    expect(result.reason).toContain('Unadmitted deps')
  })

  // R4 relaxed: threshold 0.4 instead of 0.6
  it('R4: admits confidence 0.45 in exploratory', () => {
    const id = graph.addClaim(
      makeClaim({
        strength: {
          confidence: 0.45,
          evidenceType: 'empirical_support',
          vulnerabilityScore: 0.3,
        },
      }),
    )
    const result = canAdmit(id, graph, pool, 'exploratory')
    // Should NOT fail on R4
    if (!result.admit) {
      expect(result.reason).not.toContain('< 0.4')
    }
  })

  it('R4: rejects confidence 0.39 in exploratory', () => {
    const id = graph.addClaim(
      makeClaim({
        strength: {
          confidence: 0.39,
          evidenceType: 'empirical_support',
          vulnerabilityScore: 0.3,
        },
      }),
    )
    const result = canAdmit(id, graph, pool, 'exploratory')
    expect(result.admit).toBe(false)
    expect(result.reason).toContain('< 0.4')
  })

  // R5 relaxed: consistent_with allowed
  it('R5: admits consistent_with evidence in exploratory', () => {
    const id = graph.addClaim(
      makeClaim({
        strength: {
          confidence: 0.8,
          evidenceType: 'consistent_with',
          vulnerabilityScore: 0.3,
        },
      }),
    )
    const result = canAdmit(id, graph, pool, 'exploratory')
    expect(result.admit).toBe(true)
  })

  // R6 unchanged in exploratory
  it('R6: still rejects layer skips in exploratory', () => {
    const obs = graph.addClaim(
      makeClaim({ epistemicLayer: 'observation', phase: 'admitted' }),
    )
    const expt = graph.addClaim(makeClaim({ epistemicLayer: 'exploitation' }))
    graph.addEdge({
      source: expt,
      target: obs,
      relation: 'depends_on',
      strength: 'strong',
    })
    const result = canAdmit(expt, graph, pool, 'exploratory')
    expect(result.admit).toBe(false)
    expect(result.reason).toContain('Layer skip')
  })

  // Full pass in exploratory with relaxed requirements
  it('admits claim that would fail standard but passes exploratory', () => {
    // Confidence 0.5 (fails R4 standard), consistent_with (fails R5 standard)
    const id = graph.addClaim(
      makeClaim({
        type: 'hypothesis',
        epistemicLayer: 'explanation',
        evidence: { grounded: ['ev1'], derived: [] },
        strength: {
          confidence: 0.5,
          evidenceType: 'consistent_with',
          vulnerabilityScore: 0.3,
        },
      }),
    )
    // Should fail in standard
    const standardResult = canAdmit(id, graph, pool, 'standard')
    expect(standardResult.admit).toBe(false)

    // Should pass in exploratory
    const exploratoryResult = canAdmit(id, graph, pool, 'exploratory')
    expect(exploratoryResult.admit).toBe(true)
  })
})

describe('suggestContraction', () => {
  let graph: ClaimGraph

  beforeEach(() => {
    graph = new ClaimGraph()
  })

  it('justification contracts to exploitation', () => {
    const id = graph.addClaim(
      makeClaim({
        epistemicLayer: 'justification',
        statement: 'Theorem X is justified',
      }),
    )
    const suggestion = suggestContraction(id, graph)
    expect(suggestion.current_layer).toBe('justification')
    expect(suggestion.contracted_layer).toBe('exploitation')
    expect(suggestion.destination).toBe('discussion_or_limitation')
    expect(suggestion.current_claim).toBe('Theorem X is justified')
  })

  it('exploitation contracts to explanation', () => {
    const id = graph.addClaim(makeClaim({ epistemicLayer: 'exploitation' }))
    const suggestion = suggestContraction(id, graph)
    expect(suggestion.current_layer).toBe('exploitation')
    expect(suggestion.contracted_layer).toBe('explanation')
    expect(suggestion.destination).toBe('discussion_or_limitation')
  })

  it('explanation contracts to observation', () => {
    const id = graph.addClaim(makeClaim({ epistemicLayer: 'explanation' }))
    const suggestion = suggestContraction(id, graph)
    expect(suggestion.current_layer).toBe('explanation')
    expect(suggestion.contracted_layer).toBe('observation')
    expect(suggestion.destination).toBe('main_text')
  })

  it('observation contracts to null', () => {
    const id = graph.addClaim(makeClaim({ epistemicLayer: 'observation' }))
    const suggestion = suggestContraction(id, graph)
    expect(suggestion.current_layer).toBe('observation')
    expect(suggestion.contracted_layer).toBeNull()
    expect(suggestion.destination).toBe('main_text')
  })

  it('strategy text is non-empty', () => {
    for (const layer of [
      'observation',
      'explanation',
      'exploitation',
      'justification',
    ] as const) {
      const id = graph.addClaim(makeClaim({ epistemicLayer: layer }))
      const suggestion = suggestContraction(id, graph)
      expect(suggestion.strategy.length).toBeGreaterThan(0)
    }
  })

  it('contracted_claim is null (placeholder for LLM)', () => {
    const id = graph.addClaim(makeClaim())
    const suggestion = suggestContraction(id, graph)
    expect(suggestion.contracted_claim).toBeNull()
  })

  it('throws for nonexistent claim', () => {
    expect(() => suggestContraction('nonexistent', graph)).toThrow(
      'Claim not found',
    )
  })
})
