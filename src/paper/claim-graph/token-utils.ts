/**
 * Estimate token count from text. ~4 chars per token heuristic.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Truncate text to maxChars, respecting word boundaries. Appends '...' if truncated.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const sliced = text.slice(0, maxChars)
  const lastSpace = sliced.lastIndexOf(' ')
  return (
    (lastSpace > maxChars * 0.5 ? sliced.slice(0, lastSpace) : sliced) + '...'
  )
}

/**
 * Truncate text to fit within maxTokens (~maxTokens * 4 chars).
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return text
  return truncate(text, maxChars)
}
