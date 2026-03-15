import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { Command } from '@commands'
import {
  Orchestrator,
  type OrchestratorCallbacks,
  type OrchestratorDecision,
  type ExecutionResult,
} from '../paper/orchestrator'
import {
  loadResearchState,
  buildStateContext,
  getUnresolvedClaims,
  getAdmittedClaims,
  type ResearchState,
} from '../paper/research-state'
import { executeAgent } from '../paper/agent-dispatch'
import { getSessionDir } from '../paper/session'
import {
  FullscreenLayout,
  useFullscreenDimensions,
} from '@components/FullscreenLayout'

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// ── State Panel ─────────────────────────────────────────

function StatePanel({
  state,
}: {
  state: ResearchState | null
}): React.ReactNode {
  if (!state) return null

  const admittedClaims = getAdmittedClaims(state).length
  const unresolvedClaims = getUnresolvedClaims(state).length
  const totalClaims = state.claimGraph.claims.length
  const spent = state.budget.spent_usd
  const remaining = state.budget.remaining_usd
  const artifactCount = state.artifacts.entries.length
  const stability = state.stability

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginLeft={2}
      marginTop={1}
    >
      <Text bold dimColor>
        Cognitive State
      </Text>
      <Text>
        <Text color="yellow">Claims:</Text> {totalClaims}
        <Text dimColor>
          {' '}
          ({admittedClaims} admitted, {unresolvedClaims} unresolved)
        </Text>
      </Text>
      <Text>
        <Text color="yellow">Convergence:</Text>{' '}
        {(stability.convergenceScore * 100).toFixed(0)}%
        <Text dimColor> | Readiness: {stability.paperReadiness}</Text>
      </Text>
      <Text>
        <Text color="yellow">Evidence:</Text>{' '}
        {state.evidencePool.grounded.length} grounded,{' '}
        {state.evidencePool.derived.length} derived
      </Text>
      <Text>
        <Text color="yellow">Budget:</Text> ${spent.toFixed(2)} / $
        {(spent + remaining).toFixed(0)} spent
      </Text>
      <Text>
        <Text color="yellow">Artifacts:</Text> {artifactCount}
      </Text>
    </Box>
  )
}

// ── Decision Panel ──────────────────────────────────────

function DecisionPanel({
  decision,
  onResolve,
}: {
  decision: OrchestratorDecision
  onResolve: (choice: 'approve' | 'edit' | 'skip') => void
}): React.ReactNode {
  useInput(input => {
    if (input === 'a') onResolve('approve')
    else if (input === 'e') onResolve('edit')
    else if (input === 's') onResolve('skip')
  })

  const priorityColor =
    decision.action.priority === 'urgent'
      ? 'red'
      : decision.action.priority === 'high'
        ? 'yellow'
        : decision.action.priority === 'normal'
          ? 'green'
          : 'gray'

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginLeft={2}
      marginTop={1}
    >
      <Text bold color="cyan">
        Decision Pending
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Action: </Text>
          {decision.action.type}
        </Text>
        <Text>
          <Text bold>Agent: </Text>
          {decision.action.delegate_to}
        </Text>
        <Text>
          <Text bold>Priority: </Text>
          <Text color={priorityColor}>{decision.action.priority}</Text>
        </Text>
        <Text>
          <Text bold>Est. cost: </Text>$
          {decision.action.estimated_cost_usd.toFixed(2)}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Reasoning:</Text>
        <Text wrap="truncate-end">
          {decision.reasoning.length > 200
            ? decision.reasoning.slice(0, 200) + '...'
            : decision.reasoning}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color="green" bold>
            [a]
          </Text>{' '}
          approve{'  '}
          <Text color="yellow" bold>
            [s]
          </Text>{' '}
          skip{'  '}
          <Text color="magenta" bold>
            [e]
          </Text>{' '}
          re-decide
        </Text>
      </Box>
    </Box>
  )
}

// ── Main Run UI ─────────────────────────────────────────

