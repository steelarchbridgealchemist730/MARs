import React, { createContext, useContext, useEffect } from 'react'
import { Box, Text } from 'ink'
import { useTerminalSize } from '../hooks/useTerminalSize'

interface FullscreenDimensions {
  contentHeight: number
  contentWidth: number
}

const FullscreenContext = createContext<FullscreenDimensions>({
  contentHeight: 20,
  contentWidth: 76,
})

export function useFullscreenDimensions(): FullscreenDimensions {
  return useContext(FullscreenContext)
}

interface FullscreenLayoutProps {
  title: string
  subtitle?: string
  borderColor: string
  accentColor: string
  icon?: string
  footer?: React.ReactNode
}

export function FullscreenLayout({
  title,
  subtitle,
  borderColor,
  accentColor,
  icon,
  children,
  footer,
}: React.PropsWithChildren<FullscreenLayoutProps>): React.ReactNode {
  const { columns, rows } = useTerminalSize()

  useEffect(() => {
    // Switch to alternate screen buffer — completely hides Logo and any
    // previous output, just like vim/less/htop do. This is a terminal-level
    // feature that works regardless of Ink internals.
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H')

    // Also clear Ink internals (best-effort) to prevent overflow path issues.
    // Use dynamic import() to avoid CJS/ESM mismatch that causes require()
    // to return a different module instance than Ink's own import-based code.
    let savedStaticOutput: string | undefined
    let savedLastOutput: string | undefined
    let inkInstance: any
    ;(async () => {
      try {
        const mod = await import('ink/build/instances.js')
        const instances = (mod.default ?? mod) as WeakMap<object, any>
        inkInstance = instances.get(process.stdout)
        if (inkInstance && typeof inkInstance.fullStaticOutput === 'string') {
          savedStaticOutput = inkInstance.fullStaticOutput
          savedLastOutput = inkInstance.lastOutput
          inkInstance.fullStaticOutput = ''
          inkInstance.log?.clear?.()
          inkInstance.lastOutput = ''
        }
      } catch {
        // Ink internals not accessible — alternate screen handles it
      }
    })()

    return () => {
      // Exit alternate screen first — restores main screen content
      process.stdout.write('\x1b[?1049l')
      // Restore Ink state to match what's on the main screen
      if (inkInstance && savedStaticOutput !== undefined) {
        inkInstance.fullStaticOutput = savedStaticOutput
        if (savedLastOutput !== undefined) {
          inkInstance.lastOutput = savedLastOutput
        }
        // Re-sync log-update: clear() resets previousLineCount to 0, then
        // log() writes savedLastOutput which sets previousLineCount to match
        // the main screen. This overwrites with the exact same content that
        // \x1b[?1049l restored, so visually it's a no-op.
        if (inkInstance.log) {
          inkInstance.log.clear()
          inkInstance.log(savedLastOutput ?? '')
        }
      }
    }
  }, [])

  // Use rows-3 so Ink's dynamic outputHeight stays well below stdout.rows.
  // When outputHeight >= stdout.rows, Ink's overflow path (ink.js:121)
  // writes clearTerminal every frame causing flickering. The extra margin
  // accounts for Ink's trailing newline and any residual line from the
  // logUpdate cursor positioning.
  const layoutHeight = Math.max(10, rows - 3)

  // 2 border lines + 3 header (title + subtitle + separator) + 1 separator + 2 footer
  const headerLines = subtitle ? 3 : 2
  const footerLines = footer ? 2 : 0
  const contentHeight = Math.max(
    4,
    layoutHeight - 2 - headerLines - footerLines,
  )
  const contentWidth = Math.max(20, columns - 4)

  const dims: FullscreenDimensions = { contentHeight, contentWidth }
  const separatorChar = '\u2500'
  const separator = separatorChar.repeat(Math.max(0, contentWidth))

  return (
    <Box
      flexDirection="column"
      width={columns}
      height={layoutHeight}
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
    >
      {/* Header */}
      <Box>
        {icon && <Text color={accentColor}>{icon} </Text>}
        <Text color={accentColor} bold>
          Claude Paper
        </Text>
        <Text dimColor> · </Text>
        <Text bold>{title}</Text>
      </Box>
      {subtitle && (
        <Box>
          <Text dimColor>
            {'  '}
            {subtitle}
          </Text>
        </Box>
      )}
      <Text dimColor>{separator}</Text>

      {/* Content area */}
      <FullscreenContext.Provider value={dims}>
        <Box
          flexDirection="column"
          flexGrow={1}
          height={contentHeight}
          overflowY="hidden"
        >
          {children}
        </Box>
      </FullscreenContext.Provider>

      {/* Footer */}
      {footer && (
        <>
          <Text dimColor>{separator}</Text>
          <Box>{footer}</Box>
        </>
      )}
    </Box>
  )
}
