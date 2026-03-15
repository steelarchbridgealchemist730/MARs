import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { chatCompletion } from '../llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../types'
import { ClaimGraph } from '../claim-graph/index'
import { EvidencePoolManager } from '../evidence-pool'
import { buildL1 } from '../claim-graph/context-views'
import { repairTruncatedJSON } from '../json-repair'
import type {
  ResearchState,
  ArtifactEntry,
  TrajectoryEntry,
} from '../research-state'
import type { VenueConstraints, ResolvedTemplate } from './template-types'
import type {
  NarrativePlan,
  NarrativeSectionPlan,
  NarrativeArc,
  AppendixSectionPlan,
} from './types'
import type { PaperStructure, SectionPlan } from './assembler'

// ── Intermediate types ──────────────────────────────────

interface ExperimentSummary {
  id: string
  description: string
  summary: string
}

interface TurningPoint {
  cycle: number
  event: string
}

// ── NarrativePlanner ────────────────────────────────────

export class NarrativePlanner {
  private projectDir: string
  private modelSpec: string

  constructor(projectDir: string, modelSpec?: string) {
    this.projectDir = projectDir
    this.modelSpec = modelSpec ?? DEFAULT_MODEL_ASSIGNMENTS.research
  }

  async plan(
    state: ResearchState,
    template: ResolvedTemplate,
  ): Promise<NarrativePlan> {
    // 1. Reconstruct claim graph
    const graph = ClaimGraph.fromJSON(state.claimGraph)

    // 2. Wrap evidence pool
    const pool = new EvidencePoolManager(state.evidencePool)

    // 3. Read experiment results from artifacts
    const experiments = this.readExperimentResults(state.artifacts.entries)

    // 4. Extract key turning points from trajectory
    const turningPoints = this.extractKeyTurningPoints(state.trajectory)

    // 5. Build prompt
    const prompt = this.buildPrompt(
      state,
      graph,
      pool,
      template,
      experiments,
      turningPoints,
    )

    // 6. Call LLM
    const response = await chatCompletion({
      modelSpec: this.modelSpec,
      max_tokens: 8192,
      system: `You are an expert academic writing strategist. Design the paper's narrative structure by thinking like a storyteller:

1. **The Hook**: What is the ONE compelling question/problem that opens the paper? (Must grab attention in the first paragraph)
2. **The Gap**: What specific thing is missing in existing work? (Must be precise and falsifiable)
3. **The Insight**: What is the key insight that addresses the gap? (The paper's "aha moment")
4. **The Method**: How do we operationalize the insight?
5. **The Evidence**: What evidence supports the method? (Map admitted claims to specific sections)
6. **The Nuance**: What are the limitations? (Map demoted claims to discussion)
7. **The Hero Figure**: What ONE figure would explain the entire approach?
8. **The Main Table**: What ONE table shows the key result?

Think through each step, then produce a section-by-section plan as valid JSON matching the requested schema.`,
      messages: [{ role: 'user', content: prompt }],
    })

    // 7. Parse response
    const plan = this.parseResponse(response.text)

    // 8. Validate and fix
    const constraints = template.constraints
    return this.validateAndFix(plan, constraints, graph)
  }

  // ── Private methods ─────────────────────────────────────

  readExperimentResults(entries: ArtifactEntry[]): ExperimentSummary[] {
    const experimentEntries = entries.filter(
      e => e.type === 'experiment_result',
    )
    const results: ExperimentSummary[] = []

    for (const entry of experimentEntries.slice(0, 5)) {
      const fullPath = entry.path.startsWith('/')
        ? entry.path
        : join(this.projectDir, entry.path)

      let summary = ''
      if (existsSync(fullPath)) {
        try {
          const raw = readFileSync(fullPath, 'utf-8')
          // Try JSON parse for structured results
          try {
            const parsed = JSON.parse(raw)
            summary = JSON.stringify(parsed, null, 2)
          } catch {
            summary = raw
          }
        } catch {
          summary = '(unable to read file)'
        }
      } else {
        summary = '(file not found)'
      }

      // Truncate to 2000 chars
      if (summary.length > 2000) {
        summary = summary.slice(0, 2000) + '\n... (truncated)'
      }

      results.push({
        id: entry.id,
        description: entry.description,
        summary,
      })
    }

    return results
  }

