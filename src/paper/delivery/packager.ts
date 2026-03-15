import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
} from 'fs'
import { join, basename } from 'path'
import type { DeliveryManifest, DeliveryOptions } from './types'

function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function copyDirRecursive(
  src: string,
  dest: string,
  exclude: string[] = [],
): void {
  if (!existsSync(src)) return
  mkdirSync(dest, { recursive: true })
  const entries = readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    if (exclude.includes(entry.name)) continue
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, exclude)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

function collectFiles(
  dir: string,
  baseDir: string,
  result: Array<{ path: string; description: string }> = [],
  description = '',
): Array<{ path: string; description: string }> {
  if (!existsSync(dir)) return result
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const relPath = fullPath.replace(baseDir + '/', '')
    if (entry.isDirectory()) {
      collectFiles(fullPath, baseDir, result, description || entry.name)
    } else {
      result.push({ path: relPath, description: description || entry.name })
    }
  }
  return result
}

function extractPaperTitle(projectDir: string): string {
  const mainTexPath = join(projectDir, 'paper', 'main.tex')
  const content = readFileSafe(mainTexPath)
  const match = content.match(/\\title\{([^}]+)\}/)
  if (match && match[1]) return match[1].trim()

  // Fallback: try to read from state
  const statePath = join(projectDir, '.claude-paper', 'state.json')
  const stateContent = readFileSafe(statePath)
  if (stateContent) {
    try {
      const state = JSON.parse(stateContent)
      if (state.topic) return state.topic
    } catch {
      // ignore
    }
  }

  return 'Research Paper'
}

