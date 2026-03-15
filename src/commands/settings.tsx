import React from 'react'
import { Text } from 'ink'
import type { Command } from '@commands'
import {
  CONFIG_PATH,
  loadConfig,
  saveConfig,
  getNestedValue,
  setNestedValue,
  parseValue,
  formatConfig,
} from '../paper/config-io'
import { FullscreenLayout } from '@components/FullscreenLayout'
import { SettingsPanel } from '@components/SettingsPanel'

const settings: Command = {
  type: 'local-jsx',
  name: 'settings',
  userFacingName() {
    return 'settings'
  },
  description: 'View or modify Claude Paper settings',
  isEnabled: true,
  isHidden: false,
  argumentHint: '[key] [value]',
  aliases: [],

  async call(
    onDone: (result?: string) => void,
    _context: any,
    args?: string,
  ): Promise<React.ReactNode> {
    const trimmed = (args ?? '').trim()

    // With args: text-based get/set (backward compat)
    if (trimmed) {
      const parts = trimmed.split(/\s+/)
      const key = parts[0]
      const rawValue = parts.slice(1).join(' ')
      const config = loadConfig()

      if (!rawValue) {
        // Key only: show specific setting
        const value = getNestedValue(config, key)
        if (value === undefined) {
          onDone(
            `Setting "${key}" not found. Available top-level keys: ${Object.keys(config).join(', ')}`,
          )
          return null
        }
        if (typeof value === 'object') {
          onDone(`[${key}]\n${formatConfig(value, key)}`)
          return null
        }
        onDone(`${key} = ${JSON.stringify(value)}`)
        return null
      }

      // Key + value: set setting
      const parsedValue = parseValue(rawValue)
      setNestedValue(config, key, parsedValue)
      saveConfig(config)
      onDone(`Updated: ${key} = ${JSON.stringify(parsedValue)}`)
      return null
    }

    // No args: interactive panel
    return (
      <FullscreenLayout
        title="Settings"
        subtitle="Claude Paper Configuration"
        borderColor="#6366f1"
        accentColor="#818cf8"
        footer={
          <Text dimColor>
            {'<-/-> section  Up/Down navigate  Enter edit  Esc exit'}
          </Text>
        }
      >
        <SettingsPanel onDone={onDone} />
      </FullscreenLayout>
    )
  },
}

export default settings
