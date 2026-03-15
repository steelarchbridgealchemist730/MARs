import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { glob } from 'glob'

describe('Runtime portability', () => {
  test('src/ does not reference Bun.* at runtime (excluding paper modules)', async () => {
    // Claude Paper's paper modules and Bun-native UI/commands are intentionally
    // Bun-first. Only the original Kode-Agent core must remain portable.
    const files = await glob(['src/**/*.{ts,tsx}'], {
      cwd: process.cwd(),
      nodir: true,
      ignore: [
        'src/paper/**',
        'src/tools/paper/**',
        'src/ui/components/PaperOnboarding.tsx',
        'src/commands/auto.ts',
        'src/commands/system-check.ts',
        'src/commands/paper.tsx',
        'src/commands/experiment.tsx',
        'src/commands/papers.tsx',
      ],
    })

    const offenders: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      if (/\bBun\./.test(content)) offenders.push(file)
    }

    expect(offenders).toEqual([])
  })
})
