import React from 'react'

import { MACRO } from '@constants/macros'
import { PaperOnboarding } from '@components/PaperOnboarding'
import { TrustDialog } from '@components/TrustDialog'
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from '@utils/config'
import { clearTerminal } from '@utils/terminal'
import { grantReadPermissionForOriginalDir } from '@utils/permissions/filesystem'
import { handleMcprcServerApprovals } from '@screens/MCPServerApproval'

export function completeOnboarding(): void {
  const config = getGlobalConfig()

  // Ensure a default model profile exists so Kode doesn't show its own model setup
  const profiles = config.modelProfiles ?? []
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? ''
  if (profiles.length === 0 && anthropicKey) {
    profiles.push({
      name: 'Claude Sonnet 4.6',
      provider: 'anthropic',
      modelName: 'claude-sonnet-4-6',
      apiKey: anthropicKey,
      maxTokens: 16384,
      contextLength: 200000,
      reasoningEffort: 'high',
      isActive: true,
      createdAt: Date.now(),
    } as any)
  }

  saveGlobalConfig({
    ...config,
    theme: config.theme || 'dark',
    hasCompletedOnboarding: true,
    lastOnboardingVersion: MACRO.VERSION,
    modelProfiles: profiles,
    modelPointers:
      config.modelPointers ??
      (anthropicKey
        ? {
            main: 'claude-sonnet-4-6',
            task: 'claude-sonnet-4-6',
            compact: 'claude-sonnet-4-6',
            quick: 'claude-sonnet-4-6',
          }
        : undefined),
  })
}

export async function showSetupScreens(
  safeMode?: boolean,
  print?: boolean,
): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    return
  }

  const config = getGlobalConfig()
  if (!config.theme || !config.hasCompletedOnboarding) {
    await clearTerminal()
    const { render } = await import('ink')
    await new Promise<void>(resolve => {
      render(
        <PaperOnboarding
          onDone={async () => {
            completeOnboarding()
            await clearTerminal()
            resolve()
          }}
        />,
        {
          exitOnCtrlC: false,
        },
      )
    })
  }

  if (!print) {
    if (safeMode) {
      if (!checkHasTrustDialogAccepted()) {
        await new Promise<void>(resolve => {
          const onDone = () => {
            grantReadPermissionForOriginalDir()
            resolve()
          }
          ;(async () => {
            const { render } = await import('ink')
            render(<TrustDialog onDone={onDone} />, {
              exitOnCtrlC: false,
            })
          })()
        })
      }
    }

    await handleMcprcServerApprovals()
  }
}
