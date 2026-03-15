import type { ExperimentPlan, ResourceEstimate } from './types'

/** Known dependency → resource impact mappings */
const DEP_PROFILES: Record<
  string,
  { gpu?: boolean; vram_gb?: number; ram_gb?: number; disk_gb?: number }
> = {
  torch: { gpu: true, vram_gb: 8, ram_gb: 16 },
  pytorch: { gpu: true, vram_gb: 8, ram_gb: 16 },
  tensorflow: { gpu: true, vram_gb: 8, ram_gb: 16 },
  tf: { gpu: true, vram_gb: 8, ram_gb: 16 },
  jax: { gpu: true, vram_gb: 8, ram_gb: 16 },
  flax: { gpu: true, vram_gb: 8, ram_gb: 16 },
  transformers: { gpu: true, vram_gb: 16, ram_gb: 32, disk_gb: 20 },
  diffusers: { gpu: true, vram_gb: 24, ram_gb: 32, disk_gb: 30 },
  accelerate: { gpu: true, vram_gb: 16, ram_gb: 32 },
  xgboost: { ram_gb: 16 },
  lightgbm: { ram_gb: 16 },
  pandas: { ram_gb: 8 },
  polars: { ram_gb: 8 },
  dask: { ram_gb: 16, disk_gb: 20 },
  spark: { ram_gb: 32, disk_gb: 50 },
  pyspark: { ram_gb: 32, disk_gb: 50 },
  scipy: { ram_gb: 8 },
  numpy: { ram_gb: 4 },
  sklearn: { ram_gb: 8 },
  'scikit-learn': { ram_gb: 8 },
  opencv: { ram_gb: 8, disk_gb: 5 },
  cv2: { ram_gb: 8, disk_gb: 5 },
}

/** Description keyword → scale multiplier */
const SCALE_KEYWORDS: Array<{ pattern: RegExp; multiplier: number }> = [
  { pattern: /\b(billion|1b|7b|13b|70b)\b/i, multiplier: 4 },
  { pattern: /\blarge\s*(language\s*)?model\b/i, multiplier: 3 },
  { pattern: /\bllm\b/i, multiplier: 3 },
  { pattern: /\bfine-?tun/i, multiplier: 2 },
  { pattern: /\b(100\s*million|100m\+?)\b/i, multiplier: 2 },
  { pattern: /\blarge\s*dataset\b/i, multiplier: 1.5 },
  { pattern: /\bbig\s*data\b/i, multiplier: 1.5 },
  { pattern: /\b(distributed|multi-?node)\b/i, multiplier: 2 },
  { pattern: /\b(monte\s*carlo|simulation)\b/i, multiplier: 1.3 },
  { pattern: /\b(sweep|grid\s*search|hyperparameter)\b/i, multiplier: 1.5 },
]

export class ResourceEstimator {
  async estimate(
    plan: Partial<ExperimentPlan>,
    systemCaps: any,
  ): Promise<ResourceEstimate> {
    const deps = plan.dependencies ?? []
    const description = (plan.description ?? '').toLowerCase()
    const allText = description + ' ' + deps.join(' ')

    // Compute resource needs from dependency profiles
    let gpu_required = false
    let peak_vram_gb = 0
    let ram_gb = 4 // baseline
    let disk_gb = 2 // baseline

    for (const dep of deps) {
      const depLower = dep
        .toLowerCase()
        .replace(/[>=<~^!]/g, '')
        .split('[')[0]
      for (const [key, profile] of Object.entries(DEP_PROFILES)) {
        if (depLower.includes(key)) {
          if (profile.gpu) gpu_required = true
          peak_vram_gb = Math.max(peak_vram_gb, profile.vram_gb ?? 0)
          ram_gb = Math.max(ram_gb, profile.ram_gb ?? 0)
          disk_gb = Math.max(disk_gb, profile.disk_gb ?? 0)
        }
      }
    }

    // Also detect GPU need from description
    if (
      !gpu_required &&
      /\b(gpu|cuda|nccl|train\s+model)\b/i.test(description)
    ) {
      gpu_required = true
      peak_vram_gb = Math.max(peak_vram_gb, 8)
      ram_gb = Math.max(ram_gb, 16)
    }

    // Account for dataset sizes from plan
    if (plan.datasets) {
      for (const ds of plan.datasets) {
        if (ds.estimated_size_gb) {
          disk_gb += ds.estimated_size_gb
          // Data needs ~2x size in RAM for processing
          ram_gb = Math.max(ram_gb, Math.ceil(ds.estimated_size_gb * 2))
        }
      }
    }

    // Apply scale multiplier from description keywords
    let scaleMultiplier = 1
    for (const { pattern, multiplier } of SCALE_KEYWORDS) {
      if (pattern.test(allText)) {
        scaleMultiplier = Math.max(scaleMultiplier, multiplier)
      }
    }

    if (scaleMultiplier > 1) {
      peak_vram_gb = Math.ceil(peak_vram_gb * scaleMultiplier)
      ram_gb = Math.ceil(ram_gb * Math.min(scaleMultiplier, 2))
      disk_gb = Math.ceil(disk_gb * Math.min(scaleMultiplier, 2))
    }

    // Estimate wall time based on task complexity
    let estimated_wall_time_hours = 0.5 // baseline for simple tasks
    if (gpu_required) {
      estimated_wall_time_hours = Math.max(
        1,
        Math.ceil(peak_vram_gb / 8) * scaleMultiplier,
      )
    } else if (ram_gb >= 16) {
      estimated_wall_time_hours = Math.max(1, scaleMultiplier)
    }
    if (/\b(sweep|grid\s*search)\b/i.test(description)) {
      estimated_wall_time_hours *= 3
    }

    let gpu_hours = gpu_required
      ? Math.ceil(estimated_wall_time_hours)
      : undefined

    // Feasibility check against system capabilities
    let feasible = true
    let bottleneck: string | undefined

    if (gpu_required) {
      const gpuAvailable =
        systemCaps?.gpu?.available === true &&
        (systemCaps?.gpu?.devices?.length ?? 0) > 0
      if (!gpuAvailable) {
        feasible = false
        bottleneck = 'No GPU available'
      } else if (peak_vram_gb > 0) {
        const maxVram = Math.max(
          0,
          ...(systemCaps?.gpu?.devices ?? []).map((d: any) => d.vram_gb ?? 0),
        )
        if (maxVram < peak_vram_gb) {
          feasible = false
          bottleneck = `Insufficient VRAM: need ${peak_vram_gb} GB, have ${maxVram} GB`
        }
      }
    }

    if (feasible && systemCaps?.memory?.available_gb !== undefined) {
      if (systemCaps.memory.available_gb < ram_gb) {
        feasible = false
        bottleneck = `Insufficient RAM: need ${ram_gb} GB, have ${systemCaps.memory.available_gb} GB available`
      }
    }

    if (feasible && systemCaps?.disk !== undefined) {
      const rootDisk =
        systemCaps.disk.find((d: any) => d.mount_point === '/') ??
        systemCaps.disk[0]
      if (rootDisk && rootDisk.free_gb < disk_gb) {
        feasible = false
        bottleneck = `Insufficient disk space: need ${disk_gb} GB, have ${rootDisk.free_gb} GB free`
      }
    }

    return {
      gpu_required,
      gpu_hours,
      peak_vram_gb: gpu_required ? peak_vram_gb : undefined,
      ram_gb,
      disk_gb,
      estimated_wall_time_hours,
      feasible,
      bottleneck,
    }
  }
}
