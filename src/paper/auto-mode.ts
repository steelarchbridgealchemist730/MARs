import { mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'
import { DeepResearchEngine } from './deep-research'
import { ProposalGenerator } from './proposal/generator'
import { selectBestProposal } from './proposal/selector'
import { probeSystem } from './system-probe'
import { Orchestrator, type OrchestratorCallbacks } from './orchestrator'
import { executeAgent as dispatchAgent } from './agent-dispatch'
import {
  buildStateContext,
  loadResearchState,
  type ResearchState,
} from './research-state'
import type { Proposal } from './proposal/types'

import { DEFAULT_MODEL_ASSIGNMENTS } from './types'
import { extractModelId } from './agent-dispatch'

const MAX_PROPOSAL_COUNT = 3
const MAX_REDESIGN_ATTEMPTS = 3

/** Resolve role to model ID (strips provider prefix) */
function modelFor(role: keyof typeof DEFAULT_MODEL_ASSIGNMENTS): string {
  return extractModelId(DEFAULT_MODEL_ASSIGNMENTS[role])
}

const DEFAULT_MODEL = modelFor('research')

// Multi-model reviewer pool per spec (Section 六)
const REVIEWER_MODELS = [
  modelFor('review'),
  modelFor('review'),
  modelFor('review'),
]

function log(logPath: string, msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    appendFileSync(logPath, line, 'utf-8')
  } catch {
    // best effort
  }
}

export class AutoModeOrchestrator {
  private projectDir: string
  private logPath: string

  constructor(projectDir: string) {
    this.projectDir = projectDir
    this.logPath = join(projectDir, 'auto-mode.log')
  }

  /** @deprecated Use runAdaptive() instead — this legacy pipeline method is kept only for backward compatibility */
  async run(
    topic: string,
    onLog: (msg: string) => void,
  ): Promise<{ status: string; artifacts: string[] }> {
    // Redirect to adaptive mode — the old pipeline is removed per v3 spec
    return this.runAdaptive(topic, onLog)
  }

  /**
   * v3 adaptive auto mode: bootstrap research + proposals, then hand off to Orchestrator.
   * The Orchestrator uses reflect→decide→execute→digest to adaptively drive the research.
   */
  async runAdaptive(
    topic: string,
    onLog: (msg: string) => void,
    options?: {
      budget_usd?: number
      max_cycles?: number
      research_stance?: 'exploratory' | 'standard'
    },
  ): Promise<{ status: string; artifacts: string[]; state?: ResearchState }> {
    mkdirSync(this.projectDir, { recursive: true })

    const emit = (msg: string) => {
      onLog(msg)
      log(this.logPath, msg)
    }

    const artifacts: string[] = []

    // Phase 1: Deep Research (same as legacy)
    emit('=== Phase 1: Deep Research ===')
    try {
      const researchEngine = new DeepResearchEngine(this.projectDir, {
        depth: 'standard',
      })
      const researchResult = await researchEngine.run(topic, emit)
      artifacts.push(researchResult.survey_path)
      artifacts.push(researchResult.gaps_path)
      emit(`Research complete: ${researchResult.papers_found} papers found`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      emit(`Research failed: ${msg}`)
      return { status: 'research_failed', artifacts }
    }

    // Phase 2: Generate + Select Proposal (with redesign retry)
    emit('=== Phase 2: Generating Proposals ===')
    let selectedProposal: Proposal | null = null

    for (let attempt = 1; attempt <= MAX_REDESIGN_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) {
          emit(`Redesign attempt ${attempt}/${MAX_REDESIGN_ATTEMPTS}...`)
        }
        const generator = new ProposalGenerator(DEFAULT_MODEL)
        const proposals = await generator.generate({
          count: MAX_PROPOSAL_COUNT,
          research_dir: this.projectDir,
        })

        if (proposals.length === 0) {
          emit(`Attempt ${attempt}: No proposals generated`)
          continue
        }

        selectedProposal = selectBestProposal(proposals)
        emit(`Selected proposal: "${selectedProposal.title}"`)
        break
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        emit(`Attempt ${attempt} failed: ${msg}`)
      }
    }

    if (!selectedProposal) {
      emit(
        `Failed after ${MAX_REDESIGN_ATTEMPTS} redesign attempts. Returning failure report with salvageable artifacts.`,
      )
      return { status: 'proposal_generation_failed', artifacts }
    }

    // Phase 3: Probe system capabilities
    let systemCaps = null
    try {
      systemCaps = await probeSystem()
    } catch {
      emit('System probe failed, proceeding with defaults')
    }

    // Phase 4: Initialize ResearchState + Launch Orchestrator
    emit('=== Phase 3: Launching Orchestrator ===')

    const callbacks: OrchestratorCallbacks = {
      executeAgent: async (agentName, task, context) => {
        emit(`[${agentName}] ${task.slice(0, 80)}`)
        const currentState = loadResearchState(this.projectDir)
        if (!currentState) {
          return {
            success: false,
            agent: agentName,
            summary: 'No state',
            artifacts_produced: [],
            new_claims: [],
            new_evidence: [],
            cost_usd: 0,
          }
        }
        return dispatchAgent(agentName, task, context, currentState)
      },
      presentDecision: async () => 'approve',
      onProgress: emit,
      onStateChange: state => {
        emit(
          `  Cycle ${state.orchestrator_cycle_count} | Budget: $${state.budget.spent_usd.toFixed(2)}/$${state.budget.total_usd}`,
        )
      },
      onComplete: state => {
        emit(
          `Orchestrator complete after ${state.orchestrator_cycle_count} cycles`,
        )
      },
      onError: error => {
        emit(`ERROR: ${error.message}`)
      },
    }

    const orchestrator = Orchestrator.fromProposal(
      this.projectDir,
      selectedProposal,
      callbacks,
      {
        mode: 'auto',
        budget_usd: options?.budget_usd,
        max_cycles: options?.max_cycles ?? 50,
        compute: systemCaps,
        research_stance: options?.research_stance,
      },
    )

    try {
      const finalState = await orchestrator.run()
      emit('=== Adaptive Auto Mode Complete ===')
      emit(buildStateContext(finalState))
      return { status: 'completed', artifacts, state: finalState }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      emit(`Orchestrator failed: ${msg}`)
      return { status: 'orchestrator_failed', artifacts }
    }
  }
}
