import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'

interface Props {
  topic: string
  runner: () => Promise<{
    result: any
    progressLines: string[]
  }>
  onDone: (output: string) => void
}

export function DeepResearchProgress({
  topic,
  runner,
  onDone,
}: Props): React.ReactNode {
  const [lines, setLines] = useState<string[]>([
    `Starting deep research: "${topic}"`,
  ])
  const [phase, setPhase] = useState('Initializing...')
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    runner()
      .then(({ result, progressLines }) => {
        if (cancelled) return
        const output = [
          `Deep Research Complete: "${topic}"`,
          '',
          'Progress:',
          ...progressLines,
          '',
          'Results:',
          `  Papers found:    ${result.papers_found}`,
          `  PDFs acquired:   ${result.papers_acquired}`,
          `  Output dir:      ${result.index_dir}`,
          '',
          'Generated reports:',
          `  Survey:    ${result.survey_path}`,
          `  Gaps:      ${result.gaps_path}`,
          `  Taxonomy:  ${result.taxonomy_path}`,
          `  Timeline:  ${result.timeline_path}`,
        ].join('\n')
        setDone(true)
        onDone(output)
      })
      .catch(err => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        setDone(true)
        onDone(`Deep research failed: ${msg}\n\nProgress:\n${lines.join('\n')}`)
      })

    return () => {
      cancelled = true
    }
  }, [])

  // This component is used as a ref-holder for progress updates
  // The runner calls addLine to update state
  ;(DeepResearchProgress as any)._addLine = (line: string) => {
    setLines(prev => [...prev, line])
    // Detect phase from progress messages
    if (line.includes('Phase')) setPhase(line.trim())
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold color="cyan">
        Deep Research: {topic}
      </Text>
      {error ? (
        <Text color="red">Error: {error}</Text>
      ) : done ? (
        <Text color="green">Complete!</Text>
      ) : (
        <Text color="yellow">{phase}</Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        {lines.slice(-10).map((line, i) => (
          <Box key={i}>
            <Text dimColor>{line}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
