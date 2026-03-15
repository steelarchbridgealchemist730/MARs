import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

export interface PlannedFigure {
  id: string
  caption: string
  type: 'matplotlib' | 'tikz' | 'pgfplots' | 'imported'
  description: string
}

export interface PlannedTable {
  id: string
  caption: string
  source_csv?: string
  description: string
}

export interface FigurePlanData {
  title: string
  venue: string
  figures: PlannedFigure[]
  tables: PlannedTable[]
  estimated_pages: number
}

interface Props {
  plan: FigurePlanData
  onApprove: () => void
  onCancel: () => void
}

export function FigurePlanBrowser({
  plan,
  onApprove,
  onCancel,
}: Props): React.ReactNode {
  const [selectedIdx, setSelectedIdx] = useState(0)
  const totalItems = plan.figures.length + plan.tables.length

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIdx(i => (i > 0 ? i - 1 : totalItems - 1))
    } else if (key.downArrow) {
      setSelectedIdx(i => (i < totalItems - 1 ? i + 1 : 0))
    } else if (key.return) {
      onApprove()
    } else if (key.escape || input === 'q') {
      onCancel()
    }
  })

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>Figure & Table Plan</Text>
      <Text dimColor>{'─'.repeat(55)}</Text>

      <Box marginTop={1}>
        <Text>
          Paper: <Text bold>{plan.title}</Text>
        </Text>
      </Box>
      <Box>
        <Text>
          Venue: {plan.venue} | Est. pages: {plan.estimated_pages}
        </Text>
      </Box>

      {/* Figures */}
      <Box marginTop={1} flexDirection="column">
        <Text bold underline>
          Figures:
        </Text>
        {plan.figures.map((fig, i) => (
          <Box key={fig.id}>
            <Text
              color={selectedIdx === i ? 'cyan' : undefined}
              bold={selectedIdx === i}
            >
              {'  '}
              {selectedIdx === i ? '>' : ' '} Fig {i + 1}: {fig.caption} (
              {fig.type})
            </Text>
          </Box>
        ))}
      </Box>

      {/* Tables */}
      <Box marginTop={1} flexDirection="column">
        <Text bold underline>
          Tables:
        </Text>
        {plan.tables.map((tab, i) => {
          const idx = plan.figures.length + i
          return (
            <Box key={tab.id}>
              <Text
                color={selectedIdx === idx ? 'cyan' : undefined}
                bold={selectedIdx === idx}
              >
                {'  '}
                {selectedIdx === idx ? '>' : ' '} Tab {i + 1}: {tab.caption}
              </Text>
            </Box>
          )
        })}
      </Box>

      {/* Selected item detail */}
      {totalItems > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{'─'.repeat(55)}</Text>
          <Text bold>Detail:</Text>
          <Text wrap="wrap">
            {selectedIdx < plan.figures.length
              ? plan.figures[selectedIdx].description
              : plan.tables[selectedIdx - plan.figures.length].description}
          </Text>
        </Box>
      )}

      <Text dimColor>{'─'.repeat(55)}</Text>
      <Text dimColor>Up/Down: navigate | Enter: approve plan | q: cancel</Text>
    </Box>
  )
}
