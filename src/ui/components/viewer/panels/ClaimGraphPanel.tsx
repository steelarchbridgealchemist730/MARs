import React, { useState, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ClaimGraph } from '../../../../paper/claim-graph/index'
import type { Claim, ClaimPhase } from '../../../../paper/claim-graph/types'
import type { EvidencePoolManager } from '../../../../paper/evidence-pool'
import type { StabilityMetrics } from '../../../../paper/research-state'
import {
  canAdmit,
  type AdmissionDecision,
} from '../../../../paper/admission-gate'
import {
  suggestContraction,
  type ContractionSuggestion,
} from '../../../../paper/claim-contraction'
import { useFullscreenDimensions } from '../../FullscreenLayout'
import { getTheme } from '@utils/theme'

// ── Types ─────────────────────────────────────────────

export type ViewMode =
  | 'claims'
  | 'detail'
  | 'bridges'
  | 'admission'
  | 'contraction'

export interface ClaimGraphPanelProps {
  graph: ClaimGraph
  pool: EvidencePoolManager
  stability: StabilityMetrics
  initialMode?: ViewMode
  onDone: (result?: string) => void
}

// ── Phase display order and icons ────────────────────

const PHASE_ORDER: ClaimPhase[] = [
  'admitted',
  'under_investigation',
  'proposed',
  'demoted',
  'rejected',
  'retracted',
]

const PHASE_ICON: Record<ClaimPhase, string> = {
  admitted: '+',
  proposed: '?',
  under_investigation: '~',
  demoted: 'v',
  rejected: 'x',
  retracted: '-',
  reformulated: '>',
}

function phaseColor(phase: ClaimPhase): string {
  const theme = getTheme()
  switch (phase) {
    case 'admitted':
      return theme.success
    case 'proposed':
      return '#818cf8'
    case 'under_investigation':
      return theme.warning
    case 'demoted':
      return theme.secondaryText
    case 'rejected':
    case 'retracted':
      return theme.error
    default:
      return theme.text
  }
}

// ── Exported helper functions ─────────────────────────

export function groupClaimsByPhase(claims: Claim[]): Map<ClaimPhase, Claim[]> {
  const map = new Map<ClaimPhase, Claim[]>()
  for (const phase of PHASE_ORDER) {
    const group = claims
      .filter(c => c.phase === phase)
      .sort((a, b) => b.strength.confidence - a.strength.confidence)
    if (group.length > 0) {
      map.set(phase, group)
    }
  }
  return map
}

export function buildClaimLine(claim: Claim, width: number): string {
  const icon = PHASE_ICON[claim.phase] ?? '?'
  const conf = claim.strength.confidence.toFixed(2)
  const suffix = `  ${conf}`
  const prefix = `${icon} [${claim.type}] `
  const maxStatement = Math.max(10, width - prefix.length - suffix.length)
  const stmt =
    claim.statement.length > maxStatement
      ? claim.statement.slice(0, maxStatement - 3) + '...'
      : claim.statement
  const pad = Math.max(0, width - prefix.length - stmt.length - suffix.length)
  return `${prefix}${stmt}${' '.repeat(pad)}${suffix}`
}

export function getAdmissionStatuses(
  graph: ClaimGraph,
  pool: EvidencePoolManager,
): Array<{ claim: Claim; decision: AdmissionDecision }> {
  return graph.allClaims
    .filter(c => c.phase !== 'admitted')
    .map(c => ({ claim: c, decision: canAdmit(c.id, graph, pool) }))
}

export function getContractionCandidates(
  graph: ClaimGraph,
): Array<{ claim: Claim; suggestion: ContractionSuggestion }> {
  return graph.allClaims
    .filter(
      c =>
        c.phase !== 'admitted' &&
        c.phase !== 'rejected' &&
        c.phase !== 'retracted' &&
        c.epistemicLayer !== 'observation',
    )
    .map(c => ({ claim: c, suggestion: suggestContraction(c.id, graph) }))
}

// ── Flat list for cursor navigation ───────────────────

function buildFlatClaimList(grouped: Map<ClaimPhase, Claim[]>): Claim[] {
  const flat: Claim[] = []
  for (const phase of PHASE_ORDER) {
    const group = grouped.get(phase)
    if (group) flat.push(...group)
  }
  return flat
}

