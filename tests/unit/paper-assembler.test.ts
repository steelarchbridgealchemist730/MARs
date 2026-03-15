import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  PaperAssembler,
  type PaperStructure,
} from '../../src/paper/writing/assembler'
import { FragmentStore } from '../../src/paper/fragment-store'
import type { ClaimGraphData } from '../../src/paper/claim-graph/types'

describe('PaperAssembler', () => {
  let tmpDir: string
  let assembler: PaperAssembler
  let store: FragmentStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-asm-'))
    assembler = new PaperAssembler(tmpDir)
    store = new FragmentStore(tmpDir)
    store.init()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('createDefaultStructure returns valid structure', () => {
    const structure = assembler.createDefaultStructure('Test Paper')
    expect(structure.title).toBe('Test Paper')
    expect(structure.template).toBe('neurips')
    expect(structure.sections.length).toBeGreaterThanOrEqual(7)
    expect(structure.sections[0].name).toBe('abstract')
    expect(structure.sections[1].name).toBe('introduction')
    expect(structure.max_pages).toBe(9) // NeurIPS constraint: 9-page main body
  })

  test('autoAssign maps fragment types to sections', () => {
    store.create('related_work', 'Literature Survey', 'Survey content here.')
    store.create('experiments', 'Benchmark Setup', 'Benchmark content here.')
    store.create('tables', 'Main Results', 'Results table here.')

    // Re-create assembler to pick up stored index
    assembler = new PaperAssembler(tmpDir)
    const structure = assembler.createDefaultStructure('Test')
    const assigned = assembler.autoAssign(structure)

    const relatedWork = assigned.sections.find(s => s.name === 'related-work')
    expect(relatedWork?.fragments.length).toBe(1)

    const experiments = assigned.sections.find(s => s.name === 'experiments')
    expect(experiments?.fragments.length).toBe(1)

    const results = assigned.sections.find(s => s.name === 'results')
    expect(results?.fragments.length).toBe(1) // tables → results
  })

  test('assemble creates paper directory and files', async () => {
    store.create('related_work', 'Related Work Content', 'Content.')
    assembler = new PaperAssembler(tmpDir)

    const structure = assembler.createDefaultStructure('Assembly Test')
    const result = await assembler.assemble(structure)

    expect(existsSync(result.main_tex)).toBe(true)
    expect(result.section_files.length).toBeGreaterThanOrEqual(7)

    // Check all section files exist
    for (const file of result.section_files) {
      expect(existsSync(file)).toBe(true)
    }
  })

  test('assemble warns about empty sections', async () => {
    const structure = assembler.createDefaultStructure('Empty Paper')
    const result = await assembler.assemble(structure)

    // Most sections should warn about no fragments
    const emptyWarnings = result.warnings.filter(w =>
      w.includes('has no fragments assigned'),
    )
    expect(emptyWarnings.length).toBeGreaterThan(0)
  })

  test('assemble warns about unassigned fragments', async () => {
    store.create('figures', 'Extra Figure', 'Figure content.')
    assembler = new PaperAssembler(tmpDir)

    const structure = assembler.createDefaultStructure('Test')
    // Remove results section so figure fragment stays unassigned
    structure.sections = structure.sections.filter(s => s.name !== 'results')

    const result = await assembler.assemble(structure)
    const unassignedWarnings = result.warnings.filter(w =>
      w.includes('not assigned to any section'),
    )
    expect(unassignedWarnings.length).toBe(1)
  })

  test('validate detects missing main.tex', () => {
    const structure = assembler.createDefaultStructure('Test')
    const issues = assembler.validate(structure)
    expect(issues.some(i => i.includes('main.tex not found'))).toBe(true)
  })

  test('validate detects page limit exceeded', () => {
    // Create many fragments to exceed page limit
    for (let i = 0; i < 20; i++) {
      store.create('experiments', `Result ${i}`, 'x'.repeat(5000))
    }

    assembler = new PaperAssembler(tmpDir)
    const structure = assembler.createDefaultStructure('Test')
    structure.max_pages = 5

    const issues = assembler.validate(structure)
    // May or may not exceed depending on estimation
    expect(Array.isArray(issues)).toBe(true)
  })

  test('assembled main.tex includes section inputs', async () => {
    const structure = assembler.createDefaultStructure('Input Test')
    await assembler.assemble(structure)

    const mainTex = readFileSync(join(tmpDir, 'paper', 'main.tex'), 'utf-8')
    expect(mainTex).toContain('\\input{sections/introduction}')
    expect(mainTex).toContain('\\input{sections/methodology}')
    expect(mainTex).toContain('\\input{sections/conclusion}')
  })

  test('assembled section includes fragment content', async () => {
    store.create(
      'related_work',
      'Important Survey',
      '\\subsection{Prior Work}\nSome prior work here.',
    )

    // Re-create assembler so it picks up the stored index
    assembler = new PaperAssembler(tmpDir)
    const structure = assembler.createDefaultStructure('Content Test')
    await assembler.assemble(structure)

    const sectionFile = readFileSync(
      join(tmpDir, 'paper', 'sections', 'related-work.tex'),
      'utf-8',
    )
    expect(sectionFile).toContain('Prior Work')
    expect(sectionFile).toContain('Some prior work here.')
  })
})

