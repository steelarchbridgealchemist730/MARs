import { join } from 'path'
import { mkdirSync, copyFileSync, existsSync } from 'fs'
import { chatCompletion } from '../llm-client'

export class FigureGenerator {
  private projectDir: string
  private modelName: string

  constructor(projectDir: string, modelName: string) {
    this.projectDir = projectDir
    this.modelName = modelName
  }

  async generateMatplotlib(
    description: string,
    data?: string,
    outputPath?: string,
  ): Promise<string> {
    const figuresDir = join(this.projectDir, 'paper', 'figures')
    mkdirSync(figuresDir, { recursive: true })

    const resolvedOutputPath =
      outputPath ?? join(figuresDir, `figure_${Date.now()}.png`)

    const systemPrompt = `You are an expert Python programmer specializing in data visualization with matplotlib. Generate a complete, runnable Python script that creates a figure and saves it to a file. The script should:
- Import matplotlib and any other necessary libraries from the standard library only
- Save the figure to the exact path specified
- Use plt.savefig(output_path, dpi=150, bbox_inches='tight')
- Be self-contained with no external data file dependencies unless data is provided inline
- Call plt.close() after saving

Return ONLY the Python code, no markdown fences or explanations.`

    const userContent = `Generate a matplotlib Python script for the following figure:

Description: ${description}
${data ? `\nData to use:\n${data}` : ''}

Save the figure to: ${resolvedOutputPath}`

    const response = await chatCompletion({
      modelSpec: this.modelName,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    })

    const rawText = response.text

    // Strip markdown fences if present
    const code = rawText
      .replace(/^```(?:python)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim()

    // Write script to a temp file
    const scriptPath = join(figuresDir, `_gen_figure_${Date.now()}.py`)
    const { writeFileSync } = await import('fs')
    writeFileSync(scriptPath, code + '\n', 'utf-8')

    // Run the script
    const proc = Bun.spawn(['python3', scriptPath], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: figuresDir,
    })

    await proc.exited

    const exitCode = proc.exitCode ?? 0
    if (exitCode !== 0) {
      let stderrText = ''
      try {
        stderrText = await new Response(proc.stderr as ReadableStream).text()
      } catch {
        // best effort
      }
      throw new Error(
        `Figure generation script failed (exit ${exitCode}): ${stderrText.trim().slice(0, 500)}`,
      )
    }

    // Clean up script
    try {
      const { unlinkSync } = await import('fs')
      unlinkSync(scriptPath)
    } catch {
      // best effort
    }

    return resolvedOutputPath
  }

  async importFigure(
    sourcePath: string,
    figureId: string,
    caption: string,
  ): Promise<string> {
    const figuresDir = join(this.projectDir, 'paper', 'figures')
    mkdirSync(figuresDir, { recursive: true })

    const destPath = join(figuresDir, `${figureId}.png`)

    if (!existsSync(sourcePath)) {
      throw new Error(`Source figure not found: ${sourcePath}`)
    }

    copyFileSync(sourcePath, destPath)

    const snippet = [
      '\\begin{figure}[htbp]',
      '  \\centering',
      `  \\includegraphics[width=0.8\\textwidth]{figures/${figureId}.png}`,
      `  \\caption{${caption}}`,
      `  \\label{fig:${figureId}}`,
      '\\end{figure}',
    ].join('\n')

    return snippet
  }
}
