import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

export interface BrowsableProposal {
  id: string
  title: string
  abstract: string
  innovation: string[]
  methodology: string
  feasibility: {
    compute_estimate: string
    timeline_weeks: number
    score: number
  }
  risk: { level: string; description: string }
  novelty_score: number
  impact_score: number
  references?: string[]
}

interface Props {
  proposals: BrowsableProposal[]
  onSelect: (proposal: BrowsableProposal) => void
  onCancel: () => void
  onRegenerate?: (proposal: BrowsableProposal) => void
  onMore?: () => void
}

function formatScore(score: number): string {
  return (score * 10).toFixed(1)
}

export function ProposalBrowser({
  proposals,
  onSelect,
  onCancel,
  onRegenerate,
  onMore,
}: Props): React.ReactNode {
  const [index, setIndex] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [diffView, setDiffView] = useState(false)
  const [prevIndex, setPrevIndex] = useState(0)

  if (proposals.length === 0) {
    return <Text>No proposals to display.</Text>
  }

  const proposal = proposals[index]

  useInput((input, key) => {
    if (editing) return // disable shortcuts while editing
    if (key.leftArrow) {
      setPrevIndex(index)
      setIndex(i => (i > 0 ? i - 1 : proposals.length - 1))
      setExpanded(false)
      setDiffView(false)
    } else if (key.rightArrow) {
      setPrevIndex(index)
      setIndex(i => (i < proposals.length - 1 ? i + 1 : 0))
      setExpanded(false)
      setDiffView(false)
    } else if (key.return) {
      onSelect(proposal)
    } else if (key.escape || input === 'q') {
      onCancel()
    } else if (key.tab || input === 't') {
      setExpanded(e => !e)
    } else if (input === 'e') {
      setEditing(e => !e)
      setExpanded(true)
    } else if (input === 'r') {
      onRegenerate?.(proposal)
    } else if (input === 'm') {
      onMore?.()
    } else if (input === 'd') {
      setDiffView(d => !d)
    }
  })

  return (
    <Box flexDirection="column">
      {/* Title */}
      <Box marginTop={1}>
        <Text bold color="cyan">
          Proposal {index + 1}: {proposal.title}
        </Text>
      </Box>

      {/* Abstract */}
      <Box marginTop={1} flexDirection="column">
        <Text bold underline>
          Abstract
        </Text>
        <Text wrap="wrap">
          {expanded
            ? proposal.abstract
            : proposal.abstract.slice(0, 200) +
              (proposal.abstract.length > 200 ? '...' : '')}
        </Text>
      </Box>

      {/* Innovation */}
      <Box marginTop={1} flexDirection="column">
        <Text bold underline>
          Innovation
        </Text>
        {proposal.innovation.map((item, i) => (
          <Box key={i}>
            <Text>
              {'  '}* {item}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Scores */}
      <Box marginTop={1}>
        <Text>
          Feasibility: {formatScore(proposal.feasibility.score)}/10 |{' '}
          {proposal.feasibility.compute_estimate},{' '}
          {proposal.feasibility.timeline_weeks} weeks
        </Text>
      </Box>
      <Box>
        <Text>
          Risk:{' '}
          <Text
            color={
              proposal.risk.level === 'low'
                ? 'green'
                : proposal.risk.level === 'high'
                  ? 'red'
                  : 'yellow'
            }
          >
            {proposal.risk.level}
          </Text>{' '}
          - {proposal.risk.description}
        </Text>
      </Box>
      <Box>
        <Text>
          Novelty: {formatScore(proposal.novelty_score)}/10 | Impact:{' '}
          {formatScore(proposal.impact_score)}/10
        </Text>
      </Box>

      {/* Expanded details */}
      {expanded && (
        <Box marginTop={1} flexDirection="column">
          <Text bold underline>
            Methodology
          </Text>
          <Text wrap="wrap">{proposal.methodology || '(not specified)'}</Text>

          {proposal.references && proposal.references.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text bold underline>
                Key References
              </Text>
              {proposal.references.slice(0, 5).map((ref, i) => (
                <Box key={i}>
                  <Text dimColor>
                    {'  '}[{i + 1}] {ref}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}

      {/* Editing indicator */}
      {editing && (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow" bold>
            Edit Mode (press e to exit)
          </Text>
          <Text dimColor>
            Modify this proposal in your editor, then use /propose --focus to
            regenerate with edits.
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Title: </Text>
            <Text>{proposal.title}</Text>
            <Text bold>Abstract: </Text>
            <Text wrap="wrap">{proposal.abstract}</Text>
            <Text bold>Methodology: </Text>
            <Text wrap="wrap">{proposal.methodology || '(not specified)'}</Text>
          </Box>
        </Box>
      )}

      {/* Diff view: compare current vs previous proposal */}
      {diffView && proposals.length > 1 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="magenta" bold>
            Diff: Proposal {prevIndex + 1} vs {index + 1}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>
              [{prevIndex + 1}] {proposals[prevIndex]?.title}
            </Text>
            <Text>
              [{index + 1}] {proposal.title}
            </Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Innovation differences:</Text>
            <Text dimColor>
              [{prevIndex + 1}]{' '}
              {proposals[prevIndex]?.innovation.join('; ').slice(0, 120)}
            </Text>
            <Text>
              [{index + 1}] {proposal.innovation.join('; ').slice(0, 120)}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press d to close diff view</Text>
          </Box>
        </Box>
      )}

      {/* Position indicator */}
      <Box marginTop={1}>
        <Text dimColor>
          [{index + 1}/{proposals.length}]
        </Text>
      </Box>
    </Box>
  )
}