  extractKeyTurningPoints(trajectory: TrajectoryEntry[]): TurningPoint[] {
    const points: TurningPoint[] = []

    for (const entry of trajectory) {
      const delta = entry.claim_graph_delta
      const isSignificantDelta =
        delta &&
        ((delta.claims_admitted ?? 0) > 0 || (delta.claims_demoted ?? 0) > 0)

      const isSignificantAction =
        (entry.action_type.includes('experiment') ||
          entry.action_type.includes('literature')) &&
        entry.outcome &&
        entry.outcome.length > 10

      if (isSignificantDelta || isSignificantAction) {
        points.push({
          cycle: entry.cycle ?? 0,
          event: `${entry.description} → ${entry.outcome}`,
        })
      }
    }

    return points.slice(-10)
  }

  private buildPrompt(
    state: ResearchState,
    graph: ClaimGraph,
    pool: EvidencePoolManager,
    template: ResolvedTemplate,
    experiments: ExperimentSummary[],
    turningPoints: TurningPoint[],
  ): string {
    const constraints = template.constraints
    const sections: string[] = []

    // ── Venue info ──
    const mainBody = constraints?.page_limits.main_body ?? 'unlimited'
    const pageBudget = constraints?.writing_guidelines?.page_budget ?? {}
    const strategy =
      constraints?.writing_guidelines?.main_body_strategy ?? 'standard'

    const proofStrategy = constraints?.writing_guidelines?.proof_strategy ?? ''
    const relatedWorkPlacement =
      constraints?.writing_guidelines?.related_work_placement ?? ''
    const figureStrategy =
      constraints?.writing_guidelines?.figure_strategy ?? ''
    const tableStrategy = constraints?.writing_guidelines?.table_strategy ?? ''

    sections.push(`## Venue
Template: ${template.manifest.name} (${template.manifest.venue_type})
Main body pages: ${mainBody}
Writing strategy: ${strategy}${proofStrategy ? `\nProof strategy: ${proofStrategy}` : ''}${relatedWorkPlacement ? `\nRelated work placement: ${relatedWorkPlacement}` : ''}${figureStrategy ? `\nFigure strategy: ${figureStrategy}` : ''}${tableStrategy ? `\nTable strategy: ${tableStrategy}` : ''}
Page budget breakdown: ${JSON.stringify(pageBudget)}
Required sections: ${(constraints?.structure.required_sections ?? []).join(', ') || 'none specified'}
Optional sections: ${(constraints?.structure.optional_sections ?? []).join(', ') || 'none specified'}`)

    // ── Admitted claims ──
    const admitted = graph.getClaimsByPhase('admitted')
    const allClaims = [
      ...graph.getClaimsByPhase('admitted'),
      ...graph.getClaimsByPhase('under_investigation'),
      ...graph.getClaimsByPhase('proposed'),
    ]

    // Use L1 compressed view if too many claims
    if (allClaims.length > 30) {
      sections.push(`## Claims (compressed view)\n${buildL1(graph)}`)
    } else {
      if (admitted.length > 0) {
        const claimLines = admitted.map(c => {
          const ev = pool.evidenceFor(c.id)
          const evidenceStr = `(${ev.grounded.length} grounded, ${ev.derived.length} derived)`
          return `- [${c.epistemicLayer}/${c.type}] "${c.statement}" conf:${c.strength.confidence.toFixed(2)} ${evidenceStr} [${c.id}]`
        })
        sections.push(`## Admitted Claims\n${claimLines.join('\n')}`)
      }

      // ── Demoted claims ──
      const demoted = graph.getClaimsByPhase('demoted')
      if (demoted.length > 0) {
        const demotedLines = demoted.map(c => {
          const lastAssessment =
            c.assessment_history.length > 0
              ? c.assessment_history[c.assessment_history.length - 1].reason
              : 'no assessment'
          return `- "${c.statement}" — demoted because: ${lastAssessment} [${c.id}]`
        })
        sections.push(`## Demoted Claims\n${demotedLines.join('\n')}`)
      }
    }

    // ── Experiment results ──
    if (experiments.length > 0) {
      const expLines = experiments.map(
        e => `### ${e.description} (${e.id})\n${e.summary}`,
      )
      sections.push(`## Experiment Results\n${expLines.join('\n\n')}`)
    }

    // ── Key turning points ──
    if (turningPoints.length > 0) {
      const tpLines = turningPoints.map(
        tp => `- Cycle ${tp.cycle}: ${tp.event}`,
      )
      sections.push(`## Key Turning Points\n${tpLines.join('\n')}`)
    }

    // ── Literature awareness ──
    const lit = state.literature_awareness
    if (lit.deeply_read.length > 0) {
      const litLines = lit.deeply_read
        .slice(0, 10)
        .map(
          p =>
            `- ${p.paper_id}: ${p.key_takeaways.slice(0, 2).join('; ')} | relevance: ${p.relevance_to_us}`,
        )
      sections.push(`## Deeply Read Papers\n${litLines.join('\n')}`)
    }
    if (lit.confirmed_gaps.length > 0) {
      const gapLines = lit.confirmed_gaps.map(g => `- ${g.description}`)
      sections.push(`## Confirmed Gaps in Literature\n${gapLines.join('\n')}`)
    }

    // ── Proposal context ──
    const proposal = state.proposal
    sections.push(`## Proposal Context
Title: ${proposal.title}
Abstract: ${proposal.abstract ?? '(none)'}
Paper type: ${state.paper_type}`)

    // ── Output schema ──
    sections.push(`## Expected Output
Return a JSON object with this exact structure:
{
  "narrative_arc": {
    "hook": "opening hook — why this problem matters",
    "gap": "what's missing in prior work",
    "insight": "the core insight/contribution",
    "method_summary": "brief method overview",
    "evidence_summary": "what evidence supports the claims",
    "nuance": "limitations, caveats, honest positioning"
  },
  "hero_figure": {
    "description": "what the figure shows",
    "components": ["subfigure descriptions"],
    "placement": "section name where it goes",
    "estimated_height": "fraction of page, e.g. 0.4"
  } | null,
  "main_table": {
    "content": "what the table compares",
    "experiments_used": ["experiment IDs"],
    "placement": "section name",
    "caption_draft": "draft caption"
  } | null,
  "sections": [
    {
      "name": "section-name",
      "title": "Display Title",
      "page_budget": 1.5,
      "claims_covered": ["claim-id-1", "claim-id-2"],
      "key_points": ["point 1", "point 2"],
      "tone": "assertive|exploratory|comparative|critical",
      "ends_with": "transition hint to next section",
      "experiments_used": ["experiment-id"],
      "contains_hero_figure": false,
      "contains_main_table": false,
      "must_cite": ["citation-key"],
      "demoted_claims_here": ["claim-id"]
    }
  ],
  "appendix_sections": [
    {
      "name": "appendix-name",
      "source_fragment": "fragment-id",
      "source_experiments": ["experiment-id"]
    }
  ]
}

CRITICAL: Use ONLY the claim IDs listed above in claims_covered and demoted_claims_here fields. Do not invent claim IDs.`)

    return sections.join('\n\n')
  }

