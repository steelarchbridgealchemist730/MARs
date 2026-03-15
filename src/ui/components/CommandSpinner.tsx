import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const VERBS = [
  'Cogitating',
  'Ruminating',
  'Pondering',
  'Deliberating',
  'Contemplating',
  'Musing',
  'Synthesizing',
  'Percolating',
  'Incubating',
  'Conjuring',
  'Distilling',
  'Fermenting',
  'Crystallizing',
  'Brainstorming',
  'Churning',
  'Brewing',
  'Weaving',
  'Orchestrating',
  'Assembling',
  'Deciphering',
]

function pickVerb(): string {
  return VERBS[Math.floor(Math.random() * VERBS.length)]
}

interface Props {
  label: string
  runner: () => Promise<string>
  onDone: (result: string) => void
}

export function CommandSpinner({
  label,
  runner,
  onDone,
}: Props): React.ReactNode {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [startTime] = useState(Date.now())
  const [verb] = useState(pickVerb)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % FRAMES.length)
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 80)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    runner()
      .then(result => onDone(result))
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        onDone(`Error: ${msg}`)
      })
  }, [])

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

  return (
    <Box marginTop={1}>
      <Text color="cyan">{FRAMES[frame]} </Text>
      <Text bold>{verb}...</Text>
      <Text> {label}</Text>
      <Text dimColor> ({timeStr})</Text>
    </Box>
  )
}