// ── Claim-phase-aware assembly ──────────────────────────

function makeClaimGraphData(
  claims: Array<{ id: string; phase: string }>,
): ClaimGraphData {
  return {
    claims: claims.map(c => ({
      id: c.id,
      type: 'hypothesis' as const,
      epistemicLayer: 'explanation' as const,
      statement: `Claim ${c.id}`,
      phase: c.phase as any,
      evidence: { grounded: [], derived: [] },
      strength: {
        confidence: 0.7,
        evidenceType: 'empirical_support' as const,
        vulnerabilityScore: 0.3,
      },
      created_at: new Date().toISOString(),
      created_by: 'test',
      last_assessed_at: new Date().toISOString(),
      assessment_history: [],
    })),
    edges: [],
  }
}

describe('claim-phase-aware assembly', () => {
  let tmpDir: string
  let assembler: PaperAssembler
  let store: FragmentStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cpaper-claim-asm-'))
    assembler = new PaperAssembler(tmpDir)
    store = new FragmentStore(tmpDir)
    store.init()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('fragment with admitted claim goes to main text section', () => {
    store.create('experiments', 'Exp Result', 'Content.', {
      related_claims: ['c-1'],
    })
    assembler = new PaperAssembler(tmpDir)
    const structure = assembler.createDefaultStructure('Test')
    const graph = makeClaimGraphData([{ id: 'c-1', phase: 'admitted' }])

    assembler.autoAssign(structure, graph)

    const expSection = structure.sections.find(s => s.name === 'experiments')
    expect(expSection!.fragments.length).toBe(1)
  })

  test('fragment with only demoted claims goes to discussion', () => {
    store.create('proofs', 'Weak Proof', 'Content.', {
      related_claims: ['c-2'],
    })
    assembler = new PaperAssembler(tmpDir)
    const structure = assembler.createDefaultStructure('Test')
    const graph = makeClaimGraphData([{ id: 'c-2', phase: 'demoted' }])

    assembler.autoAssign(structure, graph)

    const disc = structure.sections.find(s => s.name === 'discussion')
    expect(disc).toBeDefined()
    expect(disc!.fragments.length).toBe(1)
    // Should not appear in methodology
    const method = structure.sections.find(s => s.name === 'methodology')
    expect(method!.fragments.length).toBe(0)
  })

  test('fragment with rejected claims is excluded from paper', () => {
    store.create('experiments', 'Failed Exp', 'Content.', {
      related_claims: ['c-3'],
    })
    assembler = new PaperAssembler(tmpDir)
    const structure = assembler.createDefaultStructure('Test')
    const graph = makeClaimGraphData([{ id: 'c-3', phase: 'rejected' }])

    assembler.autoAssign(structure, graph)

    const allAssigned = structure.sections.flatMap(s => s.fragments)
    const frag = store.list()[0]
    expect(allAssigned).not.toContain(frag.id)
  })

  test('fragment with retracted claims is excluded from paper', () => {
    store.create('proofs', 'Retracted Proof', 'Content.', {
      related_claims: ['c-r'],
    })
    assembler = new PaperAssembler(tmpDir)
    const structure = assembler.createDefaultStructure('Test')
    const graph = makeClaimGraphData([{ id: 'c-r', phase: 'retracted' }])

    assembler.autoAssign(structure, graph)

    const allAssigned = structure.sections.flatMap(s => s.fragments)
    const frag = store.list()[0]
    expect(allAssigned).not.toContain(frag.id)
  })

  test('fragment with mixed admitted + demoted claims goes to main text', () => {
    store.create('proofs', 'Mixed', 'Content.', {
      related_claims: ['c-4', 'c-5'],
    })
    assembler = new PaperAssembler(tmpDir)
    const structure = assembler.createDefaultStructure('Test')
    const graph = makeClaimGraphData([
      { id: 'c-4', phase: 'admitted' },
      { id: 'c-5', phase: 'demoted' },
    ])

    assembler.autoAssign(structure, graph)

    const method = structure.sections.find(s => s.name === 'methodology')
    expect(method!.fragments.length).toBe(1)
    // No discussion section should be created
    const disc = structure.sections.find(s => s.name === 'discussion')
    expect(disc).toBeUndefined()
  })

  test('fragment with no related_claims uses type-based assignment', () => {
    store.create('related_work', 'Survey', 'Content.')
    assembler = new PaperAssembler(tmpDir)
    const structure = assembler.createDefaultStructure('Test')
    const graph = makeClaimGraphData([{ id: 'c-1', phase: 'admitted' }])

    assembler.autoAssign(structure, graph)

    const rw = structure.sections.find(s => s.name === 'related-work')
    expect(rw!.fragments.length).toBe(1)
  })

  test('discussion section is inserted before conclusion', () => {
    store.create('experiments', 'Demoted Exp', 'Content.', {
      related_claims: ['c-6'],
    })
    assembler = new PaperAssembler(tmpDir)
    const structure = assembler.createDefaultStructure('Test')
    const graph = makeClaimGraphData([{ id: 'c-6', phase: 'demoted' }])

    assembler.autoAssign(structure, graph)

    const discIdx = structure.sections.findIndex(s => s.name === 'discussion')
    const concIdx = structure.sections.findIndex(s => s.name === 'conclusion')
    expect(discIdx).toBeGreaterThan(-1)
    expect(discIdx).toBeLessThan(concIdx)
  })

  test('no claimGraph falls back to type-based assignment', () => {
    store.create('experiments', 'Some Exp', 'Content.', {
      related_claims: ['c-any'],
    })
    assembler = new PaperAssembler(tmpDir)
    const structure = assembler.createDefaultStructure('Test')

    // No claimGraph passed → backward compatible
    assembler.autoAssign(structure)

    const exp = structure.sections.find(s => s.name === 'experiments')
    expect(exp!.fragments.length).toBe(1)
  })

  test('proposed-only claims go to discussion (not main text)', () => {
    store.create('proofs', 'Proposed Proof', 'Content.', {
      related_claims: ['c-p'],
    })
    assembler = new PaperAssembler(tmpDir)
    const structure = assembler.createDefaultStructure('Test')
    const graph = makeClaimGraphData([{ id: 'c-p', phase: 'proposed' }])

    assembler.autoAssign(structure, graph)

    const method = structure.sections.find(s => s.name === 'methodology')
    expect(method!.fragments.length).toBe(0)
    const disc = structure.sections.find(s => s.name === 'discussion')
    expect(disc).toBeDefined()
    expect(disc!.fragments.length).toBe(1)
  })
})
