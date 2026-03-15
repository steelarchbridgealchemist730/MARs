import { describe, test, expect } from 'bun:test'
import { ClaimGraph, type ClaimInput } from '../../src/paper/claim-graph/index'
import type { Claim, ClaimPhase } from '../../src/paper/claim-graph/types'
import { EvidencePoolManager } from '../../src/paper/evidence-pool'
import {
  groupClaimsByPhase,
  buildClaimLine,
  getAdmissionStatuses,
  getContractionCandidates,
} from '../../src/ui/components/viewer/panels/ClaimGraphPanel'

function makeClaimInput(
  phase: ClaimPhase,
  opts?: {
    type?: Claim['type']
    confidence?: number
    epistemicLayer?: Claim['epistemicLayer']
    statement?: string
    evidenceType?: Claim['strength']['evidenceType']
    grounded?: string[]
    derived?: string[]
  },
): ClaimInput & { forcePhase: ClaimPhase } {
  return {
    type: opts?.type ?? 'hypothesis',
    epistemicLayer: opts?.epistemicLayer ?? 'explanation',
    statement: opts?.statement ?? `Claim in ${phase} phase`,
    phase: 'proposed',
    evidence: {
      grounded: opts?.grounded ?? [],
      derived: opts?.derived ?? [],
    },
    strength: {
      confidence: opts?.confidence ?? 0.7,
      evidenceType: opts?.evidenceType ?? 'empirical_support',
      vulnerabilityScore: 0.3,
    },
    created_by: 'test',
    forcePhase: phase,
  }
}

function buildGraph(inputs: ReturnType<typeof makeClaimInput>[]): {
  graph: ClaimGraph
  claimIds: string[]
} {
  const graph = new ClaimGraph()
  const claimIds: string[] = []
  for (const c of inputs) {
    const { forcePhase, ...input } = c
    const id = graph.addClaim(input)
    claimIds.push(id)
    if (forcePhase !== 'proposed') {
      graph.updateClaim(id, { phase: forcePhase })
    }
  }
  return { graph, claimIds }
}

// ── groupClaimsByPhase ──────────────────────────────────

describe('groupClaimsByPhase', () => {
  test('groups claims by phase and sorts by confidence descending', () => {
    const { graph } = buildGraph([
      makeClaimInput('admitted', { confidence: 0.8, statement: 'A' }),
      makeClaimInput('admitted', { confidence: 0.95, statement: 'B' }),
      makeClaimInput('proposed', { confidence: 0.5, statement: 'C' }),
      makeClaimInput('under_investigation', {
        confidence: 0.6,
        statement: 'D',
      }),
    ])

    const grouped = groupClaimsByPhase(graph.allClaims)

    expect(grouped.size).toBe(3)

    const admitted = grouped.get('admitted')!
    expect(admitted).toHaveLength(2)
    expect(admitted[0].statement).toBe('B') // 0.95 first
    expect(admitted[1].statement).toBe('A') // 0.8 second

    const proposed = grouped.get('proposed')!
    expect(proposed).toHaveLength(1)
    expect(proposed[0].statement).toBe('C')

    const investigating = grouped.get('under_investigation')!
    expect(investigating).toHaveLength(1)
    expect(investigating[0].statement).toBe('D')
  })

  test('omits empty phase groups', () => {
    const { graph } = buildGraph([
      makeClaimInput('admitted', { confidence: 0.9 }),
    ])
    const grouped = groupClaimsByPhase(graph.allClaims)

    expect(grouped.has('admitted')).toBe(true)
    expect(grouped.has('proposed')).toBe(false)
    expect(grouped.has('rejected')).toBe(false)
  })

  test('empty claims returns empty map', () => {
    const grouped = groupClaimsByPhase([])
    expect(grouped.size).toBe(0)
  })

  test('includes all phase types when present', () => {
    const { graph } = buildGraph([
      makeClaimInput('admitted'),
      makeClaimInput('proposed'),
      makeClaimInput('under_investigation'),
      makeClaimInput('demoted'),
      makeClaimInput('rejected'),
      makeClaimInput('retracted'),
    ])

    const grouped = groupClaimsByPhase(graph.allClaims)
    expect(grouped.size).toBe(6)
  })
})

// ── buildClaimLine ─────────────────────────────────────

