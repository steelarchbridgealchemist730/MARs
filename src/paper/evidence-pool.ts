import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

// ── Types ─────────────────────────────────────────────

export interface GroundedEvidence {
  id: string
  claim: string
  source_type: 'literature' | 'dataset' | 'known_result' | 'external_tool'
  source_ref: string
  verified: boolean
  verification_method?: string
  supports_claims: string[]
  contradicts_claims: string[]
  acquired_at: string
  acquired_by: string
}

export interface DerivedEvidence {
  id: string
  claim: string
  method: 'proof' | 'derivation' | 'computation' | 'simulation' | 'experiment'
  reproducible: boolean
  reproduction_instructions?: string
  artifact_id: string
  assumptions: string[]
  supports_claims: string[]
  contradicts_claims: string[]
  produced_at: string
  produced_by: string
}

export interface EvidencePool {
  grounded: GroundedEvidence[]
  derived: DerivedEvidence[]
}

export interface EvidencePoolSummary {
  total_grounded: number
  verified_grounded: number
  total_derived: number
  reproducible_derived: number
  total_contradictions: number
}

export type GroundedInput = Omit<GroundedEvidence, 'id' | 'acquired_at'>
export type DerivedInput = Omit<DerivedEvidence, 'id' | 'produced_at'>

// ── Manager ───────────────────────────────────────────

export class EvidencePoolManager {
  pool: EvidencePool

  constructor(pool?: EvidencePool) {
    this.pool = pool ?? { grounded: [], derived: [] }
  }

  addGrounded(input: GroundedInput): string {
    const id = randomUUID()
    const entry: GroundedEvidence = {
      ...input,
      id,
      acquired_at: new Date().toISOString(),
    }
    this.pool.grounded.push(entry)
    return id
  }

  addDerived(input: DerivedInput): string {
    const id = randomUUID()
    const entry: DerivedEvidence = {
      ...input,
      id,
      produced_at: new Date().toISOString(),
    }
    this.pool.derived.push(entry)
    return id
  }

  getGrounded(id: string): GroundedEvidence | undefined {
    return this.pool.grounded.find(e => e.id === id)
  }

  getDerived(id: string): DerivedEvidence | undefined {
    return this.pool.derived.find(e => e.id === id)
  }

  evidenceFor(claimId: string): {
    grounded: GroundedEvidence[]
    derived: DerivedEvidence[]
  } {
    return {
      grounded: this.pool.grounded.filter(e =>
        e.supports_claims.includes(claimId),
      ),
      derived: this.pool.derived.filter(e =>
        e.supports_claims.includes(claimId),
      ),
    }
  }

  evidenceAgainst(claimId: string): {
    grounded: GroundedEvidence[]
    derived: DerivedEvidence[]
  } {
    return {
      grounded: this.pool.grounded.filter(e =>
        e.contradicts_claims.includes(claimId),
      ),
      derived: this.pool.derived.filter(e =>
        e.contradicts_claims.includes(claimId),
      ),
    }
  }

  /**
   * Coverage rate: fraction of claims with sufficient evidence.
   * - theorem/novelty claims require BOTH grounded AND derived evidence
   * - all other claim types require EITHER grounded OR derived evidence
   */
  coverageRate(claimIds: string[], claimTypes?: Map<string, string>): number {
    if (claimIds.length === 0) return 0

    let covered = 0
    for (const claimId of claimIds) {
      const forClaim = this.evidenceFor(claimId)
      const type = claimTypes?.get(claimId)
      const needsBoth = type === 'theorem' || type === 'novelty'

      if (needsBoth) {
        if (forClaim.grounded.length > 0 && forClaim.derived.length > 0) {
          covered++
        }
      } else {
        if (forClaim.grounded.length > 0 || forClaim.derived.length > 0) {
          covered++
        }
      }
    }
    return covered / claimIds.length
  }

  summary(): EvidencePoolSummary {
    let verified_grounded = 0
    let reproducible_derived = 0
    let total_contradictions = 0

    for (const e of this.pool.grounded) {
      if (e.verified) verified_grounded++
      if (e.contradicts_claims.length > 0) total_contradictions++
    }
    for (const e of this.pool.derived) {
      if (e.reproducible) reproducible_derived++
      if (e.contradicts_claims.length > 0) total_contradictions++
    }

    return {
      total_grounded: this.pool.grounded.length,
      verified_grounded,
      total_derived: this.pool.derived.length,
      reproducible_derived,
      total_contradictions,
    }
  }

  save(projectDir: string): void {
    const metaDir = join(projectDir, '.claude-paper')
    if (!existsSync(metaDir)) {
      mkdirSync(metaDir, { recursive: true })
    }
    const filePath = join(metaDir, 'evidence-pool.json')
    writeFileSync(filePath, JSON.stringify(this.pool, null, 2), 'utf-8')
  }

  static load(projectDir: string): EvidencePoolManager | null {
    const filePath = join(projectDir, '.claude-paper', 'evidence-pool.json')
    if (!existsSync(filePath)) return null
    try {
      const raw = readFileSync(filePath, 'utf-8')
      return new EvidencePoolManager(JSON.parse(raw))
    } catch {
      return null
    }
  }
}