export class DeliveryPackager {
  private projectDir: string

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  async package(options: DeliveryOptions): Promise<DeliveryManifest> {
    const format = options.format ?? 'standard'
    const outputDir = options.output_dir ?? join(this.projectDir, 'delivery')

    mkdirSync(outputDir, { recursive: true })

    const paperTitle = extractPaperTitle(this.projectDir)
    const files: Array<{ path: string; description: string }> = []

    // Copy main.tex
    const mainTexSrc = join(this.projectDir, 'paper', 'main.tex')
    if (existsSync(mainTexSrc)) {
      const dest = join(outputDir, 'main.tex')
      copyFileSync(mainTexSrc, dest)
      files.push({ path: 'main.tex', description: 'Main LaTeX source file' })
    }

    // Copy main.pdf
    const mainPdfSrc = join(this.projectDir, 'paper', 'main.pdf')
    if (existsSync(mainPdfSrc)) {
      const dest = join(outputDir, 'main.pdf')
      copyFileSync(mainPdfSrc, dest)
      files.push({ path: 'main.pdf', description: 'Compiled PDF' })
    }

    // Copy sections/
    const sectionsSrc = join(this.projectDir, 'paper', 'sections')
    if (existsSync(sectionsSrc)) {
      const sectionsDest = join(outputDir, 'sections')
      copyDirRecursive(sectionsSrc, sectionsDest)
      const sectionFiles = collectFiles(sectionsDest, outputDir)
      for (const f of sectionFiles) {
        files.push({ path: f.path, description: 'LaTeX section' })
      }
    }

    // Copy figures/
    const figuresSrc = join(this.projectDir, 'paper', 'figures')
    if (existsSync(figuresSrc)) {
      const figuresDest = join(outputDir, 'figures')
      copyDirRecursive(figuresSrc, figuresDest)
      const figureFiles = collectFiles(figuresDest, outputDir)
      for (const f of figureFiles) {
        files.push({ path: f.path, description: 'Figure' })
      }
    }

    // Copy references.bib
    const bibSrc = join(this.projectDir, 'paper', 'references.bib')
    if (existsSync(bibSrc)) {
      const dest = join(outputDir, 'references.bib')
      copyFileSync(bibSrc, dest)
      files.push({
        path: 'references.bib',
        description: 'BibTeX references',
      })
    }

    // Copy experiments/ if include_code
    if (options.include_code) {
      const experimentsSrc = join(this.projectDir, 'experiments')
      if (existsSync(experimentsSrc)) {
        const experimentsDest = join(outputDir, 'experiments')
        copyDirRecursive(experimentsSrc, experimentsDest, [
          '.venv',
          '__pycache__',
          '.checkpoints',
        ])
        const expFiles = collectFiles(experimentsDest, outputDir)
        for (const f of expFiles) {
          files.push({ path: f.path, description: 'Experiment code' })
        }
      }
    }

    // Create reproduction script
    await this.createReproductionScript(outputDir)
    files.push({
      path: 'run_all.sh',
      description: 'Reproduction shell script',
    })

    // Create README.md
    this.createReadme(outputDir, paperTitle, options)
    files.push({ path: 'README.md', description: 'Reproduction instructions' })

    // Format-specific post-processing
    let pdfPath = join(outputDir, 'main.pdf')
    if (format === 'arxiv') {
      const bundlePath = await this.createArxivBundle(outputDir)
      files.push({
        path: basename(bundlePath),
        description: 'arXiv submission bundle (.tar.gz)',
      })
    } else if (format === 'camera-ready') {
      this.applyCameraReadyTransforms(outputDir)
      files.push({
        path: 'camera-ready-notes.txt',
        description: 'Camera-ready transformation notes',
      })
    }

    // Write manifest
    const manifest: DeliveryManifest = {
      created_at: new Date().toISOString(),
      format,
      files,
      paper_title: paperTitle,
      pdf_path: pdfPath,
      source_dir: outputDir,
    }

    const manifestPath = join(outputDir, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
    files.push({ path: 'manifest.json', description: 'Delivery manifest' })

    // Git management: commit deliverables and tag
    if (options.git_tag !== false) {
      await this.gitCommitAndTag(outputDir, format, paperTitle)
    }

    return manifest
  }

  private async createReproductionScript(outputDir: string): Promise<void> {
    const scriptContent = `#!/usr/bin/env bash
# Reproduction script for Claude Paper
# Generated at: ${new Date().toISOString()}

set -euo pipefail

echo "=== Claude Paper Reproduction Script ==="
echo ""

# Step 1: Set up Python environment
if [ -d "experiments" ]; then
  echo "Step 1: Setting up Python environment..."
  cd experiments

  if command -v uv &> /dev/null; then
    echo "  Using uv for environment setup..."
    uv venv .venv
    source .venv/bin/activate
    if [ -f "requirements.txt" ]; then
      uv pip install -r requirements.txt
    fi
  elif command -v python3 &> /dev/null; then
    echo "  Using python3/venv for environment setup..."
    python3 -m venv .venv
    source .venv/bin/activate
    if [ -f "requirements.txt" ]; then
      pip install -r requirements.txt
    fi
  else
    echo "  Warning: No Python interpreter found. Skipping environment setup."
  fi

  # Step 2: Run experiment scripts in order
  echo ""
  echo "Step 2: Running experiment scripts..."
  for script in *.py; do
    if [ -f "$script" ]; then
      echo "  Running $script..."
      python "$script" || echo "  Warning: $script exited with non-zero code"
    fi
  done

  cd ..
else
  echo "Step 1-2: No experiments directory found. Skipping."
fi

echo ""

# Step 3: Compile LaTeX paper
echo "Step 3: Compiling LaTeX paper..."
if command -v pdflatex &> /dev/null; then
  echo "  Running pdflatex (2 passes for references)..."
  pdflatex -interaction=nonstopmode main.tex
  if [ -f "references.bib" ]; then
    bibtex main || true
    pdflatex -interaction=nonstopmode main.tex
    pdflatex -interaction=nonstopmode main.tex
  fi
  echo "  Compilation complete: main.pdf"
else
  echo "  Warning: pdflatex not found. Install TeX Live or MiKTeX to compile."
fi

echo ""
echo "=== Reproduction complete ==="
`

    const scriptPath = join(outputDir, 'run_all.sh')
    writeFileSync(scriptPath, scriptContent, 'utf-8')

    // Make executable
    Bun.spawn(['chmod', '+x', scriptPath])
  }

  private createReadme(
    outputDir: string,
    paperTitle: string,
    options: DeliveryOptions,
  ): void {
    const format = options.format ?? 'standard'
    const includeCode = options.include_code ?? false

    const content = `# ${paperTitle}

## Overview

This package contains the paper source files and${includeCode ? ' experiment code for' : ''} "${paperTitle}".

**Delivery format:** ${format}
**Generated:** ${new Date().toISOString()}

## Contents

- \`main.tex\` — Main LaTeX source file
- \`main.pdf\` — Compiled PDF (if available)
- \`sections/\` — Individual LaTeX section files
- \`figures/\` — Figures and plots
- \`references.bib\` — BibTeX references${includeCode ? '\n- `experiments/` — Experiment code and scripts' : ''}
- \`run_all.sh\` — Reproduction script
- \`manifest.json\` — Delivery manifest

## Reproducing Results

### Prerequisites

- Python 3.8+ (for experiments)
- TeX Live or MiKTeX (for LaTeX compilation)
- \`uv\` (optional, recommended for Python environment management)

### Steps

1. **Run the reproduction script:**
   \`\`\`bash
   chmod +x run_all.sh
   ./run_all.sh
   \`\`\`

2. **Or manually:**

   **Set up Python environment:**
   \`\`\`bash
   cd experiments
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   \`\`\`

   **Run experiments:**
   \`\`\`bash
   python main_experiment.py
   \`\`\`

   **Compile LaTeX:**
   \`\`\`bash
   pdflatex main.tex
   bibtex main
   pdflatex main.tex
   pdflatex main.tex
   \`\`\`

## Citation

If you use this work, please cite:

\`\`\`bibtex
@article{paper2026,
  title={${paperTitle}},
  author={Anonymous},
  year={2026}
}
\`\`\`
`

    const readmePath = join(outputDir, 'README.md')
    writeFileSync(readmePath, content, 'utf-8')
  }

  /**
   * Apply camera-ready transforms: de-anonymize, add copyright notice, clean draft markers.
   */
  private applyCameraReadyTransforms(outputDir: string): void {
    const mainTexPath = join(outputDir, 'main.tex')
    if (!existsSync(mainTexPath)) return

    let content = readFileSync(mainTexPath, 'utf-8')
    const notes: string[] = ['Camera-ready transformations applied:']

    // Remove anonymous mode flags common in conference templates
    const anonPatterns = [
      /\\usepackage\[anonymous\]\{neurips_\d+\}/g,
      /\\usepackage\[anonymous\]\{icml\d+\}/g,
      /\\usepackage\[anonymous\]\{aaai\d*\}/g,
      /\\usepackage\[anonymous\]\{acl\d*\}/g,
      /\\usepackage\[review\]\{[^}]+\}/g,
      /\\anonymoustrue/g,
      /\\setcounter\{footnote\}\{0\}\s*%\s*anonymous/gi,
    ]
    for (const pattern of anonPatterns) {
      if (pattern.test(content)) {
        content = content.replace(pattern, match => {
          // Replace [anonymous] option with non-anonymous version
          if (match.includes('[anonymous]')) {
            return match.replace('[anonymous]', '')
          }
          // Comment out \\anonymoustrue
          if (match.includes('\\anonymoustrue')) {
            return '% \\anonymoustrue  % disabled for camera-ready'
          }
          return '% ' + match + '  % disabled for camera-ready'
        })
        notes.push('  - Removed anonymization flags')
      }
    }

    // Remove "Under review" / draft watermark markers
    const draftPatterns = [
      /\\usepackage\{draftwatermark\}[^\n]*/g,
      /\\SetWatermarkText\{[^}]*\}/g,
      /% DRAFT[^\n]*/gi,
    ]
    for (const pattern of draftPatterns) {
      if (pattern.test(content)) {
        content = content.replace(
          pattern,
          match => '% ' + match + '  % removed for camera-ready',
        )
        notes.push('  - Removed draft watermark markers')
      }
    }

