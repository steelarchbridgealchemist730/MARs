import * as React from 'react'
import type { Command } from '@commands'
import { PaperOnboarding } from '@components/PaperOnboarding'
import { clearTerminal } from '@utils/terminal'
import { getGlobalConfig, saveGlobalConfig } from '@utils/config'
import { clearConversation } from './clear'

export default {
  type: 'local-jsx',
  name: 'onboarding',
  description: 'Run through the Claude Paper setup wizard',
  isEnabled: true,
  isHidden: false,
  async call(onDone, context) {
    await clearTerminal()
    const config = getGlobalConfig()
    saveGlobalConfig({
      ...config,
      theme: config.theme || 'dark',
    })

    return (
      <PaperOnboarding
        onDone={async () => {
          clearConversation(context)
          onDone()
        }}
      />
    )
  },
  userFacingName() {
    return 'onboarding'
  },
} satisfies Command
