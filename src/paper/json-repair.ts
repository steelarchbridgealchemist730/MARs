/**
 * JSON repair utilities for parsing LLM-generated JSON outputs.
 * Extracted from orchestrator.ts for testability.
 */

/**
 * Attempt to repair truncated JSON by closing open strings, arrays, and objects.
 * Used when an LLM response is cut off at max_tokens.
 */
export function repairTruncatedJSON(text: string): unknown | null {
  const match = text.match(/\{[\s\S]*/)
  if (!match) return null
  let json = match[0]

  // If it already parses, return as-is
  try {
    return JSON.parse(json)
  } catch {
    // continue to repair
  }

  // Close any unterminated string (odd number of unescaped quotes)
  const unescapedQuotes = json.match(/(?<!\\)"/g)
  if (unescapedQuotes && unescapedQuotes.length % 2 !== 0) {
    json += '"'
  }

  // Count open brackets/braces and close them
  let openBraces = 0
  let openBrackets = 0
  let inString = false
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    if (ch === '\\' && inString) {
      i++ // skip escaped char
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') openBraces++
    else if (ch === '}') openBraces--
    else if (ch === '[') openBrackets++
    else if (ch === ']') openBrackets--
  }

  // Remove trailing comma before closing
  json = json.replace(/,\s*$/, '')

  for (let i = 0; i < openBrackets; i++) json += ']'
  for (let i = 0; i < openBraces; i++) json += '}'

  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Parse triple-role LLM output. Extracts JSON, falls back to repair.
 */
export function parseTripleRoleOutput<T>(text: string, role: string): T {
  // Strip markdown fences if present
  let cleaned = text.replace(/```(?:json)?\s*\n?/g, '').replace(/```\s*$/g, '')

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]) as T
    } catch {
      // Truncated — attempt repair
      const repaired = repairTruncatedJSON(cleaned)
      if (repaired) return repaired as T
    }
  }

  // Include a preview of the response to aid debugging
  const preview = text.slice(0, 200).replace(/\n/g, '\\n')
  throw new Error(
    `Failed to parse ${role} output (${text.length} chars). Preview: ${preview}`,
  )
}
