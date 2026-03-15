import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import type {
  PackBuildProgress,
  PackBuildResult,
} from '../../paper/domain-knowledge/pack-builder'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// ── Types ───────────────────────────────────────────────

interface Props {
  runner: (
    onProgress: (event: PackBuildProgress) => void,
  ) => Promise<PackBuildResult>
  onDone: (result: PackBuildResult) => void
  onError: (error: string) => void
}

interface BuildState {
  phase: number
  totalPhases: number
  phaseMessage: string
  textbooksDone: string[]
  papersDone: string[]
  papersDownloaded: string[]
  downloadFailed: string[]
  entryCount: number
  errors: string[]
  costUsd: number
}

// ── Component ───────────────────────────────────────────

export function BuildProgressPanel({
  runner,
  onDone,
  onError,
}: Props): React.ReactNode {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [startTime] = useState(Date.now())
  const [state, setState] = useState<BuildState>({
    phase: 0,
    totalPhases: 8,
    phaseMessage: 'Starting...',
    textbooksDone: [],
    papersDone: [],
    papersDownloaded: [],
    downloadFailed: [],
    entryCount: 0,
    errors: [],
    costUsd: 0,
  })
  const [done, setDone] = useState(false)

  // Spinner timer
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % FRAMES.length)
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 80)
    return () => clearInterval(timer)
  }, [])

  // Run build
  useEffect(() => {
    const handleProgress = (event: PackBuildProgress) => {
      setState(prev => {
        switch (event.type) {
          case 'phase':
            return {
              ...prev,
              phase: event.phase,
              totalPhases: event.total,
              phaseMessage: event.message,
            }
          case 'textbook_done':
            return {
              ...prev,
              textbooksDone: [...prev.textbooksDone, event.id],
              entryCount: prev.entryCount + event.entries,
            }
          case 'paper_done':
            return {
              ...prev,
              papersDone: [...prev.papersDone, event.id],
              entryCount: prev.entryCount + event.entries,
            }
          case 'paper_downloaded':
            return {
              ...prev,
              papersDownloaded: [...prev.papersDownloaded, event.id],
            }
          case 'paper_download_failed':
            return {
              ...prev,
              downloadFailed: [
                ...prev.downloadFailed,
                `${event.id}: ${event.reason}`,
              ],
            }
          case 'error':
            return {
              ...prev,
              errors: [...prev.errors, event.message],
            }
          default:
            return prev
        }
      })
    }

    runner(handleProgress)
      .then(result => {
        setDone(true)
        onDone(result)
      })
      .catch(err => {
        setDone(true)
        onError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

  const progressBar = renderProgressBar(state.phase, state.totalPhases)

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header */}
      <Box>
        {!done && <Text color="cyan">{FRAMES[frame]} </Text>}
        {done && <Text color="green">{'✓ '}</Text>}
        <Text bold>Building Knowledge Pack</Text>
        <Text dimColor> ({timeStr})</Text>
      </Box>

      {/* Progress bar */}
      <Box marginTop={1}>
        <Text> {progressBar} </Text>
        <Text dimColor>
          Phase {state.phase}/{state.totalPhases}: {state.phaseMessage}
        </Text>
      </Box>

      {/* Stats */}
      <Box marginTop={1} flexDirection="column" marginLeft={2}>
        <Text>
          Entries:{' '}
          <Text color="green" bold>
            {state.entryCount}
          </Text>
          {'  '}
          Textbooks: <Text color="blue">{state.textbooksDone.length}</Text>
          {'  '}
          Papers: <Text color="blue">{state.papersDone.length}</Text>
        </Text>

        {state.papersDownloaded.length > 0 && (
          <Text>
            Downloads:{' '}
            <Text color="green">{state.papersDownloaded.length}</Text>
            {state.downloadFailed.length > 0 && (
              <Text color="red"> ({state.downloadFailed.length} failed)</Text>
            )}
          </Text>
        )}
      </Box>

      {/* Recent activity */}
      {state.textbooksDone.length > 0 && (
        <Box marginTop={1} marginLeft={2} flexDirection="column">
          {state.textbooksDone.slice(-3).map((id, i) => (
            <Box key={`tb-${i}`}>
              <Text dimColor>
                {'  '}
                <Text color="green">{'✓'}</Text> Textbook: {id}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {state.papersDone.length > 0 && (
        <Box marginLeft={2} flexDirection="column">
          {state.papersDone.slice(-3).map((id, i) => (
            <Box key={`pp-${i}`}>
              <Text dimColor>
                {'  '}
                <Text color="green">{'✓'}</Text> Paper: {id}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Errors (last 3) */}
      {state.errors.length > 0 && (
        <Box marginTop={1} marginLeft={2} flexDirection="column">
          <Text color="red">Errors ({state.errors.length}):</Text>
          {state.errors.slice(-3).map((err, i) => (
            <Box key={`err-${i}`}>
              <Text color="red" dimColor>
                {'  '}
                {err.slice(0, 80)}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

// ── Helpers ─────────────────────────────────────────────

function renderProgressBar(current: number, total: number): string {
  const width = 20
  const filled = Math.round((current / total) * width)
  const empty = width - filled
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`
}
