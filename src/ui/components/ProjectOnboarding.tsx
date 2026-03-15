import * as React from 'react'
import { OrderedList } from '@inkjs/ui'
import { Box, Text } from 'ink'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '@utils/config'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { getTheme } from '@utils/theme'
import { RELEASE_NOTES } from '@constants/releaseNotes'
import { gt } from 'semver'
import { isDirEmpty } from '@utils/fs/file'
import { MACRO } from '@constants/macros'
import { PROJECT_FILE, PRODUCT_NAME } from '@constants/product'

export function markProjectOnboardingComplete(): void {
  const projectConfig = getCurrentProjectConfig()
  if (!projectConfig.hasCompletedProjectOnboarding) {
    saveCurrentProjectConfig({
      ...projectConfig,
      hasCompletedProjectOnboarding: true,
    })
  }
}

function markReleaseNotesSeen(): void {
  const config = getGlobalConfig()
  saveGlobalConfig({
    ...config,
    lastReleaseNotesSeen: MACRO.VERSION,
  })
}

type Props = {
  workspaceDir: string
}

export default function ProjectOnboarding({
  workspaceDir,
}: Props): React.ReactNode {
  const projectConfig = getCurrentProjectConfig()
  const showOnboarding = !projectConfig.hasCompletedProjectOnboarding

  const config = getGlobalConfig()
  const previousVersion = config.lastReleaseNotesSeen

  let releaseNotesToShow: string[] = []
  if (!previousVersion || gt(MACRO.VERSION, previousVersion)) {
    releaseNotesToShow = RELEASE_NOTES[MACRO.VERSION] || []
  }
  const hasReleaseNotes = releaseNotesToShow.length > 0

  React.useEffect(() => {
    if (hasReleaseNotes && !showOnboarding) {
      markReleaseNotesSeen()
    }
  }, [hasReleaseNotes, showOnboarding])

  if (!showOnboarding && !hasReleaseNotes) {
    return null
  }

  const workspaceHasProjectGuide = existsSync(join(workspaceDir, PROJECT_FILE))
  const isWorkspaceDirEmpty = isDirEmpty(workspaceDir)
  const shouldRecommendProjectGuide =
    !workspaceHasProjectGuide && !isWorkspaceDirEmpty

  const theme = getTheme()

  return (
    <Box flexDirection="column" gap={1} padding={1} paddingBottom={0}>
      {showOnboarding && (
        <>
          <Text color={theme.secondaryText}>Quick start:</Text>
          <Box flexDirection="column" marginLeft={1}>
            <Text color={theme.secondaryText}>
              -{' '}
              <Text color={theme.text}>
                /deep-research &quot;your topic&quot;
              </Text>{' '}
              to start literature review
            </Text>
            <Text color={theme.secondaryText}>
              - <Text color={theme.text}>/propose</Text> to generate research
              proposals
            </Text>
            <Text color={theme.secondaryText}>
              - <Text color={theme.text}>/auto &quot;topic&quot;</Text> to run
              the full pipeline automatically
            </Text>
            <Text color={theme.secondaryText}>
              - <Text color={theme.text}>/help</Text> to see all commands
            </Text>
          </Box>
        </>
      )}

      {!showOnboarding && hasReleaseNotes && (
        <Box
          borderColor={getTheme().secondaryBorder}
          flexDirection="column"
          marginRight={1}
        >
          <Box flexDirection="column" gap={0}>
            <Box marginBottom={1}>
              <Text>🆕 What&apos;s new in v{MACRO.VERSION}:</Text>
            </Box>
            <Box flexDirection="column" marginLeft={1}>
              {releaseNotesToShow.map((note, noteIndex) => (
                <React.Fragment key={noteIndex}>
                  <Text color={getTheme().secondaryText}>• {note}</Text>
                </React.Fragment>
              ))}
            </Box>
          </Box>
        </Box>
      )}

      {workspaceDir === homedir() && (
        <Text color={getTheme().warning}>
          Note: You have launched <Text bold>Claude Paper</Text> in your home
          directory. For the best experience, launch it in a project directory
          instead.
        </Text>
      )}
    </Box>
  )
}
