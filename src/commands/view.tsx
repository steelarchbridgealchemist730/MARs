import React, { useState } from 'react'
import { Text, useInput } from 'ink'
import type { Command } from '@commands'
import { getSessionDir } from '../paper/session'
import { loadResearchState } from '../paper/research-state'
import { ClaimGraph } from '../paper/claim-graph/index'
import { EvidencePoolManager } from '../paper/evidence-pool'
import { ConvergenceDetector } from '../paper/convergence'
import { DKPLoader } from '../paper/domain-knowledge/loader'
import { FullscreenLayout } from '@components/FullscreenLayout'
import {
  ClaimGraphPanel,
  type ViewMode,
} from '@components/viewer/panels/ClaimGraphPanel'
import { DomainKnowledgePanel } from '@components/viewer/panels/DomainKnowledgePanel'

type TopMode = 'claims' | 'knowledge'

function parseInitialMode(args: string): { top?: TopMode; view?: ViewMode } {
  const token = args.trim().toLowerCase()
  if (token === 'knowledge' || token === 'k') return { top: 'knowledge' }
  if (token === 'bridges' || token === 'b') return { view: 'bridges' }
  if (token === 'admission' || token === 'a') return { view: 'admission' }
  if (token === 'contraction' || token === 'c') return { view: 'contraction' }
  return {}
}

// ── ViewRouter ─────────────────────────────────────────

interface ViewRouterProps {
  graph: ClaimGraph
  pool: EvidencePoolManager
  stability: any
  loader: DKPLoader | null
  initialTop: TopMode
  initialViewMode?: ViewMode
  onDone: (result?: string) => void
  onFooterChange: (footer: React.ReactNode) => void
}

function ViewRouter({
  graph,
  pool,
  stability,
  loader,
  initialTop,
  initialViewMode,
  onDone,
  onFooterChange,
}: ViewRouterProps): React.ReactNode {
  const [topMode, setTopMode] = useState<TopMode>(initialTop)

  useInput(
    input => {
      if (input === 'k' && topMode === 'claims') {
        setTopMode('knowledge')
      }
    },
    { isActive: topMode === 'claims' },
  )

  if (topMode === 'knowledge') {
    if (!loader || loader.getLoadedPacks().length === 0) {
      return (
        <DKPEmptyFallback
          onBack={() => setTopMode('claims')}
          onFooterChange={onFooterChange}
        />
      )
    }
    return (
      <DomainKnowledgePanel
        loader={loader}
        onDone={() => setTopMode('claims')}
        onFooterChange={onFooterChange}
      />
    )
  }

  return (
    <ClaimGraphPanel
      graph={graph}
      pool={pool}
      stability={stability}
      initialMode={initialViewMode}
      onDone={onDone}
    />
  )
}

function DKPEmptyFallback({
  onBack,
  onFooterChange,
}: {
  onBack: () => void
  onFooterChange: (footer: React.ReactNode) => void
}): React.ReactNode {
  React.useEffect(() => {
    onFooterChange(<Text dimColor>Esc: back to claims</Text>)
  }, [onFooterChange])

  useInput((_input, key) => {
    if (key.escape) onBack()
  })

  return (
    <Text dimColor>
      No knowledge packs loaded. Use /knowledge load first. Press Esc to go
      back.
    </Text>
  )
}

// ── ViewPanel (manages footer state) ─────────────────────

interface ViewPanelProps {
  graph: ClaimGraph
  pool: EvidencePoolManager
  stability: any
  loader: DKPLoader | null
  initialTop: TopMode
  initialViewMode?: ViewMode
  subtitle: string
  onDone: (result?: string) => void
}

function ViewPanel({
  graph,
  pool,
  stability,
  loader,
  initialTop,
  initialViewMode,
  subtitle,
  onDone,
}: ViewPanelProps): React.ReactNode {
  const [footer, setFooter] = useState<React.ReactNode>(
    <Text dimColor>
      Up/Down: navigate{'  '}Enter: details{'  '}b: bridges{'  '}a: admission
      {'  '}c: contraction{'  '}k: knowledge{'  '}Esc: exit
    </Text>,
  )

  return (
    <FullscreenLayout
      title="Claim Graph"
      subtitle={subtitle}
      borderColor="#6366f1"
      accentColor="#818cf8"
      footer={footer}
    >
      <ViewRouter
        graph={graph}
        pool={pool}
        stability={stability}
        loader={loader}
        initialTop={initialTop}
        initialViewMode={initialViewMode}
        onDone={onDone}
        onFooterChange={setFooter}
      />
    </FullscreenLayout>
  )
}

// ── Command ─────────────────────────────────────────────

const view: Command = {
  type: 'local-jsx',
  name: 'view',
  userFacingName() {
    return 'view'
  },
  description: 'View claim graph, bridges, admission status, knowledge packs',
  isEnabled: true,
  isHidden: false,
  argumentHint: '[bridges|admission|contraction|knowledge]',
  aliases: ['claims'],

  async call(
    onDone: (result?: string) => void,
    _context: any,
    args?: string,
  ): Promise<React.ReactNode> {
    const researchDir = getSessionDir()
    const state = loadResearchState(researchDir)

    if (!state) {
      onDone(
        'No research state found. Run /propose to select a proposal, then /run to start.',
      )
      return null
    }

    const graph = ClaimGraph.fromJSON(state.claimGraph)
    const pool = new EvidencePoolManager(state.evidencePool)

    // Compute stability metrics
    let stability = state.stability
    try {
      const detector = new ConvergenceDetector()
      stability = detector.compute(state, pool)
    } catch {
      // Use stored stability if convergence detection fails
    }

    // Load DKP packs
    let loader: DKPLoader | null = null
    const packIds = state.loaded_knowledge_packs ?? []
    if (packIds.length > 0) {
      loader = new DKPLoader()
      for (const packId of packIds) {
        try {
          loader.load(packId)
        } catch {
          // Skip packs that fail to load
        }
      }
    }

    const { top, view: viewMode } = parseInitialMode(args ?? '')
    const initialTop: TopMode = top ?? 'claims'

    const stats = graph.getStatistics()
    const subtitle = `${stats.total} claims | ${stats.admitted} admitted | convergence ${(stability.convergenceScore * 100).toFixed(0)}%`

    return (
      <ViewPanel
        graph={graph}
        pool={pool}
        stability={stability}
        loader={loader}
        initialTop={initialTop}
        initialViewMode={viewMode}
        subtitle={subtitle}
        onDone={onDone}
      />
    )
  },
}

export default view
