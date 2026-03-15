import { describe, test, expect } from 'bun:test'
import {
  ProofBudgetController,
  type TheoremSpec,
} from '../../src/paper/proof-budget'
import {
  initializeFromProposal,
  type ResearchState,
} from '../../src/paper/research-state'

function makeState(overrides: Partial<ResearchState> = {}): ResearchState {
  const base = initializeFromProposal({
    id: 'test-proof-budget',
    title: 'Test Proof Budget Paper',
    abstract: 'Testing proof budget controller',
    innovation: ['Novel proof budgeting approach'],
    methodology: 'theoretical',
    feasibility: {
      score: 0.8,
      data_required: 'none',
      compute_estimate: '1 CPU-hour',
      timeline_weeks: 4,
    },
    risk: {
      level: 'low',
      description: 'Low risk test',
    },
    novelty_score: 0.7,
    impact_score: 0.6,
    references: [],
    created_at: new Date().toISOString(),
  })
  return { ...base, ...overrides }
}

function makeTheorem(overrides: Partial<TheoremSpec> = {}): TheoremSpec {
  return {
    id: 'thm-1',
    statement: 'For all x, f(x) converges in probability',
    importance: 'core',
    dependencies: [],
    ...overrides,
  }
}

describe('ProofBudgetController', () => {
  const ctrl = new ProofBudgetController()

  test('core theorem with sufficient budget → formal or semi_formal', () => {
    const state = makeState()
    const decision = ctrl.decideRigor(
      makeTheorem({ importance: 'core' }),
      state,
    )
    expect(['formal', 'semi_formal']).toContain(decision.target_rigor)
    expect(decision.max_depth_rounds).toBeGreaterThanOrEqual(3)
  })

  test('supporting theorem with sufficient budget → semi_formal', () => {
    const state = makeState()
    const decision = ctrl.decideRigor(
      makeTheorem({ importance: 'supporting' }),
      state,
    )
    expect(decision.target_rigor).toBe('semi_formal')
    expect(decision.max_depth_rounds).toBe(2)
  })

  test('auxiliary theorem → sketch', () => {
    const state = makeState()
    const decision = ctrl.decideRigor(
      makeTheorem({ importance: 'auxiliary' }),
      state,
    )
    expect(decision.target_rigor).toBe('sketch')
    expect(decision.max_depth_rounds).toBe(1)
    expect(decision.assumption_tolerance).toBe('pragmatic')
  })

  test('low budget downgrades supporting to sketch', () => {
    const state = makeState({
      budget: {
        total_usd: 100,
        spent_usd: 80,
        remaining_usd: 20,
        warn_at_percent: 20,
        breakdown: [],
      },
    })
    const decision = ctrl.decideRigor(
      makeTheorem({ importance: 'supporting' }),
      state,
    )
    expect(decision.target_rigor).toBe('sketch')
    expect(decision.max_depth_rounds).toBe(1)
  })

  test('low budget affects core theorem rigor', () => {
    const state = makeState({
      budget: {
        total_usd: 100,
        spent_usd: 80,
        remaining_usd: 20,
        warn_at_percent: 20,
        breakdown: [],
      },
    })
    const decision = ctrl.decideRigor(
      makeTheorem({ importance: 'core' }),
      state,
    )
    // Should downgrade from formal to semi_formal
    expect(decision.target_rigor).toBe('semi_formal')
    expect(decision.assumption_tolerance).toBe('pragmatic')
  })

  test('theoretical paper type boosts depth rounds', () => {
    const state = makeState({ paper_type: 'theoretical' })
    const decision = ctrl.decideRigor(
      makeTheorem({ importance: 'core' }),
      state,
    )
    // Theoretical papers get +1 theoryBoost
    expect(decision.max_depth_rounds).toBeGreaterThanOrEqual(4)
  })

  test('decision includes reasoning string', () => {
    const state = makeState()
    const decision = ctrl.decideRigor(makeTheorem(), state)
    expect(typeof decision.reasoning).toBe('string')
    expect(decision.reasoning.length).toBeGreaterThan(0)
    expect(decision.reasoning).toContain('core')
  })

  test('decision includes estimated cost', () => {
    const state = makeState()
    const decision = ctrl.decideRigor(makeTheorem(), state)
    expect(decision.estimated_cost_usd).toBeGreaterThan(0)
    // cost = rounds × $2/round
    expect(decision.estimated_cost_usd).toBe(decision.max_depth_rounds * 2)
  })

  test('core theorem gets more rounds than supporting', () => {
    const state = makeState()
    const coreDecision = ctrl.decideRigor(
      makeTheorem({ importance: 'core' }),
      state,
    )
    const supportDecision = ctrl.decideRigor(
      makeTheorem({ importance: 'supporting' }),
      state,
    )
    expect(coreDecision.max_depth_rounds).toBeGreaterThan(
      supportDecision.max_depth_rounds,
    )
  })

  test('auxiliary always pragmatic tolerance regardless of budget', () => {
    const richState = makeState({
      budget: {
        total_usd: 100,
        spent_usd: 10,
        remaining_usd: 90,
        warn_at_percent: 20,
        breakdown: [],
      },
    })
    const decision = ctrl.decideRigor(
      makeTheorem({ importance: 'auxiliary' }),
      richState,
    )
    expect(decision.assumption_tolerance).toBe('pragmatic')
  })
})
