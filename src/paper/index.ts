export * from './types'
export { loadModelAssignments } from './llm-client'
export { CheckpointManager } from './checkpoint'
export { ProjectManager } from './project-manager'
export { SystemProbe, probeSystem } from './system-probe'
export type { SystemCapabilities } from './system-probe'
export { PaperAcquisitionChain } from './acquisition'
export type {
  PaperMetadata,
  AcquisitionResult,
  AcquisitionConfig,
} from './acquisition'
export { PDFExtractor, pdfExtractor } from './pdf-extractor'
export type { PDFExtractResult } from './pdf-extractor'
export { BibTeXManager, generateKey } from './writing/bibtex-manager'
export type { SyncResult } from './writing/bibtex-manager'
export { FigureGenerator } from './writing/figure-generator'
export { PaperAssembler } from './writing/assembler'
export type {
  PaperStructure,
  SectionPlan,
  AssemblyResult,
} from './writing/assembler'
export { GitManager, COMMIT_POINTS } from './git-manager'
export { AutoModeOrchestrator } from './auto-mode'
export { BudgetTracker } from './budget-tracker'
export type { BudgetCategory } from './budget-tracker'
export { DeliveryPackager } from './delivery/packager'
export type { DeliveryOptions, DeliveryManifest } from './delivery/types'
// PlanRevisionLoop removed in v3 — absorbed into Orchestrator.digest()
export { CitationGraphTraversal } from './deep-research/citation-graph'
export { Orchestrator } from './orchestrator'
export type {
  OrchestratorCallbacks,
  OrchestratorDecision,
  OrchestratorOptions,
  ReflectionResult,
  ExecutionResult,
} from './orchestrator'
export {
  initializeFromProposal,
  enrichStateWithLLM,
  loadResearchState,
  saveResearchState,
  buildStateContext,
  addTrajectoryEntry,
  recordSpending,
  addArtifact,
  isBudgetLow,
  computeBasicStability,
  createEmptyStability,
  getClaimsByPhase,
  getUnresolvedClaims,
  getAdmittedClaims,
} from './research-state'
export type {
  ResearchState,
  StabilityMetrics,
  LiteratureAwareness,
  TheoryState,
  ProofRecord,
  BudgetState,
  ArtifactStore,
  ArtifactEntry,
  TrajectoryEntry,
  PaperType,
} from './research-state'
export {
  NarrativePlanner,
  narrativePlanToStructure,
} from './writing/narrative-planner'
export type {
  NarrativePlan,
  NarrativeSectionPlan,
  NarrativeArc,
  HeroFigurePlan,
  MainTablePlan,
  AppendixSectionPlan,
} from './writing/types'
export { WritingPipeline } from './writing/pipeline'
export type {
  WritingPipelineResult,
  WritingPipelinePhase,
} from './writing/types'
export { importFromZotero } from './zotero-import'
export type { ZoteroPaper, ZoteroImportResult } from './zotero-import'
export { FragmentStore } from './fragment-store'
export { ProofBudgetController } from './proof-budget'
export type {
  TheoremSpec,
  ProofBudgetDecision,
  TheoremImportance,
} from './proof-budget'
export { MathReasoningController } from './math-reasoning-controller'
export { executeAgent } from './agent-dispatch'
export type { ProofContext, ProofResult } from './math-reasoning-controller'
export type {
  FragmentMeta,
  FragmentIndex,
  FragmentType,
} from './fragment-store'

// Context Management Engine (Step 5)
export { buildL0, buildL1, buildL2 } from './claim-graph/context-views'
export { FocusSelector } from './claim-graph/focus-selector'
export { allocateTokenBudget } from './claim-graph/token-budget'
export type { TokenBudget } from './claim-graph/token-budget'
export { PromptAssembler } from './claim-graph/prompt-assembler'
export {
  BUILDER_SYSTEM_PROMPT,
  SKEPTIC_SYSTEM_PROMPT,
  ARBITER_SYSTEM_PROMPT,
} from './claim-graph/prompt-constants'
export type {
  BuilderOutput,
  SkepticOutput,
  ArbiterOutput,
} from './claim-graph/triple-role-types'
export { ConvergenceDetector } from './convergence'
export { TrajectoryCompressor } from './trajectory-compressor'
export { EvidencePoolCompressor } from './evidence-pool-compressor'
export {
  estimateTokens,
  truncate,
  truncateToTokens,
} from './claim-graph/token-utils'
