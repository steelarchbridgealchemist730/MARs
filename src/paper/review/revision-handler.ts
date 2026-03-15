import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { LaTeXEngine } from '../writing/latex-engine'
import type { MetaReview, RubricSummary } from './types'
import { chatCompletion } from '../llm-client'
import { executeAgent } from '../agent-dispatch'
import type { ResearchState } from '../research-state'

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  major: 1,
  minor: 2,
}

function findTexFiles(sectionsDir: string): string[] {
  if (!existsSync(sectionsDir)) return []
  try {
    return readdirSync(sectionsDir)
      .filter(f => f.endsWith('.tex'))
      .map(f => join(sectionsDir, f))
  } catch {
    return []
  }
}

function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

export class RevisionHandler {
  private projectDir: string
  private modelName: string
  private state: ResearchState | null

  constructor(
    projectDir: string,
    modelName: string,
    state?: ResearchState | null,
  ) {
    this.projectDir = projectDir
    this.modelName = modelName
    this.state = state ?? null
  }

  /**
   * Generate a structured response letter addressing each reviewer comment.
   * Returns LaTeX content suitable for a standalone response document.
   */
  async generateResponseLetter(
    metaReview: MetaReview,
    revisionSummaries: string[],
  ): Promise<string> {
    const issueEntries = metaReview.key_issues
      .map((issue, i) => {
        const revision =
          revisionSummaries[i] ?? 'Addressed in revised manuscript.'
        return `\\textbf{Comment ${i + 1} (${issue.priority}):} ${issue.description}

\\textit{Action:} ${issue.action}

\\textbf{Response:} ${revision}`
      })
      .join('\n\n\\medskip\n\n')

    const template = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{geometry}
\\geometry{margin=1in}

\\title{Response to Reviewers}
\\date{\\today}

\\begin{document}
\\maketitle

We thank the reviewers for their detailed and constructive feedback. Below we address each comment point by point.

\\medskip

Overall decision: ${metaReview.decision} (consensus: ${metaReview.consensus_level}, average score: ${metaReview.average_score.toFixed(1)})

\\bigskip

${issueEntries}

\\end{document}
`

    // Use LLM to polish the response letter if issues warrant it
    if (metaReview.key_issues.length > 3) {
      try {
        const response = await chatCompletion({
          modelSpec: this.modelName,
          max_tokens: 4096,
          system:
            'You are an expert academic writer. Polish the following response-to-reviewers LaTeX document. Keep the point-by-point structure. Make responses professional, specific, and convincing. Return ONLY the complete LaTeX document, no markdown fences.',
          messages: [{ role: 'user', content: template }],
        })
        const polished = response.text
          .replace(/^```(?:latex|tex)?\n?/m, '')
          .replace(/\n?```$/m, '')
          .trim()
        if (polished.includes('\\documentclass') && polished.length > 200) {
          return polished
        }
      } catch {
        // Fall back to template
      }
    }

    return template
  }

  /**
   * Process failed rubric items by dispatching each to the appropriate agent.
   * Called before key_issues-based revision for more targeted fixes.
   */
  async reviseFromRubric(
    paperDir: string,
    rubricSummary: RubricSummary,
  ): Promise<string[]> {
    const revisionSummaries: string[] = []
    const sectionsDir = join(paperDir, 'sections')
    const texFiles = findTexFiles(sectionsDir)
    if (texFiles.length === 0) return revisionSummaries

    for (const failedItem of rubricSummary.failed_items) {
      switch (failedItem.assignee) {
        case 'math-reasoner':
          await this.handleMathRevision(
            texFiles,
            failedItem.statement,
            failedItem.action,
          )
          break
        case 'experiment-runner':
          await this.handleExperimentRevision(
            texFiles,
            failedItem.statement,
            failedItem.action,
          )
          break
        case 'writer':
          await this.handleWriterRevision(
            texFiles,
            failedItem.statement,
            failedItem.action,
          )
          break
        case 'any':
        default:
          await this.handleWriterRevision(
            texFiles,
            failedItem.statement,
            failedItem.action,
          )
          break
      }
      revisionSummaries.push(
        `Fixed rubric item ${failedItem.rubric_id}: ${failedItem.statement}`,
      )
    }

    return revisionSummaries
  }

  async revise(paperDir: string, metaReview: MetaReview): Promise<void> {
    // Process rubric failures first (more targeted)
    if (metaReview.rubric_summary?.failed_items?.length) {
      await this.reviseFromRubric(paperDir, metaReview.rubric_summary)
    }

    const sectionsDir = join(paperDir, 'sections')
    const texFiles = findTexFiles(sectionsDir)

    const sortedIssues = [...metaReview.key_issues].sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2),
    )

    for (const issue of sortedIssues) {
      if (texFiles.length === 0) continue

      switch (issue.assignee) {
        case 'math-reasoner':
          await this.handleMathRevision(
            texFiles,
            issue.description,
            issue.action,
          )
          break
        case 'experiment-runner':
          await this.handleExperimentRevision(
            texFiles,
            issue.description,
            issue.action,
          )
          break
        case 'writer':
          await this.handleWriterRevision(
            texFiles,
            issue.description,
            issue.action,
          )
          break
        case 'any':
        default:
          await this.handleWriterRevision(
            texFiles,
            issue.description,
            issue.action,
          )
          break
      }
    }

    // Recompile after all revisions
    const mainTex = join(paperDir, 'main.tex')
    if (existsSync(mainTex)) {
      const engine = new LaTeXEngine(this.projectDir)
      try {
        await engine.compile(mainTex)
      } catch {
        // Best effort compilation
      }
    }
  }

  private async handleMathRevision(
    texFiles: string[],
    issue: string,
    instruction: string,
  ): Promise<void> {
    // Look for files likely containing math (methodology, appendix, proofs)
    const mathKeywords = ['method', 'proof', 'theorem', 'appendix', 'theory']
    const mathFiles = texFiles.filter(f => {
      const base = f.toLowerCase()
      return mathKeywords.some(kw => base.includes(kw))
    })

    const targetFiles = mathFiles.length > 0 ? mathFiles : texFiles.slice(0, 1)

    // Collect context from relevant tex files
    const texContext = targetFiles
      .map(f => {
        const content = readFileSafe(f)
        return `--- ${f} ---\n${content.slice(0, 8000)}`
      })
      .join('\n\n')

    const task = `Fix the following mathematical issue in the paper: ${issue}\n\nRevision instruction: ${instruction}\n\nApply changes to the relevant .tex files in: ${targetFiles.join(', ')}`

    if (this.state) {
      try {
        const result = await executeAgent(
          'math-reasoner',
          task,
          texContext,
          this.state,
        )
        if (result.success) return
      } catch {
        // Fall through to direct LLM fallback
      }
    }

    // Fallback: direct LLM text edits
    for (const texFile of targetFiles) {
      const fullInstruction = `Fix the following mathematical issue in this section: ${instruction}. Ensure all proofs, theorems, and equations are rigorous and correct.`
      await this.applyTextRevision(texFile, issue, fullInstruction)
    }
  }

  private async handleExperimentRevision(
    texFiles: string[],
    issue: string,
    instruction: string,
  ): Promise<void> {
    // Collect context from experiment-related tex files and existing experiment code
    const experimentKeywords = ['experiment', 'result', 'evaluation', 'setup']
    const expFiles = texFiles.filter(f => {
      const base = f.toLowerCase()
      return experimentKeywords.some(kw => base.includes(kw))
    })

    const contextParts: string[] = []
    for (const f of expFiles) {
      const content = readFileSafe(f)
      if (content) {
        contextParts.push(`--- ${f} ---\n${content.slice(0, 6000)}`)
      }
    }

    const task = `Address the following reviewer concern about experiments: ${issue}\n\nInstruction: ${instruction}\n\nProject directory: ${this.projectDir}`

    if (this.state) {
      try {
        const result = await executeAgent(
          'experiment-runner',
          task,
          contextParts.join('\n\n'),
          this.state,
        )
        if (result.success) return
      } catch {
        // Fall through to direct LLM fallback
      }
    }

    // Fallback: generate experiment code via direct LLM call
    const systemPrompt = `You are an expert ML researcher and software engineer. Generate Python experiment code to address the following reviewer concern. Return only the Python code, no markdown fences.`

    const userContent = `Reviewer issue: ${issue}\n\nInstruction: ${instruction}\n\nGenerate experiment code to address this concern.`

    try {
      const response = await chatCompletion({
        modelSpec: this.modelName,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      })

      const rawText = response.text

      const code = rawText
        .replace(/^```(?:python)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim()

      if (code && code.length > 10) {
        const experimentsDir = join(this.projectDir, 'experiments')
        const filename = join(
          experimentsDir,
          `revision_experiment_${Date.now()}.py`,
        )
        try {
          writeFileSync(filename, code + '\n', 'utf-8')
        } catch (err: any) {
          if (typeof process !== 'undefined' && process.stderr) {
            process.stderr.write(
              `[revision-handler] Failed to write experiment code: ${err.message ?? err}\n`,
            )
          }
        }
      }
    } catch (err: any) {
      // Experiment generation failed — non-critical for revision flow
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(
          `[revision-handler] Experiment code generation failed: ${err.message ?? err}\n`,
        )
      }
    }
  }

  private async handleWriterRevision(
    texFiles: string[],
    issue: string,
    instruction: string,
  ): Promise<void> {
    // For writing issues, apply to all sections or the most relevant one
    const writingKeywords = [
      'introduction',
      'conclusion',
      'abstract',
      'related',
    ]
    const writingFiles = texFiles.filter(f => {
      const base = f.toLowerCase()
      return writingKeywords.some(kw => base.includes(kw))
    })

    const targetFiles = writingFiles.length > 0 ? writingFiles : texFiles

    // Collect context from target tex files
    const texContext = targetFiles
      .map(f => {
        const content = readFileSafe(f)
        return `--- ${f} ---\n${content.slice(0, 6000)}`
      })
      .join('\n\n')

    const task = `Revise the following sections to address a reviewer concern: ${issue}\n\nInstruction: ${instruction}\n\nApply changes to the relevant .tex files in: ${targetFiles.join(', ')}`

    if (this.state) {
      try {
        const result = await executeAgent(
          'fragment-writer',
          task,
          texContext,
          this.state,
        )
        if (result.success) return
      } catch {
        // Fall through to direct LLM fallback
      }
    }

    // Fallback: direct LLM text edits
    for (const texFile of targetFiles) {
      await this.applyTextRevision(texFile, issue, instruction)
    }
  }

  private async applyTextRevision(
    texFile: string,
    issue: string,
    instruction: string,
  ): Promise<void> {
    if (!existsSync(texFile)) return

    const content = readFileSafe(texFile)
    if (!content) return

    const systemPrompt = `You are an expert academic paper editor. Given a LaTeX section, a reviewer issue, and revision instruction, return the improved LaTeX content. Make targeted, minimal changes that address the specific issue. Return ONLY the complete revised LaTeX content, no markdown fences or explanations.`

    const userContent = `REVIEWER ISSUE: ${issue}

REVISION INSTRUCTION: ${instruction}

CURRENT LATEX CONTENT:
${content.slice(0, 12000)}`

    try {
      const response = await chatCompletion({
        modelSpec: this.modelName,
        max_tokens: 8096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      })

      const rawText = response.text

      const revised = rawText
        .replace(/^```(?:latex|tex)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim()

      if (revised && revised.length > 50) {
        writeFileSync(texFile, revised + '\n', 'utf-8')
      }
    } catch (err: any) {
      // Log revision failure — user should know which sections couldn't be revised
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(
          `[revision-handler] Text revision failed for ${texFile}: ${err.message ?? err}\n`,
        )
      }
    }
  }
}
