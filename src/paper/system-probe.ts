export interface SystemCapabilities {
  os: { name: string; version: string; arch: string }
  cpu: { model: string; cores: number }
  memory: { total_gb: number; available_gb: number }
  disk: Array<{ mount_point: string; total_gb: number; free_gb: number }>
  gpu: {
    available: boolean
    devices: Array<{ name: string; vram_gb: number; cuda_version?: string }>
    pytorch_cuda: boolean
  }
  python: {
    version: string
    path: string
    uv_available: boolean
    conda_available: boolean
  }
  docker: { available: boolean; version?: string }
  latex: {
    pdflatex: boolean
    xelatex: boolean
    lualatex: boolean
    bibtex: boolean
    latexmk: boolean
  }
  network: { download_mbps?: number }
  git: { available: boolean; version?: string; gh_cli: boolean }
}

export class SystemProbe {
  private async runCmd(cmd: string): Promise<string> {
    try {
      const parts = cmd.split(' ')
      const proc = Bun.spawn(parts, { stdout: 'pipe', stderr: 'pipe' })
      const text = await new Response(proc.stdout).text()
      return text.trim()
    } catch {
      return ''
    }
  }

  async probe(): Promise<SystemCapabilities> {
    const [
      osName,
      osVersion,
      osArch,
      cpuCoresMac,
      cpuModelMac,
      lscpuRaw,
      vmstatRaw,
      memsizeRaw,
      freeRaw,
      dfRaw,
      nvidiaSmiRaw,
      pytorchCudaRaw,
      pythonVersionRaw,
      pythonPathRaw,
      uvRaw,
      condaRaw,
      dockerRaw,
      whichPdflatex,
      whichXelatex,
      whichLualatex,
      whichBibtex,
      whichLatexmk,
      gitRaw,
      ghRaw,
    ] = await Promise.all([
      this.runCmd('uname -s'),
      this.runCmd('uname -r'),
      this.runCmd('uname -m'),
      this.runCmd('sysctl -n hw.physicalcpu'),
      this.runCmd('sysctl -n machdep.cpu.brand_string'),
      this.runCmd('lscpu'),
      this.runCmd('vm_stat'),
      this.runCmd('sysctl -n hw.memsize'),
      this.runCmd('free -b'),
      this.runCmd('df -k /'),
      this.runCmd(
        'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
      ),
      this.runCmd(
        'python3 -c "import torch; print(torch.cuda.is_available())"',
      ),
      this.runCmd('python3 --version'),
      this.runCmd('which python3'),
      this.runCmd('uv --version'),
      this.runCmd('conda --version'),
      this.runCmd('docker --version'),
      this.runCmd('which pdflatex'),
      this.runCmd('which xelatex'),
      this.runCmd('which lualatex'),
      this.runCmd('which bibtex'),
      this.runCmd('which latexmk'),
      this.runCmd('git --version'),
      this.runCmd('gh --version'),
    ])

    // OS
    const isDarwin =
      (osName || '').toLowerCase() === 'darwin' || process.platform === 'darwin'

    const os = {
      name: osName || process.platform,
      version: osVersion || 'unknown',
      arch: osArch || process.arch,
    }

    // CPU
    let cpuModel = 'unknown'
    let cpuCores = 0

    if (isDarwin) {
      cpuModel = cpuModelMac || 'unknown'
      const n = parseInt(cpuCoresMac, 10)
      cpuCores = isNaN(n) ? 0 : n
    } else {
      const modelLine = lscpuRaw
        .split('\n')
        .find(l => l.startsWith('Model name:'))
      if (modelLine) {
        cpuModel = modelLine.replace('Model name:', '').trim()
      }
      const coresLine = lscpuRaw.split('\n').find(l => /^CPU\(s\):/.test(l))
      if (coresLine) {
        const n = parseInt(coresLine.replace(/^CPU\(s\):/, '').trim(), 10)
        cpuCores = isNaN(n) ? 0 : n
      }
    }

    const cpu = { model: cpuModel, cores: cpuCores }

    // Memory
    let totalMemBytes = 0
    let availableMemBytes = 0

    if (isDarwin) {
      const totalParsed = parseInt(memsizeRaw, 10)
      if (!isNaN(totalParsed)) totalMemBytes = totalParsed

      // vm_stat reports pages; macOS default page size is 16384 bytes
      const PAGE_SIZE = 16384
      const pagesFreeMatch = vmstatRaw.match(/Pages free:\s+(\d+)/)
      const pagesInactiveMatch = vmstatRaw.match(/Pages inactive:\s+(\d+)/)
      const pagesFree = pagesFreeMatch ? parseInt(pagesFreeMatch[1], 10) : 0
      const pagesInactive = pagesInactiveMatch
        ? parseInt(pagesInactiveMatch[1], 10)
        : 0
      availableMemBytes = (pagesFree + pagesInactive) * PAGE_SIZE
    } else {
      // `free -b`: Mem: total used free shared buff/cache available
      const memLine = freeRaw.split('\n').find(l => l.startsWith('Mem:'))
      if (memLine) {
        const cols = memLine.trim().split(/\s+/)
        const total = parseInt(cols[1], 10)
        // column 6 is "available" (Linux >= 3.14); fall back to "free" (col 3)
        const available = parseInt(cols[6] ?? cols[3], 10)
        if (!isNaN(total)) totalMemBytes = total
        if (!isNaN(available)) availableMemBytes = available
      }
    }

    const memory = {
      total_gb: parseFloat((totalMemBytes / 1e9).toFixed(2)),
      available_gb: parseFloat((availableMemBytes / 1e9).toFixed(2)),
    }

    // Disk — parse `df -k /`
    const disk: SystemCapabilities['disk'] = []
    const dfLines = dfRaw.split('\n').slice(1) // skip header
    for (const line of dfLines) {
      if (!line.trim()) continue
      const cols = line.trim().split(/\s+/)
      // df -k columns: Filesystem 1K-blocks Used Available Use% Mounted-on
      if (cols.length >= 6) {
        const totalKb = parseInt(cols[1], 10)
        const freeKb = parseInt(cols[3], 10)
        const mount = cols[cols.length - 1]
        if (!isNaN(totalKb) && !isNaN(freeKb)) {
          disk.push({
            mount_point: mount,
            total_gb: parseFloat((totalKb / 1e6).toFixed(2)),
            free_gb: parseFloat((freeKb / 1e6).toFixed(2)),
          })
        }
      }
    }

    // GPU — nvidia-smi
    const gpuAvailable = nvidiaSmiRaw.length > 0
    const gpuDevices: SystemCapabilities['gpu']['devices'] = []

    if (gpuAvailable) {
      for (const line of nvidiaSmiRaw.split('\n')) {
        if (!line.trim()) continue
        const commaIdx = line.lastIndexOf(',')
        if (commaIdx === -1) continue
        const name = line.slice(0, commaIdx).trim()
        const vramMib = parseFloat(line.slice(commaIdx + 1).trim())
        gpuDevices.push({
          name,
          vram_gb: isNaN(vramMib) ? 0 : parseFloat((vramMib / 1024).toFixed(2)),
        })
      }
    }

    const pytorch_cuda = pytorchCudaRaw === 'True'

    const gpu: SystemCapabilities['gpu'] = {
      available: gpuAvailable,
      devices: gpuDevices,
      pytorch_cuda,
    }

    // Python
    const pythonVersionMatch = pythonVersionRaw.match(/Python\s+([\d.]+)/)
    const python: SystemCapabilities['python'] = {
      version: pythonVersionMatch ? pythonVersionMatch[1] : '',
      path: pythonPathRaw,
      uv_available: uvRaw.length > 0,
      conda_available: condaRaw.length > 0,
    }

    // Docker
    const dockerVersionMatch = dockerRaw.match(
      /Docker version\s+([\d.]+[^\s,]*)/,
    )
    const docker: SystemCapabilities['docker'] = {
      available: dockerRaw.length > 0,
      version: dockerVersionMatch ? dockerVersionMatch[1] : undefined,
    }

    // LaTeX
    const latex: SystemCapabilities['latex'] = {
      pdflatex: whichPdflatex.length > 0,
      xelatex: whichXelatex.length > 0,
      lualatex: whichLualatex.length > 0,
      bibtex: whichBibtex.length > 0,
      latexmk: whichLatexmk.length > 0,
    }

    // Network — lightweight test via curl (small download, measures throughput)
    let downloadMbps: number | undefined
    try {
      const start = Date.now()
      const netProc = Bun.spawn(
        [
          'curl',
          '-sS',
          '-o',
          '/dev/null',
          '-w',
          '%{speed_download}',
          '--max-time',
          '5',
          'https://speed.cloudflare.com/__down?bytes=1000000',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const speedText = await new Response(netProc.stdout).text()
      await netProc.exited
      if (netProc.exitCode === 0) {
        const bytesPerSec = parseFloat(speedText.trim())
        if (!isNaN(bytesPerSec) && bytesPerSec > 0) {
          downloadMbps = parseFloat(((bytesPerSec * 8) / 1_000_000).toFixed(1))
        }
      }
    } catch {
      // network test failed, not critical
    }
    const network: SystemCapabilities['network'] = {
      download_mbps: downloadMbps,
    }

    // Git
    const gitVersionMatch = gitRaw.match(/git version\s+([\d.]+)/)
    const git: SystemCapabilities['git'] = {
      available: gitRaw.length > 0,
      version: gitVersionMatch ? gitVersionMatch[1] : undefined,
      gh_cli: ghRaw.length > 0,
    }

    return { os, cpu, memory, disk, gpu, python, docker, latex, network, git }
  }

  async formatSummary(caps: SystemCapabilities): Promise<string> {
    const lines: string[] = []

    const pad = (label: string, value: string): string =>
      `  ${label.padEnd(20)} ${value}`

    lines.push('=== System Capabilities ===')
    lines.push('')

    lines.push('[OS]')
    lines.push(pad('Name:', caps.os.name))
    lines.push(pad('Version:', caps.os.version))
    lines.push(pad('Arch:', caps.os.arch))
    lines.push('')

    lines.push('[CPU]')
    lines.push(pad('Model:', caps.cpu.model))
    lines.push(pad('Cores:', String(caps.cpu.cores)))
    lines.push('')

    lines.push('[Memory]')
    lines.push(pad('Total:', `${caps.memory.total_gb} GB`))
    lines.push(pad('Available:', `${caps.memory.available_gb} GB`))
    lines.push('')

    lines.push('[Disk]')
    if (caps.disk.length === 0) {
      lines.push('  (no disk info)')
    } else {
      for (const d of caps.disk) {
        lines.push(
          pad(
            `${d.mount_point}:`,
            `${d.free_gb} GB free / ${d.total_gb} GB total`,
          ),
        )
      }
    }
    lines.push('')

    lines.push('[GPU]')
    lines.push(pad('Available:', caps.gpu.available ? 'yes' : 'no'))
    if (caps.gpu.available && caps.gpu.devices.length > 0) {
      caps.gpu.devices.forEach((d, i) => {
        lines.push(pad(`Device ${i}:`, `${d.name} (${d.vram_gb} GB VRAM)`))
      })
    }
    lines.push(pad('PyTorch CUDA:', caps.gpu.pytorch_cuda ? 'yes' : 'no'))
    lines.push('')

    lines.push('[Python]')
    lines.push(pad('Version:', caps.python.version || 'not found'))
    lines.push(pad('Path:', caps.python.path || 'not found'))
    lines.push(pad('uv:', caps.python.uv_available ? 'available' : 'not found'))
    lines.push(
      pad('conda:', caps.python.conda_available ? 'available' : 'not found'),
    )
    lines.push('')

    lines.push('[Docker]')
    lines.push(
      pad(
        'Available:',
        caps.docker.available
          ? `yes (${caps.docker.version ?? 'unknown version'})`
          : 'no',
      ),
    )
    lines.push('')

    lines.push('[LaTeX]')
    const latexEntries: Array<[string, boolean]> = [
      ['pdflatex', caps.latex.pdflatex],
      ['xelatex', caps.latex.xelatex],
      ['lualatex', caps.latex.lualatex],
      ['bibtex', caps.latex.bibtex],
      ['latexmk', caps.latex.latexmk],
    ]
    for (const [name, available] of latexEntries) {
      lines.push(pad(`${name}:`, available ? 'available' : 'not found'))
    }
    lines.push('')

    lines.push('[Network]')
    lines.push(
      pad(
        'Download:',
        caps.network.download_mbps
          ? `${caps.network.download_mbps} Mbps`
          : 'not tested',
      ),
    )
    lines.push('')

    lines.push('[Git]')
    lines.push(
      pad(
        'git:',
        caps.git.available
          ? `available (${caps.git.version ?? 'unknown version'})`
          : 'not found',
      ),
    )
    lines.push(pad('gh CLI:', caps.git.gh_cli ? 'available' : 'not found'))
    lines.push('')

    return lines.join('\n')
  }
}

export async function probeSystem(): Promise<SystemCapabilities> {
  return new SystemProbe().probe()
}
