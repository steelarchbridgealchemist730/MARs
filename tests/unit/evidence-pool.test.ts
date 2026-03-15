import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import {
  EvidencePoolManager,
  type GroundedInput,
  type DerivedInput,
} from '../../src/paper/evidence-pool'

const TEST_DIR = join(process.cwd(), '.test-evidence-pool')

function makeGrounded(overrides?: Partial<GroundedInput>): GroundedInput {
  return {
    claim: 'Test grounded claim',
    source_type: 'literature',
    source_ref: 'doi:10.1234/test',
    verified: false,
    supports_claims: [],
    contradicts_claims: [],
    acquired_by: 'test-agent',
    ...overrides,
  }
}

function makeDerived(overrides?: Partial<DerivedInput>): DerivedInput {
  return {
    claim: 'Test derived claim',
    method: 'experiment',
    reproducible: true,
    artifact_id: 'artifact-001',
    assumptions: ['assumption-1'],
    supports_claims: [],
    contradicts_claims: [],
    produced_by: 'test-agent',
    ...overrides,
  }
}

describe('EvidencePoolManager', () => {
  let pool: EvidencePoolManager

  beforeEach(() => {
    pool = new EvidencePoolManager()
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true })
    }
  })

  // ── addGrounded / addDerived ──────────────────────────

  describe('addGrounded / addDerived', () => {
    it('addGrounded returns UUID and sets acquired_at', () => {
      const id = pool.addGrounded(makeGrounded())
      expect(id).toBeTruthy()
      expect(id.length).toBeGreaterThan(0)

      const entry = pool.getGrounded(id)
      expect(entry).toBeDefined()
      expect(entry!.id).toBe(id)
      expect(entry!.acquired_at).toBeTruthy()
      // Verify ISO timestamp
      expect(new Date(entry!.acquired_at).toISOString()).toBe(
        entry!.acquired_at,
      )
    })

    it('addDerived returns UUID and sets produced_at', () => {
      const id = pool.addDerived(makeDerived())
      expect(id).toBeTruthy()

      const entry = pool.getDerived(id)
      expect(entry).toBeDefined()
      expect(entry!.id).toBe(id)
      expect(entry!.produced_at).toBeTruthy()
      expect(new Date(entry!.produced_at).toISOString()).toBe(
        entry!.produced_at,
      )
    })

    it('entries are retrievable via getGrounded / getDerived', () => {
      const gId = pool.addGrounded(makeGrounded({ claim: 'Grounded A' }))
      const dId = pool.addDerived(makeDerived({ claim: 'Derived A' }))

      expect(pool.getGrounded(gId)!.claim).toBe('Grounded A')
      expect(pool.getDerived(dId)!.claim).toBe('Derived A')
    })

    it('multiple adds accumulate', () => {
      pool.addGrounded(makeGrounded())
      pool.addGrounded(makeGrounded())
      pool.addDerived(makeDerived())

      expect(pool.pool.grounded).toHaveLength(2)
      expect(pool.pool.derived).toHaveLength(1)
    })

    it('getGrounded returns undefined for unknown ID', () => {
      expect(pool.getGrounded('nonexistent')).toBeUndefined()
    })

    it('getDerived returns undefined for unknown ID', () => {
      expect(pool.getDerived('nonexistent')).toBeUndefined()
    })
  })

  // ── evidenceFor ───────────────────────────────────────

  describe('evidenceFor', () => {
    it('returns grounded entries supporting a claim', () => {
      pool.addGrounded(makeGrounded({ supports_claims: ['claim-1'] }))
      pool.addGrounded(makeGrounded({ supports_claims: ['claim-2'] }))

      const result = pool.evidenceFor('claim-1')
      expect(result.grounded).toHaveLength(1)
      expect(result.grounded[0].supports_claims).toContain('claim-1')
    })

    it('returns derived entries supporting a claim', () => {
      pool.addDerived(makeDerived({ supports_claims: ['claim-1'] }))

      const result = pool.evidenceFor('claim-1')
      expect(result.derived).toHaveLength(1)
    })

    it('returns empty for unknown claim ID', () => {
      pool.addGrounded(makeGrounded({ supports_claims: ['claim-1'] }))

      const result = pool.evidenceFor('unknown')
      expect(result.grounded).toEqual([])
      expect(result.derived).toEqual([])
    })

    it('evidence supporting multiple claims appears for each', () => {
      pool.addGrounded(
        makeGrounded({
          supports_claims: ['claim-1', 'claim-2'],
        }),
      )

      expect(pool.evidenceFor('claim-1').grounded).toHaveLength(1)
      expect(pool.evidenceFor('claim-2').grounded).toHaveLength(1)
    })
  })

  // ── evidenceAgainst ───────────────────────────────────

  describe('evidenceAgainst', () => {
    it('returns entries contradicting a claim', () => {
      pool.addGrounded(makeGrounded({ contradicts_claims: ['claim-1'] }))
      pool.addDerived(makeDerived({ contradicts_claims: ['claim-1'] }))

      const result = pool.evidenceAgainst('claim-1')
      expect(result.grounded).toHaveLength(1)
      expect(result.derived).toHaveLength(1)
    })

    it('returns empty for claim with no contradictions', () => {
      pool.addGrounded(makeGrounded({ supports_claims: ['claim-1'] }))

      const result = pool.evidenceAgainst('claim-1')
      expect(result.grounded).toEqual([])
      expect(result.derived).toEqual([])
    })
  })

  // ── coverageRate ──────────────────────────────────────

  describe('coverageRate', () => {
    it('claim with both grounded + derived support is covered (no type map)', () => {
      pool.addGrounded(makeGrounded({ supports_claims: ['c1'] }))
      pool.addDerived(makeDerived({ supports_claims: ['c1'] }))

      // Without claimTypes, non-typed claims need either → covered
      expect(pool.coverageRate(['c1'])).toBe(1)
    })

    it('claim with only grounded is covered when no type map (needs either)', () => {
      pool.addGrounded(makeGrounded({ supports_claims: ['c1'] }))

      // Without claimTypes, default = needs either → covered
      expect(pool.coverageRate(['c1'])).toBe(1)
    })

    it('claim with only derived is covered when no type map (needs either)', () => {
      pool.addDerived(makeDerived({ supports_claims: ['c1'] }))

      expect(pool.coverageRate(['c1'])).toBe(1)
    })

    it('claim with neither is not covered', () => {
      expect(pool.coverageRate(['c1'])).toBe(0)
    })

    it('empty claims array returns 0', () => {
      expect(pool.coverageRate([])).toBe(0)
    })

    it('theorem claim needs both grounded + derived', () => {
      const types = new Map([['c1', 'theorem']])
      pool.addGrounded(makeGrounded({ supports_claims: ['c1'] }))

      // Only grounded → not covered for theorem
      expect(pool.coverageRate(['c1'], types)).toBe(0)

      // Add derived → now covered
      pool.addDerived(makeDerived({ supports_claims: ['c1'] }))
      expect(pool.coverageRate(['c1'], types)).toBe(1)
    })

    it('novelty claim needs both grounded + derived', () => {
      const types = new Map([['c1', 'novelty']])
      pool.addDerived(makeDerived({ supports_claims: ['c1'] }))

      // Only derived → not covered for novelty
      expect(pool.coverageRate(['c1'], types)).toBe(0)

      pool.addGrounded(makeGrounded({ supports_claims: ['c1'] }))
      expect(pool.coverageRate(['c1'], types)).toBe(1)
    })

    it('hypothesis claim needs only either evidence type', () => {
      const types = new Map([['c1', 'hypothesis']])
      pool.addGrounded(makeGrounded({ supports_claims: ['c1'] }))

      expect(pool.coverageRate(['c1'], types)).toBe(1)
    })

    it('mixed claim types: type-aware coverage', () => {
      const types = new Map([
        ['c1', 'theorem'],
        ['c2', 'hypothesis'],
        ['c3', 'novelty'],
        ['c4', 'observation'],
      ])

      // c1 (theorem): both → covered
      pool.addGrounded(makeGrounded({ supports_claims: ['c1'] }))
      pool.addDerived(makeDerived({ supports_claims: ['c1'] }))

      // c2 (hypothesis): only grounded → covered (needs either)
      pool.addGrounded(makeGrounded({ supports_claims: ['c2'] }))

      // c3 (novelty): only grounded → NOT covered (needs both)
      pool.addGrounded(makeGrounded({ supports_claims: ['c3'] }))

      // c4 (observation): nothing → NOT covered

      // 2 of 4 covered
      expect(pool.coverageRate(['c1', 'c2', 'c3', 'c4'], types)).toBe(0.5)
    })
  })

  // ── summary ───────────────────────────────────────────

  describe('summary', () => {
    it('returns correct counts', () => {
      pool.addGrounded(makeGrounded({ verified: true }))
      pool.addGrounded(makeGrounded({ verified: false }))
      pool.addGrounded(
        makeGrounded({
          verified: true,
          contradicts_claims: ['c1'],
        }),
      )
      pool.addDerived(makeDerived({ reproducible: true }))
      pool.addDerived(
        makeDerived({
          reproducible: false,
          contradicts_claims: ['c2'],
        }),
      )

      const s = pool.summary()
      expect(s.total_grounded).toBe(3)
      expect(s.verified_grounded).toBe(2)
      expect(s.total_derived).toBe(2)
      expect(s.reproducible_derived).toBe(1)
      expect(s.total_contradictions).toBe(2)
    })

    it('empty pool returns all zeros', () => {
      const s = pool.summary()
      expect(s.total_grounded).toBe(0)
      expect(s.verified_grounded).toBe(0)
      expect(s.total_derived).toBe(0)
      expect(s.reproducible_derived).toBe(0)
      expect(s.total_contradictions).toBe(0)
    })
  })

  // ── Serialization round-trip ──────────────────────────

  describe('Serialization', () => {
    it('save creates evidence-pool.json and load restores it', () => {
      mkdirSync(TEST_DIR, { recursive: true })

      const gId = pool.addGrounded(
        makeGrounded({
          claim: 'Persisted grounded',
          verified: true,
          source_ref: 'doi:10.5678/abc',
          supports_claims: ['c1', 'c2'],
        }),
      )
      const dId = pool.addDerived(
        makeDerived({
          claim: 'Persisted derived',
          method: 'proof',
          reproducible: false,
          assumptions: ['a1', 'a2'],
          contradicts_claims: ['c3'],
        }),
      )

      pool.save(TEST_DIR)

      expect(
        existsSync(join(TEST_DIR, '.claude-paper', 'evidence-pool.json')),
      ).toBe(true)

      const loaded = EvidencePoolManager.load(TEST_DIR)
      expect(loaded).not.toBeNull()

      const g = loaded!.getGrounded(gId)!
      expect(g.claim).toBe('Persisted grounded')
      expect(g.verified).toBe(true)
      expect(g.source_ref).toBe('doi:10.5678/abc')
      expect(g.supports_claims).toEqual(['c1', 'c2'])

      const d = loaded!.getDerived(dId)!
      expect(d.claim).toBe('Persisted derived')
      expect(d.method).toBe('proof')
      expect(d.reproducible).toBe(false)
      expect(d.assumptions).toEqual(['a1', 'a2'])
      expect(d.contradicts_claims).toEqual(['c3'])
    })

    it('load returns null for missing path', () => {
      expect(
        EvidencePoolManager.load('/tmp/nonexistent-dir-evidence-pool'),
      ).toBeNull()
    })
  })

  // ── Edge cases ────────────────────────────────────────

  describe('Edge cases', () => {
    it('empty pool: all queries return empty, coverageRate = 0, summary = all zeros', () => {
      expect(pool.pool.grounded).toEqual([])
      expect(pool.pool.derived).toEqual([])
      expect(pool.evidenceFor('any').grounded).toEqual([])
      expect(pool.evidenceFor('any').derived).toEqual([])
      expect(pool.evidenceAgainst('any').grounded).toEqual([])
      expect(pool.evidenceAgainst('any').derived).toEqual([])
      expect(pool.coverageRate([])).toBe(0)
      expect(pool.coverageRate(['c1'])).toBe(0)
      expect(pool.summary().total_grounded).toBe(0)
    })

    it('evidence referencing nonexistent claim IDs does not crash', () => {
      pool.addGrounded(
        makeGrounded({
          supports_claims: ['fake-claim-1'],
          contradicts_claims: ['fake-claim-2'],
        }),
      )
      pool.addDerived(
        makeDerived({
          supports_claims: ['fake-claim-3'],
        }),
      )

      // No crash — pool doesn't validate claim existence
      expect(pool.evidenceFor('fake-claim-1').grounded).toHaveLength(1)
      expect(pool.evidenceAgainst('fake-claim-2').grounded).toHaveLength(1)
      expect(pool.coverageRate(['fake-claim-1'])).toBe(1) // only grounded, but no type map → needs either
      expect(pool.summary().total_grounded).toBe(1)
      expect(pool.summary().total_derived).toBe(1)
    })
  })
})