function RunUI({
  projectDir,
  mode,
  researchStance,
  onDone,
}: {
  projectDir: string
  mode: 'auto' | 'interactive'
  researchStance?: 'exploratory' | 'standard'
  onDone: (result: string) => void
}): React.ReactNode {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [startTime] = useState(Date.now())
  const [status, setStatus] = useState('Initializing...')
  const [phase, setPhase] = useState<
    'init' | 'reflecting' | 'deciding' | 'executing' | 'digesting' | 'done'
  >('init')
  const [cycle, setCycle] = useState(0)
  const [errorCount, setErrorCount] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [researchState, setResearchState] = useState<ResearchState | null>(null)
  const [pendingDecision, setPendingDecision] =
    useState<OrchestratorDecision | null>(null)

  // Ref to hold the resolve function for the pending decision Promise
  const decisionResolverRef = useRef<
    ((choice: 'approve' | 'edit' | 'skip') => void) | null
  >(null)

  // Ref to hold the orchestrator for abort on Esc
  const orchestratorRef = useRef<Orchestrator | null>(null)

  const handleDecisionResolve = useCallback(
    (choice: 'approve' | 'edit' | 'skip') => {
      if (decisionResolverRef.current) {
        decisionResolverRef.current(choice)
        decisionResolverRef.current = null
        setPendingDecision(null)
      }
    },
    [],
  )

  useEffect(() => {
    const t = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER.length)
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 80)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const state = loadResearchState(projectDir)
    if (!state) {
      onDone(
        'No research state found. Run /propose first to select a proposal.',
      )
      return
    }

    setResearchState(state)

    const callbacks: OrchestratorCallbacks = {
      executeAgent: async (
        agentName: string,
        task: string,
        context: string,
      ): Promise<ExecutionResult> => {
        setPhase('executing')
        setStatus(`Agent: ${agentName} — ${task.slice(0, 60)}...`)
        setLogs(prev => [...prev, `[${agentName}] ${task.slice(0, 80)}`])
        const currentState = loadResearchState(projectDir)
        if (!currentState) {
          return {
            success: false,
            agent: agentName,
            summary: 'No research state available',
            artifacts_produced: [],
            new_claims: [],
            new_evidence: [],
            cost_usd: 0,
          }
        }
        // Pass progress callback so agent tool actions appear in real-time
        const agentProgress = (msg: string) => {
          setStatus(msg)
          setLogs(prev => [...prev, msg])
        }
        return executeAgent(
          agentName,
          task,
          context,
          currentState,
          agentProgress,
          projectDir,
        )
      },
      presentDecision: async (
        decision: OrchestratorDecision,
        _state: ResearchState,
      ): Promise<'approve' | 'edit' | 'skip'> => {
        setPhase('deciding')
        setStatus(
          `Decision: ${decision.action.type} via ${decision.action.delegate_to}`,
        )

        // In auto mode, approve immediately
        if (mode === 'auto') {
          return 'approve'
        }

        // In interactive mode, show DecisionPanel and wait for user input
        return new Promise<'approve' | 'edit' | 'skip'>(resolve => {
          decisionResolverRef.current = resolve
          setPendingDecision(decision)
        })
      },
      onProgress: (message: string) => {
        // Detect phase from progress messages
        if (/Builder phase/i.test(message)) setPhase('reflecting')
        else if (/Skeptic phase/i.test(message)) setPhase('reflecting')
        else if (/Arbiter phase/i.test(message)) setPhase('deciding')
        else if (/Applying claim/i.test(message)) setPhase('deciding')
        else if (message.includes('Executing') || message.includes('Agent:'))
          setPhase('executing')
        else if (message.includes('Digest') || message.includes('digest'))
          setPhase('digesting')
        setStatus(message)
        setLogs(prev => [...prev, message])
      },
      onStateChange: (newState: ResearchState) => {
        setCycle(newState.orchestrator_cycle_count)
        setResearchState(newState)
      },
      onComplete: (finalState: ResearchState) => {
        setPhase('done')
        // Keep completion summary concise to avoid overflowing terminal
        const admitted = getAdmittedClaims(finalState)
        const lines = [
          '=== Orchestrator Complete ===',
          `Cycles: ${finalState.orchestrator_cycle_count}`,
          `Budget: $${finalState.budget.spent_usd.toFixed(2)} / $${finalState.budget.total_usd}`,
          `Claims: ${finalState.claimGraph.claims.length} (${admitted.length} admitted)`,
          `Readiness: ${finalState.stability.paperReadiness}`,
          `Artifacts: ${finalState.artifacts.entries.length}`,
        ]
        if (finalState.artifacts.entries.length > 0) {
          lines.push('')
          lines.push('Artifacts:')
          for (const a of finalState.artifacts.entries.slice(-10)) {
            lines.push(`  ${a.path}`)
          }
        }
        onDone(lines.join('\n'))
      },
      onError: (error: Error) => {
        setErrorCount(c => c + 1)
        setLogs(prev => [...prev, `ERROR: ${error.message}`])
      },
    }

    const orchestrator = new Orchestrator(projectDir, state, callbacks, {
      mode,
      research_stance: researchStance,
    })
    orchestratorRef.current = orchestrator

    orchestrator.run().catch(err => {
      onDone(`Orchestrator failed: ${err.message}`)
    })
  }, [])

  // Handle Esc key: abort orchestrator gracefully and save state
  useInput((_input, key) => {
    if (key.escape && !pendingDecision) {
      const orch = orchestratorRef.current
      if (orch) {
        orch.abort()
        const finalState = orch.getState()
        const lines = [
          '=== Orchestrator Interrupted (Esc) ===',
          `Cycles completed: ${finalState.orchestrator_cycle_count}`,
          `Budget: $${finalState.budget.spent_usd.toFixed(2)} / $${finalState.budget.total_usd}`,
          `Claims: ${finalState.claimGraph.claims.length} (${getAdmittedClaims(finalState).length} admitted)`,
          `Artifacts: ${finalState.artifacts.entries.length}`,
          '',
          'State saved. Resume with /run.',
        ]
        onDone(lines.join('\n'))
      } else {
        onDone('Orchestrator interrupted.')
      }
    }
  })

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

  const phaseLabel =
    phase === 'init'
      ? 'initializing'
      : phase === 'reflecting'
        ? 'builder/skeptic'
        : phase === 'deciding'
          ? 'arbiter'
          : phase === 'executing'
            ? 'executing agent'
            : phase === 'digesting'
              ? 'digesting results'
              : 'done'

  const showDecision = pendingDecision && mode === 'interactive'

  const subtitleParts = [`cycle ${cycle}`, phaseLabel, timeStr]
  if (researchStance === 'exploratory') subtitleParts.push('exploratory')
  if (errorCount > 0) subtitleParts.push(`${errorCount} errors`)
  const subtitle = `${SPINNER[frame]} ${subtitleParts.join(' · ')}`

  const footerContent = showDecision ? (
    <Text>
      <Text color="green" bold>
        [a]
      </Text>{' '}
      approve{'  '}
      <Text color="yellow" bold>
        [s]
      </Text>{' '}
      skip{'  '}
      <Text color="magenta" bold>
        [e]
      </Text>{' '}
      re-decide
    </Text>
  ) : (
    <Text dimColor>Esc: exit</Text>
  )

  return (
    <FullscreenLayout
      title="Orchestrator"
      subtitle={subtitle}
      borderColor="#818cf8"
      accentColor="#22d3ee"
      icon="◆"
      footer={footerContent}
    >
      <RunContent
        status={status}
        researchState={researchState}
        showDecision={showDecision}
        pendingDecision={pendingDecision}
        handleDecisionResolve={handleDecisionResolve}
        logs={logs}
      />
    </FullscreenLayout>
  )
}

