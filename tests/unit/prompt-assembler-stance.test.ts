import { describe, test, expect } from 'bun:test'
import { PromptAssembler } from '../../src/paper/claim-graph/prompt-assembler'
import { ClaimGraph } from '../../src/paper/claim-graph/index'
import { EvidencePoolManager } from '../../src/paper/evidence-pool'
import { initializeFromProposal } from '../../src/paper/research-state'
import type { ResearchState } from '../../src/paper/research-state'

function makeState(): ResearchState {
  return initializeFromProposal({
    id: 'test',
    title: 'Test',
    abstract: 'Test abstract',
    methodology: 'Testing',
    innovation: [{ description: 'Novel' }],
    novelty_score: 0.8,
    impact_score: 0.7,
    feasibility: { score: 0.9, data_required: 'none' },
  } as any)
}

describe('PromptAssembler stance selection', () => {
  test('assembleSkeptic uses standard prompt by default', () => {
    const state = makeState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)
    const assembler = new PromptAssembler(graph, pool, state, 2)

    const prompt = assembler.assembleSkeptic({
      narrative: 'test',
      new_claims_proposed: [],
      new_edges_proposed: [],
      recommended_next_actions: [],
      reformulation_suggestions: [],
    })

    expect(prompt).toContain('Think adversarially')
    expect(prompt).not.toContain('supportive senior colleague')
  })

  test('assembleSkeptic uses exploratory prompt when stance is exploratory', () => {
    const state = makeState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)
    const assembler = new PromptAssembler(
      graph,
      pool,
      state,
      2,
      undefined,
      'exploratory',
    )

    const prompt = assembler.assembleSkeptic({
      narrative: 'test',
      new_claims_proposed: [],
      new_edges_proposed: [],
      recommended_next_actions: [],
      reformulation_suggestions: [],
    })

    expect(prompt).toContain('supportive senior colleague')
    expect(prompt).not.toContain('Think adversarially')
  })

  test('assembleArbiter uses standard prompt by default', () => {
    const state = makeState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)
    const assembler = new PromptAssembler(graph, pool, state, 2)

    const builderOutput = {
      narrative: 'test',
      new_claims_proposed: [],
      new_edges_proposed: [],
      recommended_next_actions: [],
      reformulation_suggestions: [],
    }
    const skepticOutput = {
      internal_inconsistencies: [],
      bridge_gaps: [],
      evidence_inflation: [],
      theorem_overreach: [],
      top3_collapse_points: [],
      admission_denials: [],
      reformulation_opportunities: [],
    }

    const prompt = assembler.assembleArbiter(builderOutput, skepticOutput)

    expect(prompt).toContain('Synthesize Builder and Skeptic')
    expect(prompt).not.toContain('Bias toward progress')
  })

  test('assembleArbiter uses exploratory prompt when stance is exploratory', () => {
    const state = makeState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)
    const assembler = new PromptAssembler(
      graph,
      pool,
      state,
      2,
      undefined,
      'exploratory',
    )

    const builderOutput = {
      narrative: 'test',
      new_claims_proposed: [],
      new_edges_proposed: [],
      recommended_next_actions: [],
      reformulation_suggestions: [],
    }
    const skepticOutput = {
      internal_inconsistencies: [],
      bridge_gaps: [],
      evidence_inflation: [],
      theorem_overreach: [],
      top3_collapse_points: [],
      admission_denials: [],
      reformulation_opportunities: [],
    }

    const prompt = assembler.assembleArbiter(builderOutput, skepticOutput)

    expect(prompt).toContain('Bias toward progress')
    expect(prompt).not.toContain('Synthesize Builder and Skeptic')
  })

  test('update() changes stance for subsequent calls', () => {
    const state = makeState()
    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)
    const assembler = new PromptAssembler(graph, pool, state, 2)

    const builderOutput = {
      narrative: 'test',
      new_claims_proposed: [],
      new_edges_proposed: [],
      recommended_next_actions: [],
      reformulation_suggestions: [],
    }

    // Default: standard
    let prompt = assembler.assembleSkeptic(builderOutput)
    expect(prompt).toContain('Think adversarially')

    // Update to exploratory
    assembler.update(graph, pool, state, undefined, undefined, 'exploratory')
    prompt = assembler.assembleSkeptic(builderOutput)
    expect(prompt).toContain('supportive senior colleague')

    // Update back to standard
    assembler.update(graph, pool, state, undefined, undefined, 'standard')
    prompt = assembler.assembleSkeptic(builderOutput)
    expect(prompt).toContain('Think adversarially')
  })
})
