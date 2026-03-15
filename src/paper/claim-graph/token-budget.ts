export interface TokenBudget {
  systemPrompt: number
  l0Overview: number
  l1KeyClaims: number
  l2FocusSubgraph: number
  evidence: number
  trajectory: number
  literature: number
  domainKnowledge: number
}

/**
 * Allocate token budget across prompt sections.
 * Adapts based on graph size: larger graphs need more L1, less L2.
 */
export function allocateTokenBudget(
  claimCount: number,
  hasDomainKnowledge: boolean,
  maxInputTokens: number = 12000,
): TokenBudget {
  const systemPrompt = 2000
  const l0Overview = 300
  const isLarge = claimCount > 30
  const isMedium = claimCount > 10

  return {
    systemPrompt,
    l0Overview,
    l1KeyClaims: isLarge ? 2000 : isMedium ? 1500 : 1000,
    l2FocusSubgraph: isLarge ? 2000 : isMedium ? 2500 : 3000,
    evidence: isLarge ? 800 : 1000,
    trajectory: isLarge ? 500 : 700,
    literature: 500,
    domainKnowledge: hasDomainKnowledge ? 600 : 0,
  }
}
