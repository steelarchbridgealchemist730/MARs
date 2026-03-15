import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  Orchestrator,
  type OrchestratorCallbacks,
  type OrchestratorOptions,
  type ExecutionResult,
} from '../../src/paper/orchestrator'
import {
  initializeFromProposal,
  type ResearchState,
} from '../../src/paper/research-state'
import { ClaimGraph, type ClaimInput } from '../../src/paper/claim-graph/index'
import { EvidencePoolManager } from '../../src/paper/evidence-pool'
import { canAdmit } from '../../src/paper/admission-gate'

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
      cost_usd: 0,
    }),
    presentDecision: async () => 'approve',
    onProgress: () => {},
    onStateChange: () => {},
    onComplete: () => {},
    onError: () => {},
    ...overrides,
  }
}

function makeOrchestrator(projectDir: string): Orchestrator {
  const state = initializeFromProposal(makeProposal(), 'empirical')
  const options: OrchestratorOptions = { mode: 'interactive' }
  return new Orchestrator(projectDir, state, makeCallbacks(), options)
}

// Access private methods via bracket notation for testing
function callRegisterEvidence(
  orch: Orchestrator,
  result: ExecutionResult,
  pool: EvidencePoolManager,
): Array<{ id: string; kind: 'grounded' | 'derived'; claimText: string }> {
  return (orch as any).registerEvidence(result, pool)
}

function callLinkEvidenceToClaims(
  orch: Orchestrator,
  registered: Array<{
    id: string
    kind: 'grounded' | 'derived'
    claimText: string
  }>,
  graph: ClaimGraph,
  pool: EvidencePoolManager,
  targetClaimIds?: string[],
): void {
  return (orch as any).linkEvidenceToClaims(
    registered,
    graph,
    pool,
    targetClaimIds,
  )
}

function callFindMatchingClaims(
  orch: Orchestrator,
  text: string,
  claims: any[],
): string[] {
  return (orch as any).findMatchingClaims(text, claims)
}

function callJaccardSimilarity(
  orch: Orchestrator,
  a: string,
  b: string,
): number {
  return (orch as any).jaccardSimilarity(a, b)
}

