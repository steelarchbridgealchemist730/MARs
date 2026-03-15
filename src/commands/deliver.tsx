import React from 'react'
import { join } from 'path'
import type { Command } from '@commands'
import { getCwd } from '@utils/state'
import { getSessionDir } from '../paper/session'
import { DeliveryPackager } from '../paper/delivery/packager'
import type { DeliveryOptions, DeliveryManifest } from '../paper/delivery/types'
import { CommandSpinner } from '@components/CommandSpinner'

function formatManifest(manifest: DeliveryManifest): string {
  const lines = [
    '=== Delivery Package ===',
    `Title:     ${manifest.paper_title}`,
    `Format:    ${manifest.format}`,
    `Created:   ${manifest.created_at}`,
    `Output:    ${manifest.source_dir}`,
    `PDF:       ${manifest.pdf_path}`,
    '',
    `Files (${manifest.files.length}):`,
  ]

  for (const file of manifest.files) {
    lines.push(`  ${file.path}  - ${file.description}`)
  }

  lines.push('=======================')
  return lines.join('\n')
}

const deliver: Command = {
  type: 'local-jsx',
  name: 'deliver',
  userFacingName() {
    return 'deliver'
  },
  description: 'Package and deliver the final paper and code',
  isEnabled: true,
  isHidden: false,
  argumentHint: '[--format arxiv|camera-ready|standard] [--include-code]',
  aliases: [],

  async call(
    onDone: (result?: string) => void,
    _context: any,
    args?: string,
  ): Promise<React.ReactNode> {
    const argsStr = args ?? ''
    const researchDir = getSessionDir()

    const options: DeliveryOptions = {
      format: argsStr.includes('--format arxiv')
        ? 'arxiv'
        : argsStr.includes('--format camera-ready')
          ? 'camera-ready'
          : 'standard',
      include_code: argsStr.includes('--include-code'),
    }

    return (
      <CommandSpinner
        label="Packaging delivery..."
        runner={async () => {
          const packager = new DeliveryPackager(researchDir)
          const manifest = await packager.package(options)
          return formatManifest(manifest)
        }}
        onDone={result => onDone(result)}
      />
    )
  },
}

export default deliver