  parseResponse(text: string): NarrativePlan {
    // Strip markdown fences
    let cleaned = text
      .replace(/```(?:json)?\s*\n?/g, '')
      .replace(/```\s*$/g, '')

    // Try direct parse
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as NarrativePlan
      } catch {
        // fall through to repair
      }
    }

    // Try repair (handles truncated JSON without closing braces)
    const repaired = repairTruncatedJSON(cleaned)
    if (repaired && typeof repaired === 'object') {
      return repaired as NarrativePlan
    }

    throw new Error(
      `Failed to parse NarrativePlan from LLM response (${text.length} chars). Preview: ${text.slice(0, 200)}`,
    )
  }

  validateAndFix(
    plan: NarrativePlan,
    constraints: VenueConstraints | null,
    graph: ClaimGraph,
  ): NarrativePlan {
    // Ensure narrative_arc defaults
    if (!plan.narrative_arc) {
      plan.narrative_arc = {
        hook: '',
        gap: '',
        insight: '',
        method_summary: '',
        evidence_summary: '',
        nuance: '',
      }
    }

    // Default hero_figure and main_table
    if (plan.hero_figure === undefined) plan.hero_figure = null
    if (plan.main_table === undefined) plan.main_table = null

    // Ensure sections array
    if (!Array.isArray(plan.sections)) {
      plan.sections = []
    }

    // Ensure appendix_sections array
    if (!Array.isArray(plan.appendix_sections)) {
      plan.appendix_sections = []
    }

    // Collect all valid claim IDs from the graph
    const validClaimIds = new Set<string>()
    for (const phase of [
      'proposed',
      'under_investigation',
      'admitted',
      'demoted',
      'rejected',
      'retracted',
      'reformulated',
    ] as const) {
      for (const c of graph.getClaimsByPhase(phase)) {
        validClaimIds.add(c.id)
      }
    }

    // Process each section
    for (const section of plan.sections) {
      // Sanitize name: lowercase, hyphens, no special chars
      section.name = section.name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')

      // Add title if missing
      if (!section.title) {
        section.title = section.name
          .split('-')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')
      }

      // Default page_budget
      if (typeof section.page_budget !== 'number' || section.page_budget <= 0) {
        section.page_budget = 1
      }

      // Ensure arrays
      if (!Array.isArray(section.claims_covered)) section.claims_covered = []
      if (!Array.isArray(section.key_points)) section.key_points = []

      // Strip invalid claim IDs
      section.claims_covered = section.claims_covered.filter(id =>
        validClaimIds.has(id),
      )
      if (section.demoted_claims_here) {
        section.demoted_claims_here = section.demoted_claims_here.filter(id =>
          validClaimIds.has(id),
        )
      }

      // Default tone
      if (!section.tone) section.tone = 'assertive'
    }

    // Add missing required sections (before scaling, so they get scaled too)
    if (constraints?.structure.required_sections) {
      const existingNames = new Set(plan.sections.map(s => s.name))
      for (const required of constraints.structure.required_sections) {
        const normalized = required.toLowerCase().replace(/\s+/g, '-')
        if (!existingNames.has(normalized)) {
          plan.sections.push({
            name: normalized,
            title: required,
            page_budget: 1,
            claims_covered: [],
            key_points: [],
            tone: 'assertive',
          })
        }
      }
    }

    // Scale page budgets if they exceed main_body limit
    if (
      constraints?.page_limits.main_body !== undefined &&
      constraints.page_limits.main_body !== 'unlimited'
    ) {
      const maxPages = constraints.page_limits.main_body as number
      const totalBudget = plan.sections.reduce(
        (sum, s) => sum + s.page_budget,
        0,
      )
      if (totalBudget > maxPages) {
        const scale = maxPages / totalBudget
        for (const section of plan.sections) {
          section.page_budget =
            Math.round(section.page_budget * scale * 10) / 10
        }
      }
    }

    return plan
  }
}

// ── Bridge function ─────────────────────────────────────

/**
 * Convert NarrativePlan to the assembler's PaperStructure format.
 * Sections map 1:1 with fragments=[] (to be filled by autoAssign) and needs_transition=true.
 */
export function narrativePlanToStructure(
  plan: NarrativePlan,
  title: string,
  templateId: string,
): PaperStructure {
  const sections: SectionPlan[] = plan.sections.map(s => ({
    name: s.name,
    title: s.title,
    fragments: [],
    needs_transition: true,
  }))

  // Add appendix sections
  for (const appendix of plan.appendix_sections) {
    sections.push({
      name: appendix.name,
      title: appendix.name
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' '),
      fragments: appendix.source_fragment ? [appendix.source_fragment] : [],
      needs_transition: false,
    })
  }

  return {
    title,
    template: templateId,
    sections,
    max_pages: plan.sections.reduce((sum, s) => sum + s.page_budget, 0),
  }
}