describe('Evidence-Claim Bidirectional Linking', () => {
  let projectDir: string
  let orch: Orchestrator

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'evidence-link-test-'))
    orch = makeOrchestrator(projectDir)
  })

  test('registerEvidence returns IDs with correct metadata', () => {
    const pool = new EvidencePoolManager()
    const result: ExecutionResult = {
      success: true,
      agent: 'investigator',
      summary: 'Found relevant literature',
      artifacts_produced: [],
      new_claims: [],
      new_evidence: [
        {
          kind: 'grounded',
          claim_statement: 'Neural operators outperform baselines',
          source_ref: 'arxiv:2301.12345',
        },
        {
          kind: 'derived',
          claim_statement: 'Our method achieves 95% accuracy',
          method: 'experiment',
        },
      ],
      cost_usd: 0.1,
    }

    const registered = callRegisterEvidence(orch, result, pool)

    expect(registered).toHaveLength(2)
    expect(registered[0].kind).toBe('grounded')
    expect(registered[0].claimText).toBe(
      'Neural operators outperform baselines',
    )
    expect(registered[0].id).toBeTruthy()
    expect(registered[1].kind).toBe('derived')
    expect(registered[1].claimText).toBe('Our method achieves 95% accuracy')
    expect(registered[1].id).toBeTruthy()

    // Verify evidence was actually added to the pool
    expect(pool.getGrounded(registered[0].id)).toBeDefined()
    expect(pool.getDerived(registered[1].id)).toBeDefined()
  })

  test('exact match linking works', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()

    const claimId = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'explanation',
      statement: 'X outperforms Y on benchmark Z',
      phase: 'proposed',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.7,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.3,
      },
      created_by: 'builder',
    })

    const evId = pool.addGrounded({
      claim: 'X outperforms Y on benchmark Z',
      source_type: 'literature',
      source_ref: 'paper-123',
      verified: true,
      supports_claims: [],
      contradicts_claims: [],
      acquired_by: 'investigator',
    })

    const registered = [
      {
        id: evId,
        kind: 'grounded' as const,
        claimText: 'X outperforms Y on benchmark Z',
      },
    ]

    callLinkEvidenceToClaims(orch, registered, graph, pool)

    // Forward link: evidence → claim
    const ev = pool.getGrounded(evId)!
    expect(ev.supports_claims).toContain(claimId)

    // Reverse link: claim → evidence
    const claim = graph.getClaim(claimId)!
    expect(claim.evidence.grounded).toContain(evId)
  })

  test('substring match linking works', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()

    const claimId = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'observation',
      statement: 'The calibration process takes 30 seconds',
      phase: 'proposed',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.6,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.4,
      },
      created_by: 'builder',
    })

    // Evidence text is a substring of the claim
    const evId = pool.addDerived({
      claim: 'calibration process takes 30 seconds',
      method: 'experiment',
      reproducible: true,
      artifact_id: 'exp-1',
      assumptions: [],
      supports_claims: [],
      contradicts_claims: [],
      produced_by: 'experiment-runner',
    })

    const registered = [
      {
        id: evId,
        kind: 'derived' as const,
        claimText: 'calibration process takes 30 seconds',
      },
    ]

    callLinkEvidenceToClaims(orch, registered, graph, pool)

    const ev = pool.getDerived(evId)!
    expect(ev.supports_claims).toContain(claimId)

    const claim = graph.getClaim(claimId)!
    expect(claim.evidence.derived).toContain(evId)
  })

  test('Jaccard match linking works for paraphrased text', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()

    const claimId = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'exploitation',
      statement:
        'Neural operator approach bypasses SDE solving for faster calibration',
      phase: 'proposed',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.65,
        evidenceType: 'heuristic_motivation',
        vulnerabilityScore: 0.4,
      },
      created_by: 'builder',
    })

    // Paraphrased version with >0.6 Jaccard overlap
    const evText =
      'Neural operator bypasses SDE solving enabling faster calibration process'
    const evId = pool.addGrounded({
      claim: evText,
      source_type: 'literature',
      source_ref: 'arxiv:2405.99999',
      verified: false,
      supports_claims: [],
      contradicts_claims: [],
      acquired_by: 'investigator',
    })

    // Verify Jaccard is >= 0.6 for these texts
    const similarity = callJaccardSimilarity(
      orch,
      evText.toLowerCase(),
      'Neural operator approach bypasses SDE solving for faster calibration'.toLowerCase(),
    )
    expect(similarity).toBeGreaterThanOrEqual(0.6)

    const registered = [
      { id: evId, kind: 'grounded' as const, claimText: evText },
    ]

    callLinkEvidenceToClaims(orch, registered, graph, pool)

    const ev = pool.getGrounded(evId)!
    expect(ev.supports_claims).toContain(claimId)

    const claim = graph.getClaim(claimId)!
    expect(claim.evidence.grounded).toContain(evId)
  })

  test('no false positive linking for unrelated texts', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()

    const claimId = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'observation',
      statement: 'Gradient descent converges in 100 iterations',
      phase: 'proposed',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.7,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.3,
      },
      created_by: 'builder',
    })

    // Completely unrelated evidence
    const evId = pool.addGrounded({
      claim: 'The dataset contains 50000 images of cats and dogs',
      source_type: 'dataset',
      source_ref: 'kaggle/cats-dogs',
      verified: true,
      supports_claims: [],
      contradicts_claims: [],
      acquired_by: 'data-scout',
    })

    const registered = [
      {
        id: evId,
        kind: 'grounded' as const,
        claimText: 'The dataset contains 50000 images of cats and dogs',
      },
    ]

    callLinkEvidenceToClaims(orch, registered, graph, pool)

    // Should NOT be linked
    const ev = pool.getGrounded(evId)!
    expect(ev.supports_claims).not.toContain(claimId)

    const claim = graph.getClaim(claimId)!
    expect(claim.evidence.grounded).toHaveLength(0)
  })

  test('agent-created claims in same cycle get linked', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()

    // Simulate: evidence is registered first, then claim is added, then linking runs
    const evId = pool.addGrounded({
      claim: 'Method X achieves state-of-the-art on ImageNet',
      source_type: 'literature',
      source_ref: 'arxiv:2406.11111',
      verified: true,
      supports_claims: [],
      contradicts_claims: [],
      acquired_by: 'investigator',
    })

    // Claim added after evidence (as happens in the run loop)
    const claimId = graph.addClaim({
      type: 'novelty',
      epistemicLayer: 'exploitation',
      statement: 'Method X achieves state-of-the-art on ImageNet',
      phase: 'proposed',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.75,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.25,
      },
      created_by: 'investigator',
    })

    const registered = [
      {
        id: evId,
        kind: 'grounded' as const,
        claimText: 'Method X achieves state-of-the-art on ImageNet',
      },
    ]

    // Linking runs after both are in the graph
    callLinkEvidenceToClaims(orch, registered, graph, pool)

    const ev = pool.getGrounded(evId)!
    expect(ev.supports_claims).toContain(claimId)

    const claim = graph.getClaim(claimId)!
    expect(claim.evidence.grounded).toContain(evId)
  })

  test('target claim IDs seed evidence linking even when text does not match', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()

    // Claim with completely different text from evidence
    const claimId = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'observation',
      statement: 'Alpha-beta pruning reduces search space exponentially',
      phase: 'proposed',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.7,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.3,
      },
      created_by: 'builder',
    })

    // Evidence with unrelated text
    const evId = pool.addGrounded({
      claim: 'Experimental results on chess engine benchmark',
      source_type: 'literature',
      source_ref: 'paper-456',
      verified: true,
      supports_claims: [],
      contradicts_claims: [],
      acquired_by: 'investigator',
    })

    const registered = [
      {
        id: evId,
        kind: 'grounded' as const,
        claimText: 'Experimental results on chess engine benchmark',
      },
    ]

    // Without targetClaimIds, text matching should NOT link these
    callLinkEvidenceToClaims(orch, registered, graph, pool)

    let ev = pool.getGrounded(evId)!
    expect(ev.supports_claims).not.toContain(claimId)

    // Reset evidence supports
    ev.supports_claims = []

    // With targetClaimIds, seed-linking should link them despite text mismatch
    callLinkEvidenceToClaims(orch, registered, graph, pool, [claimId])

    ev = pool.getGrounded(evId)!
    expect(ev.supports_claims).toContain(claimId)

    const claim = graph.getClaim(claimId)!
    expect(claim.evidence.grounded).toContain(evId)
  })

  test('target claim seeding + text matching produce deduplicated links', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()

    // Claim and evidence with exact same text (text matching will also find it)
    const claimId = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'observation',
      statement: 'Model converges in 50 epochs',
      phase: 'proposed',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.7,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.3,
      },
      created_by: 'builder',
    })

    const evId = pool.addDerived({
      claim: 'Model converges in 50 epochs',
      method: 'experiment',
      reproducible: true,
      artifact_id: 'exp-2',
      assumptions: [],
      supports_claims: [],
      contradicts_claims: [],
      produced_by: 'experiment-runner',
    })

    const registered = [
      {
        id: evId,
        kind: 'derived' as const,
        claimText: 'Model converges in 50 epochs',
      },
    ]

    // Both seed-linking (targetClaimIds) AND text matching should find this claim,
    // but the result should be deduplicated
    callLinkEvidenceToClaims(orch, registered, graph, pool, [claimId])

    const ev = pool.getDerived(evId)!
    const occurrences = ev.supports_claims.filter(id => id === claimId)
    expect(occurrences).toHaveLength(1)

    const claim = graph.getClaim(claimId)!
    const evOccurrences = claim.evidence.derived.filter(id => id === evId)
    expect(evOccurrences).toHaveLength(1)
  })

  test('targets_claim seeding enables admission gate passage', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()

    // Claim with text completely different from evidence
    const claimId = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'observation',
      statement: 'Our novel architecture reduces memory footprint by 3x',
      phase: 'under_investigation',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.8,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.2,
      },
      created_by: 'builder',
    })

    // Before: no evidence → admission gate rejects
    const beforeDecision = canAdmit(claimId, graph, pool)
    expect(beforeDecision.admit).toBe(false)

    // Evidence with non-matching text
    const evId = pool.addGrounded({
      claim: 'Profiling data from GPU cluster run #42',
      source_type: 'dataset',
      source_ref: 'benchmark-gpu-42',
      verified: true,
      supports_claims: [],
      contradicts_claims: [],
      acquired_by: 'experiment-runner',
    })

    const registered = [
      {
        id: evId,
        kind: 'grounded' as const,
        claimText: 'Profiling data from GPU cluster run #42',
      },
    ]

    // Seed-link via targetClaimIds (simulating arbiter's targets_claim)
    callLinkEvidenceToClaims(orch, registered, graph, pool, [claimId])

    // After seed-linking: admission gate should pass
    const afterDecision = canAdmit(claimId, graph, pool)
    expect(afterDecision.admit).toBe(true)
  })

  test('E2E: admission gate passes after evidence linking', () => {
    const graph = new ClaimGraph()
    const pool = new EvidencePoolManager()

    // Add a claim with high enough confidence and proper evidence type
    const claimId = graph.addClaim({
      type: 'hypothesis',
      epistemicLayer: 'observation',
      statement: 'Our method reduces latency by 40%',
      phase: 'under_investigation',
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.8,
        evidenceType: 'empirical_support',
        vulnerabilityScore: 0.2,
      },
      created_by: 'builder',
    })

    // Before linking: admission gate rejects (no evidence)
    const beforeDecision = canAdmit(claimId, graph, pool)
    expect(beforeDecision.admit).toBe(false)
    expect(beforeDecision.reason).toBe('No evidence')

    // Register and link grounded evidence
    const gEvId = pool.addGrounded({
      claim: 'Our method reduces latency by 40%',
      source_type: 'literature',
      source_ref: 'benchmark-results',
      verified: true,
      supports_claims: [],
      contradicts_claims: [],
      acquired_by: 'experiment-runner',
    })

    const registered = [
      {
        id: gEvId,
        kind: 'grounded' as const,
        claimText: 'Our method reduces latency by 40%',
      },
    ]

    callLinkEvidenceToClaims(orch, registered, graph, pool)

    // After linking: admission gate passes (hypothesis only needs some evidence, not both kinds)
    const afterDecision = canAdmit(claimId, graph, pool)
    expect(afterDecision.admit).toBe(true)
  })
})
