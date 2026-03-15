import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { ClaimGraph } from '../../src/paper/claim-graph/index'
import type { ClaimInput } from '../../src/paper/claim-graph/index'

const TEST_DIR = join(process.cwd(), '.test-claim-graph')

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

describe('ClaimGraph', () => {
  let graph: ClaimGraph

  beforeEach(() => {
    graph = new ClaimGraph()
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true })
    }
  })

  // ── CRUD ──────────────────────────────────────────

  describe('CRUD', () => {
    it('addClaim returns UUID and getClaim retrieves it', () => {
      const id = graph.addClaim(makeClaim({ statement: 'A' }))
      expect(id).toBeTruthy()
      const claim = graph.getClaim(id)
      expect(claim).toBeDefined()
      expect(claim!.statement).toBe('A')
      expect(claim!.id).toBe(id)
      expect(claim!.created_at).toBeTruthy()
      expect(claim!.last_assessed_at).toBeTruthy()
      expect(claim!.assessment_history).toEqual([])
    })

    it('getClaim returns undefined for nonexistent ID', () => {
      expect(graph.getClaim('nonexistent')).toBeUndefined()
    })

    it('updateClaim modifies fields and updates last_assessed_at', () => {
      const id = graph.addClaim(makeClaim())
      const before = graph.getClaim(id)!.last_assessed_at

      // small delay to ensure timestamp differs
      const start = Date.now()
      while (Date.now() - start < 5) {
        /* spin */
      }

      graph.updateClaim(id, {
        phase: 'admitted',
        strength: {
          confidence: 0.9,
          evidenceType: 'theorem_support',
          vulnerabilityScore: 0.1,
        },
      })

      const updated = graph.getClaim(id)!
      expect(updated.phase).toBe('admitted')
      expect(updated.strength.confidence).toBe(0.9)
      expect(updated.last_assessed_at >= before).toBe(true)
    })

    it('updateClaim throws for nonexistent claim', () => {
      expect(() =>
        graph.updateClaim('nonexistent', { phase: 'admitted' }),
      ).toThrow('Claim not found')
    })

    it('removeClaim deletes claim and cascades edge removal', () => {
      const a = graph.addClaim(makeClaim({ statement: 'A' }))
      const b = graph.addClaim(makeClaim({ statement: 'B' }))
      graph.addEdge({
        source: a,
        target: b,
        relation: 'depends_on',
        strength: 'strong',
      })
      expect(graph.edgeCount).toBe(1)

      graph.removeClaim(b)
      expect(graph.getClaim(b)).toBeUndefined()
      expect(graph.edgeCount).toBe(0)
    })

    it('addEdge validates source/target exist', () => {
      const a = graph.addClaim(makeClaim())
      expect(() =>
        graph.addEdge({
          source: a,
          target: 'nonexistent',
          relation: 'supports',
          strength: 'moderate',
        }),
      ).toThrow('Target claim not found')

      expect(() =>
        graph.addEdge({
          source: 'nonexistent',
          target: a,
          relation: 'supports',
          strength: 'moderate',
        }),
      ).toThrow('Source claim not found')
    })

    it('removeEdge deletes edge', () => {
      const a = graph.addClaim(makeClaim())
      const b = graph.addClaim(makeClaim())
      const edgeId = graph.addEdge({
        source: a,
        target: b,
        relation: 'supports',
        strength: 'strong',
      })
      expect(graph.edgeCount).toBe(1)
      graph.removeEdge(edgeId)
      expect(graph.edgeCount).toBe(0)
    })
  })

  // ── Query ─────────────────────────────────────────

  describe('Query', () => {
    it('getClaimsByPhase returns correct subset', () => {
      graph.addClaim(makeClaim({ phase: 'proposed' }))
      graph.addClaim(makeClaim({ phase: 'admitted' }))
      graph.addClaim(makeClaim({ phase: 'admitted' }))
      graph.addClaim(makeClaim({ phase: 'rejected' }))

      expect(graph.getClaimsByPhase('proposed')).toHaveLength(1)
      expect(graph.getClaimsByPhase('admitted')).toHaveLength(2)
      expect(graph.getClaimsByPhase('rejected')).toHaveLength(1)
      expect(graph.getClaimsByPhase('demoted')).toHaveLength(0)
    })

    it('getClaimsByType returns correct subset', () => {
      graph.addClaim(makeClaim({ type: 'theorem' }))
      graph.addClaim(makeClaim({ type: 'theorem' }))
      graph.addClaim(makeClaim({ type: 'observation' }))

      expect(graph.getClaimsByType('theorem')).toHaveLength(2)
      expect(graph.getClaimsByType('observation')).toHaveLength(1)
      expect(graph.getClaimsByType('hypothesis')).toHaveLength(0)
    })

    it('getClaimsByLayer returns correct subset', () => {
      graph.addClaim(makeClaim({ epistemicLayer: 'observation' }))
      graph.addClaim(makeClaim({ epistemicLayer: 'justification' }))

      expect(graph.getClaimsByLayer('observation')).toHaveLength(1)
      expect(graph.getClaimsByLayer('justification')).toHaveLength(1)
      expect(graph.getClaimsByLayer('explanation')).toHaveLength(0)
    })

    it('getDependencies returns targets of depends_on edges', () => {
      const a = graph.addClaim(makeClaim({ statement: 'A' }))
      const b = graph.addClaim(makeClaim({ statement: 'B' }))
      const c = graph.addClaim(makeClaim({ statement: 'C' }))
      graph.addEdge({
        source: a,
        target: b,
        relation: 'depends_on',
        strength: 'strong',
      })
      graph.addEdge({
        source: a,
        target: c,
        relation: 'depends_on',
        strength: 'moderate',
      })
      // supports edge should not appear
      graph.addEdge({
        source: a,
        target: c,
        relation: 'supports',
        strength: 'strong',
      })

      const deps = graph.getDependencies(a)
      expect(deps).toHaveLength(2)
      expect(deps).toContain(b)
      expect(deps).toContain(c)
      expect(graph.getDependencies(b)).toHaveLength(0)
    })

    it('getEdgesOf returns all edges touching a claim', () => {
      const a = graph.addClaim(makeClaim())
      const b = graph.addClaim(makeClaim())
      const c = graph.addClaim(makeClaim())
      graph.addEdge({
        source: a,
        target: b,
        relation: 'supports',
        strength: 'strong',
      })
      graph.addEdge({
        source: c,
        target: a,
        relation: 'depends_on',
        strength: 'moderate',
      })
      graph.addEdge({
        source: b,
        target: c,
        relation: 'motivates',
        strength: 'weak',
      })

      expect(graph.getEdgesOf(a)).toHaveLength(2)
      expect(graph.getEdgesOf(b)).toHaveLength(2)
      expect(graph.getEdgesOf(c)).toHaveLength(2)
    })

    it('getEdgesWithin returns only edges within the set', () => {
      const a = graph.addClaim(makeClaim())
      const b = graph.addClaim(makeClaim())
      const c = graph.addClaim(makeClaim())
      graph.addEdge({
        source: a,
        target: b,
        relation: 'supports',
        strength: 'strong',
      })
      graph.addEdge({
        source: b,
        target: c,
        relation: 'depends_on',
        strength: 'strong',
      })

      const within = graph.getEdgesWithin([a, b])
      expect(within).toHaveLength(1)
      expect(within[0].source).toBe(a)
      expect(within[0].target).toBe(b)
    })
  })

  // ── cascadeAnalysis ───────────────────────────────

  describe('cascadeAnalysis', () => {
    it('follows dependency chain', () => {
      // A depends_on B depends_on C
      const c = graph.addClaim(makeClaim({ statement: 'C' }))
      const b = graph.addClaim(makeClaim({ statement: 'B' }))
      const a = graph.addClaim(makeClaim({ statement: 'A' }))
      graph.addEdge({
        source: a,
        target: b,
        relation: 'depends_on',
        strength: 'strong',
      })
      graph.addEdge({
        source: b,
        target: c,
        relation: 'depends_on',
        strength: 'strong',
      })

      // cascade of C: B depends on C, A depends on B
      const cascade = graph.cascadeAnalysis(c)
      expect(cascade).toHaveLength(2)
      expect(cascade).toContain(a)
      expect(cascade).toContain(b)

      // cascade of B: only A depends on B
      expect(graph.cascadeAnalysis(b)).toHaveLength(1)
      expect(graph.cascadeAnalysis(b)).toContain(a)

      // cascade of A: nothing depends on A
      expect(graph.cascadeAnalysis(a)).toHaveLength(0)
    })

    it('handles diamond dependency', () => {
      // A depends_on B, A depends_on C, B depends_on D, C depends_on D
      const d = graph.addClaim(makeClaim({ statement: 'D' }))
      const b = graph.addClaim(makeClaim({ statement: 'B' }))
      const c = graph.addClaim(makeClaim({ statement: 'C' }))
      const a = graph.addClaim(makeClaim({ statement: 'A' }))
      graph.addEdge({
        source: a,
        target: b,
        relation: 'depends_on',
        strength: 'strong',
      })
      graph.addEdge({
        source: a,
        target: c,
        relation: 'depends_on',
        strength: 'strong',
      })
      graph.addEdge({
        source: b,
        target: d,
        relation: 'depends_on',
        strength: 'strong',
      })
      graph.addEdge({
        source: c,
        target: d,
        relation: 'depends_on',
        strength: 'strong',
      })

      const cascade = graph.cascadeAnalysis(d)
      expect(cascade).toHaveLength(3)
      expect(cascade).toContain(a)
      expect(cascade).toContain(b)
      expect(cascade).toContain(c)
    })

    it('returns empty for claim with no dependents', () => {
      const id = graph.addClaim(makeClaim())
      expect(graph.cascadeAnalysis(id)).toHaveLength(0)
    })

    it('handles circular dependency without infinite loop', () => {
      const a = graph.addClaim(makeClaim({ statement: 'A' }))
      const b = graph.addClaim(makeClaim({ statement: 'B' }))
      graph.addEdge({
        source: a,
        target: b,
        relation: 'depends_on',
        strength: 'strong',
      })
      graph.addEdge({
        source: b,
        target: a,
        relation: 'depends_on',
        strength: 'strong',
      })

      const cascade = graph.cascadeAnalysis(a)
      expect(cascade).toHaveLength(1)
      expect(cascade).toContain(b)
    })
  })

  // ── findWeakestBridges ────────────────────────────

  describe('findWeakestBridges', () => {
    it('ranks low-confidence many-dependents claim higher', () => {
      // Weak foundation claim
      const foundation = graph.addClaim(
        makeClaim({
          statement: 'Weak foundation',
          strength: {
            confidence: 0.2,
            evidenceType: 'consistent_with',
            vulnerabilityScore: 0.8,
          },
        }),
      )
      // Strong leaf claim
      graph.addClaim(
        makeClaim({
          statement: 'Strong leaf',
          strength: {
            confidence: 0.95,
            evidenceType: 'theorem_support',
            vulnerabilityScore: 0.1,
          },
          evidence: {
            grounded: ['ev1', 'ev2'],
            derived: ['ev3'],
          },
        }),
      )
      // Claims depending on foundation
      const dep1 = graph.addClaim(makeClaim({ statement: 'D1' }))
      const dep2 = graph.addClaim(makeClaim({ statement: 'D2' }))
      graph.addEdge({
        source: dep1,
        target: foundation,
        relation: 'depends_on',
        strength: 'strong',
      })
      graph.addEdge({
        source: dep2,
        target: foundation,
        relation: 'depends_on',
        strength: 'strong',
      })

      const bridges = graph.findWeakestBridges()
      expect(bridges.length).toBeGreaterThan(0)
      // Foundation should be the weakest bridge
      expect(bridges[0].claim.statement).toBe('Weak foundation')
      expect(bridges[0].cascadeSize).toBe(2)
    })

    it('returns sorted descending by vulnerability', () => {
      graph.addClaim(
        makeClaim({
          strength: {
            confidence: 0.9,
            evidenceType: 'theorem_support',
            vulnerabilityScore: 0.1,
          },
        }),
      )
      graph.addClaim(
        makeClaim({
          strength: {
            confidence: 0.3,
            evidenceType: 'no_support',
            vulnerabilityScore: 0.7,
          },
        }),
      )
      graph.addClaim(
        makeClaim({
          strength: {
            confidence: 0.6,
            evidenceType: 'heuristic_motivation',
            vulnerabilityScore: 0.4,
          },
        }),
      )

      const bridges = graph.findWeakestBridges()
      for (let i = 1; i < bridges.length; i++) {
        expect(bridges[i - 1].vulnerability).toBeGreaterThanOrEqual(
          bridges[i].vulnerability,
        )
      }
    })

    it('returns empty for empty graph', () => {
      expect(graph.findWeakestBridges()).toHaveLength(0)
    })
  })

  // ── detectLayerSkips ──────────────────────────────

  describe('detectLayerSkips', () => {
    it('detects observation → exploitation skip', () => {
      const obs = graph.addClaim(
        makeClaim({
          epistemicLayer: 'observation',
          statement: 'We observe X',
        }),
      )
      const expt = graph.addClaim(
        makeClaim({
          epistemicLayer: 'exploitation',
          statement: 'We exploit X',
        }),
      )
      graph.addEdge({
        source: expt,
        target: obs,
        relation: 'depends_on',
        strength: 'strong',
      })

      const skips = graph.detectLayerSkips()
      expect(skips).toHaveLength(1)
      expect(skips[0].description).toContain('Layer skip')
    })

    it('detects observation → justification skip', () => {
      const obs = graph.addClaim(makeClaim({ epistemicLayer: 'observation' }))
      const just = graph.addClaim(
        makeClaim({ epistemicLayer: 'justification' }),
      )
      graph.addEdge({
        source: just,
        target: obs,
        relation: 'supports',
        strength: 'moderate',
      })

      expect(graph.detectLayerSkips()).toHaveLength(1)
    })

    it('does NOT flag adjacent layers', () => {
      const obs = graph.addClaim(makeClaim({ epistemicLayer: 'observation' }))
      const expl = graph.addClaim(makeClaim({ epistemicLayer: 'explanation' }))
      graph.addEdge({
        source: expl,
        target: obs,
        relation: 'depends_on',
        strength: 'strong',
      })

      expect(graph.detectLayerSkips()).toHaveLength(0)
    })

    it('does NOT flag explanation → exploitation', () => {
      const expl = graph.addClaim(makeClaim({ epistemicLayer: 'explanation' }))
      const expt = graph.addClaim(makeClaim({ epistemicLayer: 'exploitation' }))
      graph.addEdge({
        source: expt,
        target: expl,
        relation: 'depends_on',
        strength: 'strong',
      })

      expect(graph.detectLayerSkips()).toHaveLength(0)
    })

    it('ignores non-depends_on/supports edges', () => {
      const obs = graph.addClaim(makeClaim({ epistemicLayer: 'observation' }))
      const just = graph.addClaim(
        makeClaim({ epistemicLayer: 'justification' }),
      )
      graph.addEdge({
        source: obs,
        target: just,
        relation: 'motivates',
        strength: 'weak',
      })

      expect(graph.detectLayerSkips()).toHaveLength(0)
    })
  })

  describe('detectLayerSkipsFor', () => {
    it('only returns skips involving the specified claim', () => {
      const obs = graph.addClaim(makeClaim({ epistemicLayer: 'observation' }))
      const expt = graph.addClaim(makeClaim({ epistemicLayer: 'exploitation' }))
      const expl = graph.addClaim(makeClaim({ epistemicLayer: 'explanation' }))
      const just = graph.addClaim(
        makeClaim({ epistemicLayer: 'justification' }),
      )

      // Skip: obs → expt
      graph.addEdge({
        source: expt,
        target: obs,
        relation: 'depends_on',
        strength: 'strong',
      })
      // Skip: expl → just (not a skip, adjacent)
      // Actually explanation(1) → justification(3) — that IS a skip
      // Let's use obs → just instead
      graph.addEdge({
        source: just,
        target: obs,
        relation: 'depends_on',
        strength: 'strong',
      })
      // Non-skip: expl → expt
      graph.addEdge({
        source: expt,
        target: expl,
        relation: 'depends_on',
        strength: 'strong',
      })

      // 2 total skips
      expect(graph.detectLayerSkips()).toHaveLength(2)
      // Only 1 skip involving expt (obs→expt)
      const forExpt = graph.detectLayerSkipsFor(expt)
      expect(forExpt).toHaveLength(1)
    })
  })

  // ── findContradictions ────────────────────────────

  describe('findContradictions', () => {
    it('finds claims connected by contradicts edges', () => {
      const a = graph.addClaim(makeClaim({ statement: 'A' }))
      const b = graph.addClaim(makeClaim({ statement: 'B' }))
      graph.addEdge({
        source: a,
        target: b,
        relation: 'contradicts',
        strength: 'strong',
      })

      const contradictions = graph.findContradictions()
      expect(contradictions).toHaveLength(2)
      const ids = contradictions.map(c => c.claim.id)
      expect(ids).toContain(a)
      expect(ids).toContain(b)
    })

    it('returns empty when no contradictions', () => {
      graph.addClaim(makeClaim())
      graph.addClaim(makeClaim())
      expect(graph.findContradictions()).toHaveLength(0)
    })
  })

  // ── getStatistics ─────────────────────────────────

  describe('getStatistics', () => {
    it('returns correct counts', () => {
      graph.addClaim(
        makeClaim({
          phase: 'proposed',
          epistemicLayer: 'observation',
        }),
      )
      graph.addClaim(
        makeClaim({
          phase: 'admitted',
          epistemicLayer: 'explanation',
        }),
      )
      graph.addClaim(
        makeClaim({
          phase: 'admitted',
          epistemicLayer: 'justification',
        }),
      )
      const a = graph.addClaim(
        makeClaim({
          phase: 'rejected',
          epistemicLayer: 'exploitation',
        }),
      )
      const b = graph.addClaim(
        makeClaim({
          phase: 'under_investigation',
          epistemicLayer: 'observation',
        }),
      )
      graph.addEdge({
        source: a,
        target: b,
        relation: 'depends_on',
        strength: 'strong',
      })
      graph.addEdge({
        source: b,
        target: a,
        relation: 'supports',
        strength: 'moderate',
      })

      const stats = graph.getStatistics()
      expect(stats.total).toBe(5)
      expect(stats.proposed).toBe(1)
      expect(stats.admitted).toBe(2)
      expect(stats.rejected).toBe(1)
      expect(stats.investigating).toBe(1)
      expect(stats.observations).toBe(2)
      expect(stats.explanations).toBe(1)
      expect(stats.exploitations).toBe(1)
      expect(stats.justifications).toBe(1)
      expect(stats.totalEdges).toBe(2)
      expect(stats.dependsOn).toBe(1)
      expect(stats.supports).toBe(1)
    })

    it('returns all zeros for empty graph', () => {
      const stats = graph.getStatistics()
      expect(stats.total).toBe(0)
      expect(stats.totalEdges).toBe(0)
      expect(stats.admitted).toBe(0)
      expect(stats.observations).toBe(0)
    })
  })

  // ── getRecentlyChanged ────────────────────────────

  describe('getRecentlyChanged', () => {
    it('includes recently assessed claims', () => {
      graph.addClaim(makeClaim({ statement: 'Recent' }))
      const recent = graph.getRecentlyChanged(1)
      expect(recent).toHaveLength(1)
      expect(recent[0].claim.statement).toBe('Recent')
    })

    it('excludes old claims', () => {
      const id = graph.addClaim(makeClaim())
      // Manually backdate the assessment
      const claim = graph.getClaim(id)!
      graph.updateClaim(id, {
        last_assessed_at: new Date(Date.now() - 10 * 3600 * 1000).toISOString(),
      })

      // updateClaim resets last_assessed_at to now, so we need
      // to use the constructor to set an old date
      const oldGraph = new ClaimGraph({
        claims: [
          {
            ...claim,
            last_assessed_at: new Date(
              Date.now() - 10 * 3600 * 1000,
            ).toISOString(),
          },
        ],
        edges: [],
      })

      expect(oldGraph.getRecentlyChanged(2)).toHaveLength(0)
    })

    it('shows assessment history in change description', () => {
      const id = graph.addClaim(makeClaim())
      graph.updateClaim(id, {
        assessment_history: [
          {
            timestamp: new Date().toISOString(),
            assessor: 'skeptic',
            previous_strength: {
              confidence: 0.5,
              evidenceType: 'heuristic_motivation',
              vulnerabilityScore: 0.5,
            },
            new_strength: {
              confidence: 0.3,
              evidenceType: 'consistent_with',
              vulnerabilityScore: 0.7,
            },
            reason: 'Insufficient evidence',
          },
        ],
      })

      const recent = graph.getRecentlyChanged(1)
      expect(recent).toHaveLength(1)
      expect(recent[0].change).toContain('skeptic')
      expect(recent[0].change).toContain('0.50')
      expect(recent[0].change).toContain('0.30')
    })
  })

  // ── Serialization ─────────────────────────────────

  describe('Serialization', () => {
    it('round-trips through toJSON/fromJSON', () => {
      const a = graph.addClaim(
        makeClaim({
          statement: 'Claim A',
          strength: {
            confidence: 0.7777,
            evidenceType: 'empirical_support',
            vulnerabilityScore: 0.2345,
          },
          evidence: {
            grounded: ['ev1', 'ev2'],
            derived: ['ev3'],
          },
        }),
      )
      const b = graph.addClaim(
        makeClaim({
          statement: 'Claim B',
          type: 'theorem',
          epistemicLayer: 'justification',
          phase: 'admitted',
        }),
      )
      graph.addEdge({
        source: a,
        target: b,
        relation: 'supports',
        strength: 'strong',
        note: 'test note',
      })

      const json = graph.toJSON()
      const restored = ClaimGraph.fromJSON(json)

      expect(restored.claimCount).toBe(2)
      expect(restored.edgeCount).toBe(1)

      const restoredA = restored.getClaim(a)!
      expect(restoredA.statement).toBe('Claim A')
      expect(restoredA.strength.confidence).toBe(0.7777)
      expect(restoredA.strength.vulnerabilityScore).toBe(0.2345)
      expect(restoredA.evidence.grounded).toEqual(['ev1', 'ev2'])

      const restoredB = restored.getClaim(b)!
      expect(restoredB.type).toBe('theorem')
      expect(restoredB.phase).toBe('admitted')

      const edges = restored.allEdges
      expect(edges[0].note).toBe('test note')
    })

    it('handles empty graph serialization', () => {
      const json = graph.toJSON()
      expect(json.claims).toEqual([])
      expect(json.edges).toEqual([])

      const restored = ClaimGraph.fromJSON(json)
      expect(restored.claimCount).toBe(0)
      expect(restored.edgeCount).toBe(0)
    })
  })

  // ── Disk Persistence ──────────────────────────────

  describe('Disk persistence', () => {
    it('save and load round-trip', () => {
      mkdirSync(TEST_DIR, { recursive: true })

      graph.addClaim(
        makeClaim({
          statement: 'Persisted claim',
          phase: 'admitted',
        }),
      )
      graph.save(TEST_DIR)

      expect(
        existsSync(join(TEST_DIR, '.claude-paper', 'claim-graph.json')),
      ).toBe(true)

      const loaded = ClaimGraph.load(TEST_DIR)
      expect(loaded).not.toBeNull()
      expect(loaded!.claimCount).toBe(1)
      expect(loaded!.allClaims[0].statement).toBe('Persisted claim')
    })

    it('load returns null for nonexistent path', () => {
      expect(ClaimGraph.load('/tmp/nonexistent-dir-claim-graph')).toBeNull()
    })
  })

  // ── Edge Cases ────────────────────────────────────

  describe('Edge cases', () => {
    it('empty graph: all methods return empty/zero', () => {
      expect(graph.claimCount).toBe(0)
      expect(graph.edgeCount).toBe(0)
      expect(graph.allClaims).toEqual([])
      expect(graph.allEdges).toEqual([])
      expect(graph.getClaimsByPhase('proposed')).toEqual([])
      expect(graph.findWeakestBridges()).toEqual([])
      expect(graph.findContradictions()).toEqual([])
      expect(graph.detectLayerSkips()).toEqual([])
      expect(graph.getRecentlyChanged(24)).toEqual([])
      expect(graph.getStatistics().total).toBe(0)
    })

    it('single claim, no edges', () => {
      const id = graph.addClaim(makeClaim())
      expect(graph.claimCount).toBe(1)
      expect(graph.cascadeAnalysis(id)).toHaveLength(0)
      expect(graph.findWeakestBridges()).toHaveLength(1)
      expect(graph.getDependencies(id)).toEqual([])
      expect(graph.getEdgesOf(id)).toEqual([])
    })

    it('convenience getters reflect mutations', () => {
      expect(graph.claimCount).toBe(0)
      const id = graph.addClaim(makeClaim())
      expect(graph.claimCount).toBe(1)
      graph.removeClaim(id)
      expect(graph.claimCount).toBe(0)
    })
  })
})