describe('buildClaimLine', () => {
  test('shows phase icon, type, statement, and confidence', () => {
    const { graph } = buildGraph([
      makeClaimInput('admitted', {
        type: 'theorem',
        confidence: 0.92,
        statement: 'Main convergence result',
      }),
    ])
    const claim = graph.allClaims[0]
    const line = buildClaimLine(claim, 60)

    expect(line).toContain('+')
    expect(line).toContain('[theorem]')
    expect(line).toContain('Main convergence result')
    expect(line).toContain('0.92')
  })

  test('truncates long statements to fit width', () => {
    const longStatement = 'A'.repeat(200)
    const { graph } = buildGraph([
      makeClaimInput('proposed', { statement: longStatement }),
    ])
    const claim = graph.allClaims[0]
    const line = buildClaimLine(claim, 50)

    expect(line.length).toBeLessThanOrEqual(60) // some padding allowance
    expect(line).toContain('...')
  })

  test('uses correct icon for each phase', () => {
    const phases: ClaimPhase[] = [
      'admitted',
      'proposed',
      'under_investigation',
      'demoted',
      'rejected',
      'retracted',
    ]
    const expectedIcons: Record<ClaimPhase, string> = {
      admitted: '+',
      proposed: '?',
      under_investigation: '~',
      demoted: 'v',
      rejected: 'x',
      retracted: '-',
    }

    for (const phase of phases) {
      const { graph } = buildGraph([
        makeClaimInput(phase, { statement: `Test ${phase}` }),
      ])
      const claim = graph.allClaims[0]
      const line = buildClaimLine(claim, 60)
      expect(line.startsWith(expectedIcons[phase])).toBe(true)
    }
  })
})

// ── getAdmissionStatuses ───────────────────────────────

describe('getAdmissionStatuses', () => {
  test('returns decisions for non-admitted claims only', () => {
    const { graph } = buildGraph([
      makeClaimInput('admitted', {
        confidence: 0.9,
        grounded: ['e1'],
        derived: ['e2'],
      }),
      makeClaimInput('proposed', { confidence: 0.7, grounded: ['e3'] }),
      makeClaimInput('under_investigation', { confidence: 0.5 }),
    ])
    const pool = new EvidencePoolManager({ grounded: [], derived: [] })

    const statuses = getAdmissionStatuses(graph, pool)

    // Should only include non-admitted claims (2 of 3)
    expect(statuses).toHaveLength(2)
    expect(statuses.every(s => s.claim.phase !== 'admitted')).toBe(true)
  })

  test('calls canAdmit for each non-admitted claim', () => {
    const { graph } = buildGraph([
      makeClaimInput('proposed', { confidence: 0.3 }), // too low confidence
    ])
    const pool = new EvidencePoolManager({ grounded: [], derived: [] })

    const statuses = getAdmissionStatuses(graph, pool)

    expect(statuses).toHaveLength(1)
    expect(statuses[0].decision.admit).toBe(false)
  })

  test('empty graph returns empty array', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager({ grounded: [], derived: [] })

    const statuses = getAdmissionStatuses(graph, pool)
    expect(statuses).toHaveLength(0)
  })
})

// ── getContractionCandidates ───────────────────────────

describe('getContractionCandidates', () => {
  test('excludes admitted, rejected, retracted, and observation claims', () => {
    const { graph } = buildGraph([
      makeClaimInput('admitted', { epistemicLayer: 'explanation' }),
      makeClaimInput('rejected', { epistemicLayer: 'explanation' }),
      makeClaimInput('retracted', { epistemicLayer: 'explanation' }),
      makeClaimInput('proposed', { epistemicLayer: 'observation' }), // excluded: observation
      makeClaimInput('proposed', { epistemicLayer: 'explanation' }), // included
      makeClaimInput('under_investigation', { epistemicLayer: 'exploitation' }), // included
    ])

    const candidates = getContractionCandidates(graph)

    expect(candidates).toHaveLength(2)
    expect(
      candidates.every(
        c =>
          c.claim.phase !== 'admitted' &&
          c.claim.phase !== 'rejected' &&
          c.claim.phase !== 'retracted' &&
          c.claim.epistemicLayer !== 'observation',
      ),
    ).toBe(true)
  })

  test('returns contraction suggestions with strategy', () => {
    const { graph } = buildGraph([
      makeClaimInput('proposed', { epistemicLayer: 'exploitation' }),
    ])

    const candidates = getContractionCandidates(graph)

    expect(candidates).toHaveLength(1)
    expect(candidates[0].suggestion.current_layer).toBe('exploitation')
    expect(candidates[0].suggestion.contracted_layer).toBe('explanation')
    expect(candidates[0].suggestion.strategy).toBeTruthy()
  })

  test('empty graph returns empty array', () => {
    const graph = new ClaimGraph()
    const candidates = getContractionCandidates(graph)
    expect(candidates).toHaveLength(0)
  })

  test('graph with only observations returns empty array', () => {
    const { graph } = buildGraph([
      makeClaimInput('proposed', { epistemicLayer: 'observation' }),
      makeClaimInput('under_investigation', { epistemicLayer: 'observation' }),
    ])

    const candidates = getContractionCandidates(graph)
    expect(candidates).toHaveLength(0)
  })
})