    // Add copyright notice if not present
    if (!content.includes('% Camera-ready version')) {
      const preambleEnd = content.indexOf('\\begin{document}')
      if (preambleEnd !== -1) {
        const copyrightNotice = [
          '',
          '% Camera-ready version',
          '% Copyright notice: Please add your venue-specific copyright here.',
          '',
        ].join('\n')
        content =
          content.slice(0, preambleEnd) +
          copyrightNotice +
          content.slice(preambleEnd)
        notes.push('  - Added camera-ready copyright placeholder')
      }
    }

    // Ensure \\final flag is set if template supports it (NeurIPS style)
    if (content.includes('neurips') && !content.includes('\\final')) {
      const docClassEnd = content.indexOf(
        '\n',
        content.indexOf('\\documentclass'),
      )
      if (docClassEnd !== -1) {
        content =
          content.slice(0, docClassEnd + 1) +
          '\\final\n' +
          content.slice(docClassEnd + 1)
        notes.push('  - Added \\final flag for NeurIPS template')
      }
    }

    // ICML: set \\icmlfinalcopy if template uses it
    if (content.includes('icml') && !content.includes('\\icmlfinalcopy')) {
      const docClassEnd = content.indexOf(
        '\n',
        content.indexOf('\\documentclass'),
      )
      if (docClassEnd !== -1) {
        content =
          content.slice(0, docClassEnd + 1) +
          '\\icmlfinalcopy\n' +
          content.slice(docClassEnd + 1)
        notes.push('  - Added \\icmlfinalcopy flag for ICML template')
      }
    }

