import { join } from 'path'
import { existsSync } from 'fs'

/**
 * Manages a project-local Python venv at `.claude-paper/venv/`
 * for tool dependencies (paper-qa, pymupdf, etc.).
 * Separate from experiment venvs.
 *
 * Prefers `uv` when available, falls back to standard `python3 -m venv`.
 */
export class PythonEnv {
  private projectDir: string
  private venvDir: string
  private uvAvailable: boolean | null = null
  private venvReady = false

  constructor(projectDir: string) {
    this.projectDir = projectDir
    this.venvDir = join(projectDir, '.claude-paper', 'venv')
  }

  /**
   * Ensure a Python package is importable in the managed venv.
   * Creates the venv if it doesn't exist, then installs the package if needed.
   * Returns true if the package is available after the attempt.
   */
  async ensurePackage(pkg: string): Promise<boolean> {
    // Check if already importable in the venv
    if (await this.isImportable(pkg)) return true

    // Set up venv if needed
    await this.setupVenv()
    if (!this.venvReady) return false

    // Check again after venv setup (package might already be there)
    if (await this.isImportable(pkg)) return true

    // Install the package
    return this.install(pkg)
  }

  /**
   * Path to an executable inside the managed venv's bin/.
   */
  binPath(cmd: string): string {
    return join(this.venvDir, 'bin', cmd)
  }

  /**
   * Path to the venv's python3.
   */
  pythonPath(): string {
    return this.binPath('python3')
  }

  /**
   * Check if a package is importable using the venv python.
   */
  private async isImportable(pkg: string): Promise<boolean> {
    const pythonBin = this.pythonPath()
    if (!existsSync(pythonBin)) return false

    // Map package names to import names
    const importName = this.packageToImport(pkg)
    try {
      const proc = Bun.spawn([pythonBin, '-c', `import ${importName}`], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return (await proc.exited) === 0
    } catch {
      return false
    }
  }

  /**
   * Create the venv if it doesn't exist.
   */
  private async setupVenv(): Promise<void> {
    if (this.venvReady) return

    // Already exists?
    if (existsSync(this.pythonPath())) {
      this.venvReady = true
      return
    }

    const useUv = await this.hasUv()

    if (useUv) {
      try {
        const proc = Bun.spawn(['uv', 'venv', this.venvDir], {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: this.projectDir,
        })
        if ((await proc.exited) === 0) {
          this.venvReady = true
          return
        }
      } catch {
        // fall through to python3
      }
    }

    // Fallback: python3 -m venv
    try {
      const proc = Bun.spawn(['python3', '-m', 'venv', this.venvDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if ((await proc.exited) === 0) {
        this.venvReady = true
      }
    } catch {
      // venv creation failed
    }
  }

  /**
   * Install a package into the managed venv.
   */
  private async install(pkg: string): Promise<boolean> {
    const useUv = await this.hasUv()

    if (useUv) {
      try {
        const proc = Bun.spawn(
          ['uv', 'pip', 'install', '--python', this.pythonPath(), pkg],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            cwd: this.projectDir,
          },
        )
        if ((await proc.exited) === 0) return true
      } catch {
        // fall through to pip
      }
    }

    // Fallback: venv pip
    const pipBin = this.binPath('pip')
    if (existsSync(pipBin)) {
      try {
        const proc = Bun.spawn([pipBin, 'install', pkg], {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: this.projectDir,
        })
        return (await proc.exited) === 0
      } catch {
        return false
      }
    }

    return false
  }

  /**
   * Detect uv availability (cached).
   */
  private async hasUv(): Promise<boolean> {
    if (this.uvAvailable !== null) return this.uvAvailable
    try {
      const proc = Bun.spawn(['uv', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      this.uvAvailable = (await proc.exited) === 0
    } catch {
      this.uvAvailable = false
    }
    return this.uvAvailable
  }

  /**
   * Map pip package names to Python import names.
   */
  private packageToImport(pkg: string): string {
    const mapping: Record<string, string> = {
      'paper-qa': 'paperqa',
      pymupdf: 'fitz',
      pymupdf4llm: 'pymupdf4llm',
      pdfplumber: 'pdfplumber',
    }
    return mapping[pkg] ?? pkg.replace(/-/g, '_')
  }
}