// ── Component ────────────────────────────────────────

export function ClaimGraphPanel({
  graph,
  pool,
  stability,
  initialMode,
  onDone,
}: ClaimGraphPanelProps): React.ReactNode {
  const { contentHeight, contentWidth } = useFullscreenDimensions()
  const [mode, setMode] = useState<ViewMode>(initialMode ?? 'claims')
  const [cursor, setCursor] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null)

  const theme = getTheme()

  const grouped = useMemo(() => groupClaimsByPhase(graph.allClaims), [graph])
  const flatClaims = useMemo(() => buildFlatClaimList(grouped), [grouped])
  const bridges = useMemo(() => graph.findWeakestBridges(), [graph])
  const contradictions = useMemo(() => graph.findContradictions(), [graph])
  const admissionStatuses = useMemo(
    () => getAdmissionStatuses(graph, pool),
    [graph, pool],
  )
  const contractionCandidates = useMemo(
    () => getContractionCandidates(graph),
    [graph],
  )

  const maxCursor = (() => {
    switch (mode) {
      case 'claims':
        return Math.max(0, flatClaims.length - 1)
      case 'bridges':
        return Math.max(0, bridges.length - 1)
      case 'admission':
        return Math.max(0, admissionStatuses.length - 1)
      case 'contraction':
        return Math.max(0, contractionCandidates.length - 1)
      case 'detail':
        return 0
    }
  })()

  useInput((input, key) => {
    if (key.upArrow) {
      if (mode === 'detail') {
        setScrollOffset(o => Math.max(0, o - 1))
      } else {
        setCursor(c => Math.max(0, c - 1))
      }
      return
    }
    if (key.downArrow) {
      if (mode === 'detail') {
        setScrollOffset(o => o + 1)
      } else {
        setCursor(c => Math.min(maxCursor, c + 1))
      }
      return
    }
    if (key.return) {
      if (mode === 'claims' && flatClaims[cursor]) {
        setSelectedClaimId(flatClaims[cursor].id)
        setScrollOffset(0)
        setMode('detail')
      } else if (mode === 'bridges' && bridges[cursor]) {
        setSelectedClaimId(bridges[cursor].claim.id)
        setScrollOffset(0)
        setMode('detail')
      } else if (mode === 'admission' && admissionStatuses[cursor]) {
        setSelectedClaimId(admissionStatuses[cursor].claim.id)
        setScrollOffset(0)
        setMode('detail')
      } else if (mode === 'contraction' && contractionCandidates[cursor]) {
        setSelectedClaimId(contractionCandidates[cursor].claim.id)
        setScrollOffset(0)
        setMode('detail')
      }
      return
    }
    if (key.escape) {
      if (
        mode === 'detail' ||
        mode === 'bridges' ||
        mode === 'admission' ||
        mode === 'contraction'
      ) {
        setMode('claims')
        setCursor(0)
        setScrollOffset(0)
      } else {
        onDone()
      }
      return
    }
    if (input === 'b' && mode !== 'bridges') {
      setMode('bridges')
      setCursor(0)
    } else if (input === 'a' && mode !== 'admission') {
      setMode('admission')
      setCursor(0)
    } else if (input === 'c' && mode !== 'contraction') {
      setMode('contraction')
      setCursor(0)
    }
  })

  if (flatClaims.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        <Text>No claims yet. Run /run to start the orchestrator.</Text>
      </Box>
    )
  }

  if (mode === 'claims') return renderClaims()
  if (mode === 'detail') return renderDetail()
  if (mode === 'bridges') return renderBridges()
  if (mode === 'admission') return renderAdmission()
  if (mode === 'contraction') return renderContraction()
  return null

  // ── Claims list ──────────────────────────────────

  function renderClaims(): React.ReactNode {
    const lines: Array<{
      text: string
      color: string
      isCursor: boolean
      dim?: boolean
    }> = []
    let globalIdx = 0

    for (const phase of PHASE_ORDER) {
      const group = grouped.get(phase)
      if (!group) continue

      const label = phase.replace(/_/g, ' ')
      lines.push({
        text: `-- ${label.charAt(0).toUpperCase() + label.slice(1)} (${group.length}) `,
        color: phaseColor(phase),
        isCursor: false,
        dim: true,
      })

      for (const claim of group) {
        const isCur = globalIdx === cursor
        lines.push({
          text: `${isCur ? '> ' : '  '}${buildClaimLine(claim, contentWidth - 4)}`,
          color: phaseColor(phase),
          isCursor: isCur,
          dim: phase === 'demoted' || phase === 'retracted',
        })
        globalIdx++
      }
    }

    const visibleLines = lines.slice(0, contentHeight)

    return (
      <Box flexDirection="column">
        {visibleLines.map((line, i) => (
          <Box key={i}>
            <Text
              color={line.color}
              bold={line.isCursor}
              dimColor={line.dim && !line.isCursor}
            >
              {line.text}
            </Text>
          </Box>
        ))}
      </Box>
    )
  }

  // ── Detail view ──────────────────────────────────

  function renderDetail(): React.ReactNode {
    const claim = selectedClaimId ? graph.getClaim(selectedClaimId) : null
    if (!claim) {
      return (
        <Box>
          <Text color={theme.error}>Claim not found</Text>
        </Box>
      )
    }

    const evidence = pool.evidenceFor(claim.id)
    const againstEvidence = pool.evidenceAgainst(claim.id)
    const edges = graph.getEdgesOf(claim.id)

    const detailLines: string[] = []
    detailLines.push(
      `[${claim.id.slice(0, 8)}] ${claim.type} (${claim.epistemicLayer})`,
    )
    detailLines.push(
      `Phase: ${claim.phase} | Conf: ${claim.strength.confidence.toFixed(2)} | Evidence: ${claim.strength.evidenceType} | Vuln: ${claim.strength.vulnerabilityScore.toFixed(2)}`,
    )
    detailLines.push(`Statement: ${claim.statement}`)
    detailLines.push('')

    const totalFor = evidence.grounded.length + evidence.derived.length
    const totalAgainst =
      againstEvidence.grounded.length + againstEvidence.derived.length
    detailLines.push(
      `Evidence: ${totalFor} supporting, ${totalAgainst} against`,
    )
    for (const g of evidence.grounded) {
      const verified = g.verified ? 'verified' : 'unverified'
      detailLines.push(
        `  [G] ${g.source_type}: "${g.source_ref}" (${verified})`,
      )
    }
    for (const d of evidence.derived) {
      const repro = d.reproducible ? 'reproducible' : 'not reproducible'
      detailLines.push(`  [D] ${d.method}: ${d.artifact_id} (${repro})`)
    }
    if (totalAgainst > 0) {
      detailLines.push('  Against:')
      for (const g of againstEvidence.grounded) {
        detailLines.push(`  [G-] ${g.source_type}: "${g.source_ref}"`)
      }
      for (const d of againstEvidence.derived) {
        detailLines.push(`  [D-] ${d.method}: ${d.artifact_id}`)
      }
    }
    detailLines.push('')

    detailLines.push(`Edges (${edges.length}):`)
    for (const edge of edges) {
      const isSource = edge.source === claim.id
      const otherId = isSource ? edge.target : edge.source
      const otherClaim = graph.getClaim(otherId)
      const otherStmt = otherClaim
        ? otherClaim.statement.slice(0, 50)
        : otherId.slice(0, 8)
      const arrow = isSource ? '-->' : '<--'
      detailLines.push(
        `  ${edge.relation} ${arrow} "${otherStmt}"  [${edge.strength}]`,
      )
    }
    detailLines.push('')

    if (claim.assessment_history.length > 0) {
      detailLines.push('Assessment History:')
      for (const a of claim.assessment_history) {
        detailLines.push(
          `  [${a.assessor}] ${a.previous_strength.confidence.toFixed(2)} -> ${a.new_strength.confidence.toFixed(2)}: "${a.reason}"`,
        )
      }
    }

    const visible = detailLines.slice(
      scrollOffset,
      scrollOffset + contentHeight,
    )

    return (
      <Box flexDirection="column">
        {visible.map((line, i) => (
          <Box key={i}>
            <Text color={phaseColor(claim.phase)}>{line}</Text>
          </Box>
        ))}
      </Box>
    )
  }

  // ── Bridges view ─────────────────────────────────

  function renderBridges(): React.ReactNode {
    const topBridges = bridges.slice(0, contentHeight - 5)

    return (
      <Box flexDirection="column">
        <Text bold color="#818cf8">
          {'=== Weakest Bridges ==='}
        </Text>
        <Text dimColor>{' #  Vuln   Cascade  Conf   Claim'}</Text>
        {topBridges.map((b, i) => {
          const isCur = i === cursor
          const stmt =
            b.claim.statement.length > contentWidth - 35
              ? b.claim.statement.slice(0, contentWidth - 38) + '...'
              : b.claim.statement
          return (
            <Box key={i}>
              <Text bold={isCur} color={isCur ? '#818cf8' : undefined}>
                {`${isCur ? '>' : ' '}${String(i + 1).padStart(2)}  ${b.vulnerability.toFixed(2)}  ${String(b.cascadeSize).padStart(7)}  ${b.claim.strength.confidence.toFixed(2)}   "${stmt}"`}
              </Text>
            </Box>
          )
        })}
        {contradictions.length > 0 && (
          <>
            <Text />
            <Text color={theme.warning}>
              {`Contradictions: ${contradictions.length} found`}
            </Text>
            {contradictions.slice(0, 5).map((c, i) => (
              <Box key={`contra-${i}`}>
                <Text color={theme.error}>
                  {`  "${c.claim.statement.slice(0, 60)}"`}
                </Text>
              </Box>
            ))}
          </>
        )}
      </Box>
    )
  }

  // ── Admission view ───────────────────────────────

  function renderAdmission(): React.ReactNode {
    const stats = graph.getStatistics()
    const visible = admissionStatuses.slice(0, contentHeight - 4)

    return (
      <Box flexDirection="column">
        <Text bold color="#818cf8">
          {'=== Admission Gate ==='}
        </Text>
        <Text dimColor>
          {`Admitted: ${stats.admitted} | Pending: ${stats.proposed + stats.investigating} | Rejected: ${stats.rejected}`}
        </Text>
        <Text />
        {visible.map(({ claim, decision }, i) => {
          const isCur = i === cursor
          const icon = decision.admit ? 'PASS' : 'FAIL'
          const color = decision.admit ? theme.success : theme.error
          return (
            <React.Fragment key={i}>
              <Box>
                <Text bold={isCur} color={isCur ? '#818cf8' : color}>
                  {`${isCur ? '>' : ' '} [${icon}] "${claim.statement.length > contentWidth - 20 ? claim.statement.slice(0, contentWidth - 23) + '...' : claim.statement}"`}
                </Text>
              </Box>
              {decision.reason && (
                <Box>
                  <Text dimColor>{`         ${decision.reason}`}</Text>
                </Box>
              )}
            </React.Fragment>
          )
        })}
      </Box>
    )
  }

  // ── Contraction view ─────────────────────────────

  function renderContraction(): React.ReactNode {
    const visible = contractionCandidates.slice(0, contentHeight - 3)

    if (contractionCandidates.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold color="#818cf8">
            {'=== Contraction Suggestions ==='}
          </Text>
          <Text />
          <Text dimColor>
            No contraction candidates. All claims are either admitted, rejected,
            or observations.
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold color="#818cf8">
          {'=== Contraction Suggestions ==='}
        </Text>
        <Text />
        {visible.map(({ claim, suggestion }, i) => {
          const isCur = i === cursor
          const stmt =
            claim.statement.length > contentWidth - 6
              ? claim.statement.slice(0, contentWidth - 9) + '...'
              : claim.statement
          const layerArrow = suggestion.contracted_layer
            ? `${suggestion.current_layer} -> ${suggestion.contracted_layer}`
            : `${suggestion.current_layer} (cannot contract)`
          return (
            <React.Fragment key={i}>
              <Box>
                <Text bold={isCur} color={isCur ? '#818cf8' : theme.warning}>
                  {`${isCur ? '>' : ' '} "${stmt}"`}
                </Text>
              </Box>
              <Box>
                <Text dimColor>{`    ${layerArrow}`}</Text>
              </Box>
              <Box>
                <Text dimColor>{`    Strategy: ${suggestion.strategy}`}</Text>
              </Box>
            </React.Fragment>
          )
        })}
      </Box>
    )
  }
}
