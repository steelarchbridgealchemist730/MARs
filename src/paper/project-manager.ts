import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  existsSync,
} from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ProjectState, ProjectConfig, HistoryEntry } from './types'
import { DEFAULT_MODEL_ASSIGNMENTS } from './types'
import { CheckpointManager } from './checkpoint'

const DEFAULT_CONFIG: ProjectConfig = {
  model_assignments: DEFAULT_MODEL_ASSIGNMENTS,
  paper: {
    template: 'neurips',
    compiler: 'pdflatex',
    language: 'english',
    max_pages: 10,
    target_venue: 'NeurIPS 2026',
  },
  literature: {
    sources: ['arxiv', 'semantic_scholar', 'ssrn'],
    arxiv_categories: ['q-fin.ST', 'q-fin.MF', 'stat.ML', 'cs.LG'],
    max_papers: 100,
    year_from: 2018,
    citation_threshold: 5,
  },
  experiment: {
    python_version: '3.10',
    gpu_required: false,
    max_runtime_hours: 4,
    auto_retry_on_error: true,
    max_retries: 3,
  },
  proposals: {
    count: 3,
    include_feasibility: true,
    auto_novelty_check: true,
  },
  review: {
    num_reviewers: 3,
    max_revision_rounds: 3,
    acceptance_threshold: 7,
    auto_accept: false,
  },
  budget: {
    total_usd: 100,
    warn_at_percent: 20,
  },
  auto_mode: false,
}

export class ProjectManager {
  private projectDir: string
  private metaDir: string
  private state: ProjectState | null = null
  private config: ProjectConfig | null = null
  public checkpoint: CheckpointManager

  constructor(projectDir: string) {
    this.projectDir = projectDir
    this.metaDir = join(projectDir, '.claude-paper')
    this.checkpoint = new CheckpointManager(projectDir)
  }

  initProject(
    topic: string,
    name?: string,
    configOverrides?: Partial<ProjectConfig>,
  ): ProjectState {
    const projectName =
      name ??
      topic
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 50)
    const now = new Date().toISOString()

    // Create directory structure
    const dirs = [
      '.claude-paper',
      '.claude-paper/checkpoints',
      'literature/papers',
      'literature/index',
      'literature/notes',
      'proposals',
      'experiments/src',
      'experiments/data',
      'experiments/configs',
      'experiments/results/tables',
      'experiments/results/figures',
      'experiments/results/logs',
      'paper/sections',
      'paper/figures',
      'paper/tables',
      'reviews',
    ]
    for (const dir of dirs) {
      mkdirSync(join(this.projectDir, dir), { recursive: true })
    }

    // Create state (no pipeline stages — orchestrator manages cognitive state)
    this.state = {
      id: randomUUID(),
      name: projectName,
      topic,
      created_at: now,
      updated_at: now,
      model_assignments: {
        ...DEFAULT_MODEL_ASSIGNMENTS,
        ...configOverrides?.model_assignments,
      },
      artifacts: {
        literature_db: join(this.projectDir, 'literature'),
        selected_proposal: null,
        experiment_code: null,
        results_dir: null,
        paper_tex: null,
        compiled_pdf: null,
      },
    }

    // Create config
    this.config = { ...DEFAULT_CONFIG, ...configOverrides }

    // Write files
    this.saveState()
    this.saveConfig()

    // Log history
    this.appendHistory({
      timestamp: now,
      action: 'init',
      details: `Project initialized with topic: "${topic}"`,
    })

    return this.state
  }

  loadProject(): ProjectState {
    const statePath = join(this.metaDir, 'state.json')
    if (!existsSync(statePath)) {
      throw new Error(
        `No project found at ${this.projectDir}. Run 'paper init' first.`,
      )
    }
    const content = readFileSync(statePath, 'utf-8')
    this.state = JSON.parse(content) as ProjectState

    const configPath = join(this.metaDir, 'config.json')
    if (existsSync(configPath)) {
      this.config = JSON.parse(
        readFileSync(configPath, 'utf-8'),
      ) as ProjectConfig
    }

    return this.state
  }

  getState(): ProjectState {
    if (!this.state) {
      throw new Error(
        'Project not loaded. Call loadProject() or initProject() first.',
      )
    }
    return this.state
  }

  setState(state: ProjectState): void {
    this.state = state
    this.saveState()
  }

  getConfig(): ProjectConfig {
    if (!this.config) {
      throw new Error(
        'Config not loaded. Call loadProject() or initProject() first.',
      )
    }
    return this.config
  }

  getArtifacts(): ProjectState['artifacts'] {
    return this.getState().artifacts
  }

  updateArtifact(
    key: keyof ProjectState['artifacts'],
    value: string | null,
  ): void {
    const state = this.getState()
    state.artifacts[key] = value as any
    state.updated_at = new Date().toISOString()
    this.setState(state)
  }

  getProjectDir(): string {
    return this.projectDir
  }

  isInitialized(): boolean {
    return existsSync(join(this.metaDir, 'state.json'))
  }

  appendHistory(entry: HistoryEntry): void {
    const historyPath = join(this.metaDir, 'history.jsonl')
    appendFileSync(historyPath, JSON.stringify(entry) + '\n', 'utf-8')
  }

  getHistory(): HistoryEntry[] {
    const historyPath = join(this.metaDir, 'history.jsonl')
    if (!existsSync(historyPath)) return []
    return readFileSync(historyPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as HistoryEntry)
  }

  private saveState(): void {
    mkdirSync(this.metaDir, { recursive: true })
    writeFileSync(
      join(this.metaDir, 'state.json'),
      JSON.stringify(this.state, null, 2),
      'utf-8',
    )
  }

  private saveConfig(): void {
    mkdirSync(this.metaDir, { recursive: true })
    writeFileSync(
      join(this.metaDir, 'config.json'),
      JSON.stringify(this.config, null, 2),
      'utf-8',
    )
  }
}