// ── Run Content (uses fullscreen dimensions) ────────────

function RunContent({
  status,
  researchState,
  showDecision,
  pendingDecision,
  handleDecisionResolve,
  logs,
}: {
  status: string
  researchState: ResearchState | null
  showDecision: boolean
  pendingDecision: OrchestratorDecision | null
  handleDecisionResolve: (choice: 'approve' | 'edit' | 'skip') => void
  logs: string[]
}): React.ReactNode {
  const { contentHeight } = useFullscreenDimensions()

  // Reserve lines for status (1), StatePanel (~8), DecisionPanel (~10 if shown)
  const reservedLines = 1 + 8 + (showDecision ? 10 : 0)
  const maxLogLines = Math.max(2, contentHeight - reservedLines)

  return (
    <Box flexDirection="column">
      <Box marginLeft={1}>
        <Text wrap="truncate-end">{status}</Text>
      </Box>

      <StatePanel state={researchState} />

      {showDecision && pendingDecision && (
        <DecisionPanel
          decision={pendingDecision}
          onResolve={handleDecisionResolve}
        />
      )}

      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        {logs.slice(-maxLogLines).map((l, i) => {
          let color: string | undefined
          let dimColor = true
          if (l.startsWith('ERROR')) {
            color = 'red'
            dimColor = false
          } else if (l.startsWith('Warning:')) {
            color = 'yellow'
            dimColor = false
          } else if (/^\[/.test(l)) {
            color = 'cyan'
            dimColor = false
          } else if (/→/.test(l)) {
            color = 'blue'
          } else if (/Reflecting/i.test(l)) {
            color = 'magenta'
            dimColor = false
          } else if (/Deciding/i.test(l)) {
            color = 'cyan'
            dimColor = false
          } else if (/Digest/i.test(l)) {
            color = 'green'
            dimColor = false
          } else if (/budget|\$/i.test(l)) {
            color = 'yellow'
          }
          return (
            <Box key={i}>
              <Text dimColor={dimColor} color={color} wrap="truncate-end">
                {l.slice(0, 120)}
              </Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

const run: Command = {
  type: 'local-jsx',
  name: 'run',
  userFacingName() {
    return 'run'
  },
  description:
    'Launch the adaptive Orchestrator (builder→skeptic→arbiter→execute→digest loop)',
  isEnabled: true,
  isHidden: false,
  argumentHint: '[--auto] [--exploratory] [--budget $50] [--max-cycles 100]',
  aliases: [],

  async call(
    onDone: (result?: string) => void,
    _context: any,
    args?: string,
  ): Promise<React.ReactNode> {
    const argsStr = args ?? ''
    const isAuto = /--auto/.test(argsStr)
    const isExploratory = /--exploratory/.test(argsStr)
    const mode = isAuto ? 'auto' : 'interactive'
    const researchStance = isExploratory
      ? ('exploratory' as const)
      : ('standard' as const)

    const projectDir = getSessionDir()

    return (
      <RunUI
        projectDir={projectDir}
        mode={mode as 'auto' | 'interactive'}
        researchStance={researchStance}
        onDone={r => onDone(r)}
      />
    )
  },
}

export default run
