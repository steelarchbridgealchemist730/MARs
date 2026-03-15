import type { Command } from '@commands'
import { probeSystem, type SystemCapabilities } from '../paper/system-probe'

function tick(v: boolean): string {
  return v ? '\u2705' : '\u274C'
}

function formatSystemCheck(caps: SystemCapabilities): string {
  const lines: string[] = []

  lines.push('\uD83D\uDDA5\uFE0F  System Check')

  // OS
  const platformLabel =
    caps.os.name.toLowerCase() === 'darwin'
      ? 'macOS'
      : caps.os.name.toLowerCase() === 'linux'
        ? 'Linux'
        : caps.os.name
  lines.push(`  OS: ${platformLabel} ${caps.os.version} (${caps.os.arch})`)

  // CPU
  lines.push(`  CPU: ${caps.cpu.model} (${caps.cpu.cores} cores)`)

  // RAM
  lines.push(
    `  RAM: ${caps.memory.total_gb} GB total, ${caps.memory.available_gb} GB available`,
  )

  // Disk — show the root mount if present, otherwise first entry
  const rootDisk = caps.disk.find(d => d.mount_point === '/') ?? caps.disk[0]
  if (rootDisk) {
    lines.push(
      `  Disk: ${rootDisk.mount_point} \u2014 ${rootDisk.free_gb} GB free / ${rootDisk.total_gb} GB total`,
    )
  } else {
    lines.push('  Disk: Not available')
  }

  // GPU
  if (caps.gpu.available && caps.gpu.devices.length > 0) {
    const d = caps.gpu.devices[0]
    lines.push(`  GPU: ${d.name} (${d.vram_gb} GB VRAM)`)
  } else {
    lines.push('  GPU: Not available')
  }

  // Python
  if (caps.python.version) {
    lines.push(
      `  Python: ${caps.python.version} (uv ${tick(caps.python.uv_available)}, conda ${tick(caps.python.conda_available)})`,
    )
  } else {
    lines.push('  Python: Not found')
  }

  // Docker
  if (caps.docker.available) {
    lines.push(`  Docker: ${caps.docker.version ?? 'available'}`)
  } else {
    lines.push('  Docker: Not available')
  }

  // LaTeX
  const latexParts = [
    `pdflatex ${tick(caps.latex.pdflatex)}`,
    `xelatex ${tick(caps.latex.xelatex)}`,
    `latexmk ${tick(caps.latex.latexmk)}`,
  ]
  lines.push(`  LaTeX: ${latexParts.join('  ')}`)

  // Git
  if (caps.git.available) {
    lines.push(
      `  Git: ${caps.git.version ?? 'available'} (gh CLI ${tick(caps.git.gh_cli)})`,
    )
  } else {
    lines.push('  Git: Not available')
  }

  return lines.join('\n')
}

const systemCheck: Command = {
  type: 'local',
  name: 'system-check',
  userFacingName() {
    return 'system-check'
  },
  description:
    'Detect and display system capabilities (GPU, LaTeX, Python, etc.)',
  isEnabled: true,
  isHidden: false,
  argumentHint: undefined,
  aliases: [],

  async call(_args: string): Promise<string> {
    const caps = await probeSystem()
    return formatSystemCheck(caps)
  },
}

export default systemCheck
