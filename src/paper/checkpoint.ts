import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import type { CheckpointData, ProjectState } from './types'

export class CheckpointManager {
  private checkpointDir: string

  constructor(projectDir: string) {
    this.checkpointDir = join(projectDir, '.claude-paper', 'checkpoints')
    mkdirSync(this.checkpointDir, { recursive: true })
  }

  saveCheckpoint(
    label: string,
    state: ProjectState,
    metadata: Record<string, unknown> = {},
  ): string {
    const checkpoint: CheckpointData = {
      label,
      timestamp: new Date().toISOString(),
      state_snapshot: state,
      metadata,
    }

    const filename = `${label}-${Date.now()}.json`
    const filepath = join(this.checkpointDir, filename)
    writeFileSync(filepath, JSON.stringify(checkpoint, null, 2), 'utf-8')
    return filepath
  }

  loadCheckpoint(label: string): CheckpointData | null {
    const files = this.listCheckpointFiles(label)
    if (files.length === 0) return null

    const latest = files[files.length - 1]
    const content = readFileSync(join(this.checkpointDir, latest), 'utf-8')
    return JSON.parse(content) as CheckpointData
  }

  loadLatestCheckpoint(): CheckpointData | null {
    const files = this.listAllCheckpointFiles()
    if (files.length === 0) return null

    const latest = files[files.length - 1]
    const content = readFileSync(join(this.checkpointDir, latest), 'utf-8')
    return JSON.parse(content) as CheckpointData
  }

  listCheckpoints(): { label: string; timestamp: string; file: string }[] {
    const files = this.listAllCheckpointFiles()
    return files.map(f => {
      const content = readFileSync(join(this.checkpointDir, f), 'utf-8')
      const data = JSON.parse(content) as CheckpointData
      return {
        label: data.label,
        timestamp: data.timestamp,
        file: f,
      }
    })
  }

  private listCheckpointFiles(label: string): string[] {
    try {
      return readdirSync(this.checkpointDir)
        .filter(f => f.startsWith(`${label}-`) && f.endsWith('.json'))
        .sort()
    } catch {
      return []
    }
  }

  private listAllCheckpointFiles(): string[] {
    try {
      return readdirSync(this.checkpointDir)
        .filter(f => f.endsWith('.json'))
        .sort()
    } catch {
      return []
    }
  }
}
