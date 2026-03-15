export interface ExperimentPlan {
  id: string
  proposal_id: string
  title: string
  description: string
  scripts: Array<{
    name: string
    filename: string
    description: string
    language: 'python' | 'bash' | 'r'
  }>
  dependencies: string[] // pip packages
  datasets: DataRequirement[]
  resource_estimate: ResourceEstimate
  created_at: string
}

export interface DataRequirement {
  name: string
  source: string // 'huggingface' | 'kaggle' | 'yahoo_finance' | 'fred' | 'custom' | etc.
  auto_downloadable: boolean
  instructions?: string
  estimated_size_gb?: number
}

export interface ResourceEstimate {
  gpu_required: boolean
  gpu_hours?: number
  peak_vram_gb?: number
  ram_gb: number
  disk_gb: number
  estimated_wall_time_hours: number
  feasible: boolean
  bottleneck?: string // why not feasible
}

export interface ExperimentRun {
  id: string
  plan_id: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted'
  started_at?: string
  completed_at?: string
  exit_code?: number
  output_files: string[]
  metrics: Record<string, number | string>
  logs_path?: string
  error?: string
}

export type IsolationMode = 'uv' | 'docker' | 'venv' | 'none'