    // AAAI: replace \\nocopyright with nothing (enable copyright)
    if (content.includes('\\nocopyright')) {
      content = content.replace(
        /\\nocopyright/g,
        '% \\nocopyright  % enabled for camera-ready',
      )
      notes.push('  - Removed \\nocopyright for AAAI camera-ready')
    }

    writeFileSync(mainTexPath, content, 'utf-8')

    if (notes.length === 1) {
      notes.push('  - No transformations needed (already camera-ready)')
    }

    // Write transformation notes
    const notesPath = join(outputDir, 'camera-ready-notes.txt')
    writeFileSync(notesPath, notes.join('\n') + '\n', 'utf-8')
  }

  /**
   * Git commit deliverables and create a version tag.
   */
  private async gitCommitAndTag(
    outputDir: string,
    format: string,
    paperTitle: string,
  ): Promise<void> {
    // Check if we're in a git repo
    const gitCheck = Bun.spawn(['git', 'rev-parse', '--is-inside-work-tree'], {
      cwd: this.projectDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const gitCheckResult = await new Response(gitCheck.stdout).text()
    if (gitCheckResult.trim() !== 'true') return

    // Stage delivery files
    const addProc = Bun.spawn(['git', 'add', outputDir], {
      cwd: this.projectDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await addProc.exited

    // Also stage paper/ directory if it exists
    const paperDir = join(this.projectDir, 'paper')
    if (existsSync(paperDir)) {
      const addPaper = Bun.spawn(['git', 'add', paperDir], {
        cwd: this.projectDir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await addPaper.exited
    }

    // Commit
    const commitMsg = `chore: package ${format} delivery for "${paperTitle}"`
    const commitProc = Bun.spawn(
      ['git', 'commit', '-m', commitMsg, '--allow-empty'],
      {
        cwd: this.projectDir,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    await commitProc.exited

    // Tag with format and timestamp
    const timestamp = new Date().toISOString().slice(0, 10)
    const tag = `delivery/${format}-${timestamp}`
    const tagProc = Bun.spawn(
      ['git', 'tag', '-a', tag, '-m', `Delivery: ${format} - ${paperTitle}`],
      {
        cwd: this.projectDir,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    await tagProc.exited
  }

  async createArxivBundle(outputDir: string): Promise<string> {
    const timestamp = Date.now()
    const bundleName = `arxiv-submission-${timestamp}.tar.gz`
    const bundlePath = join(outputDir, bundleName)

    // Collect files to include in the flat arXiv bundle
    const filesToBundle: string[] = []

    const topLevelFiles = ['main.tex', 'references.bib']
    for (const f of topLevelFiles) {
      const fp = join(outputDir, f)
      if (existsSync(fp)) filesToBundle.push(f)
    }

    // Add sections (flattened into sections/)
    const sectionsDir = join(outputDir, 'sections')
    if (existsSync(sectionsDir)) {
      const sectionFiles = readdirSync(sectionsDir)
      for (const sf of sectionFiles) {
        filesToBundle.push(join('sections', sf))
      }
    }

    // Add figures (flattened into figures/)
    const figuresDir = join(outputDir, 'figures')
    if (existsSync(figuresDir)) {
      const figureFiles = readdirSync(figuresDir)
      for (const ff of figureFiles) {
        filesToBundle.push(join('figures', ff))
      }
    }

    // Create tar.gz using Bun.spawn
    const args = ['tar', '-czf', bundlePath, ...filesToBundle]
    const proc = Bun.spawn(args, {
      cwd: outputDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(
        `Failed to create arXiv bundle: tar exited with ${exitCode}: ${stderr}`,
      )
    }

    if (!existsSync(bundlePath)) {
      throw new Error(`arXiv bundle was not created at ${bundlePath}`)
    }

    return bundlePath
  }
}
