export { LaTeXEngine } from './latex-engine'
export type { LaTeXEngineOptions } from './latex-engine'
export { PaperWriter } from './writer'
export {
  postProcessSection,
  extractCiteKeys,
  estimateWordCount,
} from './writer'
export type { PaperOutline, WritingState, FigurePlan, TablePlan } from './types'
export { BibTeXManager, generateKey } from './bibtex-manager'
export { FigureGenerator } from './figure-generator'
export {
  FigureDesigner,
  extractPackageDependencies,
  getVenueSizing,
} from './figure-designer'
export type { BibTeXEntry, SyncResult } from './bibtex-manager'
export { TemplateResolver } from './template-resolver'
export type {
  TemplateManifest,
  VenueConstraints,
  TemplateRegistry,
  TemplateRegistryEntry,
  ResolvedTemplate,
} from './template-types'
export { NarrativePlanner, narrativePlanToStructure } from './narrative-planner'
export { LaTeXFixers } from './latex-fixers'
export { PageChecker } from './page-checker'
export { WritingPipeline, mapSectionToFragmentType } from './pipeline'
export type { WritingPipelineOptions } from './pipeline'
export type {
  NarrativePlan,
  NarrativeSectionPlan,
  NarrativeArc,
  HeroFigurePlan,
  MainTablePlan,
  AppendixSectionPlan,
  ClaimMaterial,
  EvidenceMaterial,
  SectionMaterials,
  PostProcessResult,
  DiagnosisIssue,
  DiagnosisIssueType,
  DiagnosisSeverity,
  CompilationAttempt,
  CompilationResult,
  Diagnosis,
  PageCheckResult,
  CutSuggestion,
  FigureApproach,
  FigureOutput,
  TableOutput,
  FigureMaterials,
  FigureDesignDecision,
  WritingPipelinePhase,
  WritingPipelineResult,
} from './types'
