import React, { useState, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import { readFileSync } from 'fs'
import { join } from 'path'
import { useFullscreenDimensions } from './FullscreenLayout'

interface Document {
  label: string
  filename: string
  content: string
}

interface Props {
  researchDir: string
  onDone: (result: string) => void
}

type Mode = 'browse' | 'search' | 'ask'

function loadDocument(dir: string, filename: string): string {
  try {
    return readFileSync(join(dir, 'literature', filename), 'utf-8')
  } catch {
    return '(file not found)'
  }
}

export function LiteratureBrowser({
  researchDir,
  onDone,
}: Props): React.ReactNode {
  const documents = useMemo<Document[]>(() => {
    const files = [
      { label: 'Survey', filename: 'survey.md' },
      { label: 'Gaps', filename: 'gaps.md' },
      { label: 'Taxonomy', filename: 'taxonomy.md' },
      { label: 'Timeline', filename: 'timeline.md' },
    ]
    return files.map(f => ({
      ...f,
      content: loadDocument(researchDir, f.filename),
    }))
  }, [researchDir])

  const [index, setIndex] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [mode, setMode] = useState<Mode>('browse')
  const [inputBuffer, setInputBuffer] = useState('')
  const [searchResults, setSearchResults] = useState<string[]>([])
  const [askSuggestion, setAskSuggestion] = useState('')

  const { contentHeight } = useFullscreenDimensions()
  // Reserve lines for tab bar (3), search/ask input (2), results (6)
  const maxLines = Math.max(5, contentHeight - 8)

  const doc = documents[index]
  const contentLines = doc.content.split('\n')
  const visibleLines = contentLines.slice(scrollOffset, scrollOffset + maxLines)

  useInput((input, key) => {
    // In search or ask mode, handle text input
    if (mode === 'search') {
      if (key.return) {
        // Execute search
        const query = inputBuffer.toLowerCase()
        const matches = contentLines
          .map((line, i) => ({ line, num: i + 1 }))
          .filter(({ line }) => line.toLowerCase().includes(query))
          .slice(0, 10)
          .map(({ line, num }) => `  L${num}: ${line.trim().slice(0, 100)}`)
        setSearchResults(
          matches.length > 0 ? matches : [`  No matches for "${inputBuffer}"`],
        )
        setMode('browse')
        setInputBuffer('')
      } else if (key.escape) {
        setMode('browse')
        setInputBuffer('')
      } else if (key.backspace || key.delete) {
        setInputBuffer(b => b.slice(0, -1))
      } else if (input && !key.ctrl && !key.meta) {
        setInputBuffer(b => b + input)
      }
      return
    }

    if (mode === 'ask') {
      if (key.return) {
        setAskSuggestion(`/papers ask "${inputBuffer}"`)
        setMode('browse')
        setInputBuffer('')
      } else if (key.escape) {
        setMode('browse')
        setInputBuffer('')
      } else if (key.backspace || key.delete) {
        setInputBuffer(b => b.slice(0, -1))
      } else if (input && !key.ctrl && !key.meta) {
        setInputBuffer(b => b + input)
      }
      return
    }

    // Browse mode
    if (key.leftArrow) {
      setIndex(i => (i > 0 ? i - 1 : documents.length - 1))
      setScrollOffset(0)
      setSearchResults([])
      setAskSuggestion('')
    } else if (key.rightArrow) {
      setIndex(i => (i < documents.length - 1 ? i + 1 : 0))
      setScrollOffset(0)
      setSearchResults([])
      setAskSuggestion('')
    } else if (key.upArrow) {
      setScrollOffset(o => Math.max(0, o - 5))
    } else if (key.downArrow) {
      setScrollOffset(o =>
        Math.min(Math.max(0, contentLines.length - maxLines), o + 5),
      )
    } else if (input === '/') {
      setMode('search')
      setInputBuffer('')
      setSearchResults([])
    } else if (input === '?') {
      setMode('ask')
      setInputBuffer('')
      setAskSuggestion('')
    } else if (key.return || input === 'q') {
      onDone(documents.map(d => d.content).join('\n\n---\n\n'))
    }
  })

  return (
    <Box flexDirection="column">
      {/* Tab bar */}
      <Box marginTop={1}>
        {documents.map((d, i) => (
          <Box key={d.label} marginRight={2}>
            <Text
              bold={i === index}
              color={i === index ? 'cyan' : undefined}
              dimColor={i !== index}
            >
              {i === index ? `[ ${d.label} ]` : `  ${d.label}  `}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Document content */}
      <Box marginTop={1} flexDirection="column">
        {visibleLines.map((line, i) => (
          <Box key={scrollOffset + i}>
            <Text wrap="truncate-end">{line}</Text>
          </Box>
        ))}
        {contentLines.length > maxLines && (
          <Text dimColor>
            Lines {scrollOffset + 1}-
            {Math.min(scrollOffset + maxLines, contentLines.length)} of{' '}
            {contentLines.length} (use up/down arrows to scroll)
          </Text>
        )}
      </Box>

      {/* Search mode input */}
      {mode === 'search' && (
        <Box marginTop={1}>
          <Text color="yellow" bold>
            Search: {inputBuffer}
          </Text>
          <Text dimColor> (Enter to search, Esc to cancel)</Text>
        </Box>
      )}

      {/* Ask mode input */}
      {mode === 'ask' && (
        <Box marginTop={1}>
          <Text color="yellow" bold>
            Question: {inputBuffer}
          </Text>
          <Text dimColor> (Enter to submit, Esc to cancel)</Text>
        </Box>
      )}

      {/* Search results */}
      {searchResults.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold underline>
            Search Results
          </Text>
          {searchResults.map((line, i) => (
            <Box key={i}>
              <Text>{line}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Ask suggestion */}
      {askSuggestion && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="green">
            Run this command to ask your question:
          </Text>
          <Text> {askSuggestion}</Text>
        </Box>
      )}
    </Box>
  )
}
