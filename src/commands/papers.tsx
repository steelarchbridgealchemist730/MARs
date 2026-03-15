import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Command } from '@commands'
import { getSessionDir } from '../paper/session'
import {
  getAnthropicClient,
  chatCompletion,
  resetCommandUsage,
  getCommandUsage,
  formatUsage,
} from '../paper/llm-client'
import { DEFAULT_MODEL_ASSIGNMENTS } from '../paper/types'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const ASK_VERBS = [
  'Pondering',
  'Contemplating',
  'Analyzing',
  'Deciphering',
  'Mulling over',
  'Dissecting',
  'Examining',
  'Investigating',
  'Parsing',
  'Scrutinizing',
]

function findResearchDir(): string | null {
  const sessionDir = getSessionDir()
  for (const candidate of [sessionDir, join(sessionDir, 'literature')]) {
    if (
      existsSync(join(candidate, 'discovered-papers.json')) ||
      existsSync(join(candidate, 'survey.md'))
    ) {
      return candidate
    }
  }
  return null
}

function searchPapers(query: string, researchDir: string): string {
  const papersFile = join(researchDir, 'discovered-papers.json')
  if (!existsSync(papersFile)) {
    return 'No discovered papers found. Run /deep-research first.'
  }

  let papers: Array<{
    title: string
    authors: string[]
    year: number
    abstract: string
    source: string
    citation_count: number
    arxiv_id?: string
    doi?: string
  }>
  try {
    papers = JSON.parse(readFileSync(papersFile, 'utf-8'))
  } catch {
    return 'Could not parse discovered-papers.json.'
  }

  const queryLower = query.toLowerCase()
  const matches = papers.filter(
    p =>
      p.title.toLowerCase().includes(queryLower) ||
      p.abstract.toLowerCase().includes(queryLower) ||
      p.authors.some(a => a.toLowerCase().includes(queryLower)),
  )

  if (matches.length === 0) {
    return `No papers matching "${query}" found in ${papers.length} discovered papers.`
  }

  const lines = [`Found ${matches.length} papers matching "${query}":\n`]
  for (const p of matches.slice(0, 20)) {
    const ids = [
      p.arxiv_id ? `arXiv:${p.arxiv_id}` : null,
      p.doi ? `DOI:${p.doi}` : null,
    ]
      .filter(Boolean)
      .join(', ')
    lines.push(
      `- ${p.title} (${p.authors.slice(0, 3).join(', ')}${p.authors.length > 3 ? ' et al.' : ''}, ${p.year}) [citations: ${p.citation_count}]${ids ? ` [${ids}]` : ''}`,
    )
  }
  if (matches.length > 20) lines.push(`\n... and ${matches.length - 20} more.`)
  return lines.join('\n')
}

function readPaper(paperId: string, researchDir: string): string {
  const papersFile = join(researchDir, 'discovered-papers.json')
  if (!existsSync(papersFile)) {
    return 'No discovered papers found. Run /deep-research first.'
  }

  let papers: Array<Record<string, any>>
  try {
    papers = JSON.parse(readFileSync(papersFile, 'utf-8'))
  } catch {
    return 'Could not parse discovered-papers.json.'
  }

  const idLower = paperId.toLowerCase()
  const match = papers.find(
    p =>
      (p.arxiv_id && p.arxiv_id.toLowerCase() === idLower) ||
      (p.source_id && p.source_id.toLowerCase() === idLower) ||
      (p.doi && p.doi.toLowerCase() === idLower) ||
      p.title.toLowerCase().includes(idLower),
  )

  if (!match) {
    return `Paper "${paperId}" not found. Use /papers search <query> to find papers.`
  }

  return [
    `Title: ${match.title}`,
    `Authors: ${(match.authors ?? []).join(', ')}`,
    `Year: ${match.year}`,
    `Source: ${match.source}`,
    `Citations: ${match.citation_count}`,
    match.arxiv_id ? `arXiv: ${match.arxiv_id}` : null,
    match.doi ? `DOI: ${match.doi}` : null,
    match.url ? `URL: ${match.url}` : null,
    '',
    'Abstract:',
    match.abstract || '(no abstract available)',
  ]
    .filter(l => l !== null)
    .join('\n')
}

function loadReportContext(researchDir: string): string {
  const files = ['survey.md', 'gaps.md', 'taxonomy.md', 'timeline.md']
  const parts: string[] = []
  let totalLen = 0
  const maxLen = 60000

  for (const file of files) {
    const filePath = join(researchDir, file)
    if (!existsSync(filePath)) continue
    try {
      const content = readFileSync(filePath, 'utf-8')
      if (totalLen + content.length > maxLen) {
        parts.push(
          `--- ${file} (truncated) ---\n${content.slice(0, maxLen - totalLen)}`,
        )
        break
      }
      parts.push(`--- ${file} ---\n${content}`)
      totalLen += content.length
    } catch {
      continue
    }
  }
  return parts.join('\n\n')
}

// ── PaperQA2 integration ────────────────────────────────

async function tryPaperQA(
  question: string,
  researchDir: string,
): Promise<string | null> {
  try {
    // Check if pqa is available
    const whichProc = Bun.spawn(['which', 'pqa'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if ((await whichProc.exited) !== 0) return null

    // Try to query the PaperQA index
    const litDir = join(researchDir, '..', 'literature')
    const candidateDirs = [litDir, researchDir]
    const targetDir = candidateDirs.find(d => existsSync(d)) ?? researchDir

    const proc = Bun.spawn(['pqa', 'ask', question, '--directory', targetDir], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    })

    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited

    if (exitCode !== 0 || !stdout.trim()) return null

    return `[PaperQA2]\n${stdout.trim()}`
  } catch {
    return null
  }
}

// ── LLM-powered Ask with Spinner ─────────────────────────

function AskSpinner({
  question,
  researchDir,
  onDone,
}: {
  question: string
  researchDir: string
  onDone: (result: string) => void
}): React.ReactNode {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [startTime] = useState(Date.now())
  const [verb] = useState(
    () => ASK_VERBS[Math.floor(Math.random() * ASK_VERBS.length)],
  )

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length)
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 80)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    resetCommandUsage()

    // Try PaperQA2 first (RAG over indexed papers), fall back to report context
    tryPaperQA(question, researchDir)
      .then(pqaResult => {
        if (pqaResult) {
          const usage = formatUsage(getCommandUsage())
          onDone(pqaResult + (usage ? `\n\n${usage}` : ''))
          return
        }

        // Fallback: LLM over pre-computed reports
        const context = loadReportContext(researchDir)
        if (!context.trim()) {
          onDone(
            'No analysis reports found. Run /deep-research first to generate reports.',
          )
          return
        }

        return chatCompletion({
          modelSpec: DEFAULT_MODEL_ASSIGNMENTS.quick,
          max_tokens: 4096,
          system: `You are a research assistant. Answer questions based on the following literature analysis reports. Be specific, cite paper titles when relevant, and structure your answer clearly with bullet points.`,
          messages: [
            {
              role: 'user',
              content: `Based on this research literature:\n\n${context}\n\nQuestion: ${question}`,
            },
          ],
        }).then(response => {
          const usage = formatUsage(getCommandUsage())
          onDone(response.text + (usage ? `\n\n${usage}` : ''))
        })
      })
      .catch(err => {
        onDone(`Error answering question: ${err.message}`)
      })
  }, [])

  const secs = elapsed % 60
  const mins = Math.floor(elapsed / 60)
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

  return (
    <Box marginTop={1}>
      <Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
      <Text bold>{verb}...</Text>
      <Text>
        {' '}
        &quot;{question.slice(0, 50)}
        {question.length > 50 ? '...' : ''}&quot;
      </Text>
      <Text dimColor> ({timeStr})</Text>
    </Box>
  )
}

function refreshPapers(researchDir: string): string {
  const papersFile = join(researchDir, 'discovered-papers.json')
  if (!existsSync(papersFile)) {
    return 'No discovered papers to refresh. Run /deep-research first.'
  }

  let papers: Array<Record<string, any>>
  try {
    papers = JSON.parse(readFileSync(papersFile, 'utf-8'))
  } catch {
    return 'Could not parse discovered-papers.json.'
  }

  // Re-index: deduplicate by title, sort by citation count
  const seen = new Map<string, Record<string, any>>()
  for (const p of papers) {
    const key = p.title.toLowerCase().trim()
    const existing = seen.get(key)
    if (!existing || (p.citation_count ?? 0) > (existing.citation_count ?? 0)) {
      seen.set(key, p)
    }
  }

  const deduped = [...seen.values()].sort(
    (a, b) => (b.citation_count ?? 0) - (a.citation_count ?? 0),
  )
  const removed = papers.length - deduped.length

  writeFileSync(papersFile, JSON.stringify(deduped, null, 2), 'utf-8')

  return [
    `Refreshed paper knowledge base:`,
    `  Total papers: ${deduped.length}`,
    removed > 0 ? `  Duplicates removed: ${removed}` : null,
    `  Sorted by citation count`,
    `  Top paper: "${deduped[0]?.title ?? 'N/A'}" (${deduped[0]?.citation_count ?? 0} citations)`,
  ]
    .filter(Boolean)
    .join('\n')
}

// ── Command ──────────────────────────────────────────────

const papers: Command = {
  type: 'local-jsx',
  name: 'papers',
  userFacingName() {
    return 'papers'
  },
  description: 'Search, read, and query the local paper knowledge base',
  isEnabled: true,
  isHidden: false,
  argumentHint: '<search|read|ask> <query>',
  aliases: [],

  async call(
    onDone: (result?: string) => void,
    _context: any,
    args?: string,
  ): Promise<React.ReactNode> {
    const argsStr = args ?? ''
    const parts = argsStr.trim().split(/\s+/)
    const subcommand = parts[0]
    const query = parts.slice(1).join(' ')

    const researchDir = findResearchDir()
    if (!researchDir) {
      onDone(
        'No research data found. Run /deep-research <topic> first to build a paper knowledge base.',
      )
      return null
    }

    if (
      !subcommand ||
      !['search', 'read', 'ask', 'refresh'].includes(subcommand)
    ) {
      onDone(
        'Usage: /papers search <query> | /papers read <paper-id> | /papers ask <question> | /papers refresh',
      )
      return null
    }

    if (subcommand === 'refresh') {
      onDone(refreshPapers(researchDir))
      return null
    }

    if (!query) {
      onDone(
        `Usage: /papers ${subcommand} <${subcommand === 'read' ? 'paper-id or title' : 'query'}>`,
      )
      return null
    }

    // search and read are synchronous
    if (subcommand === 'search') {
      onDone(searchPapers(query, researchDir))
      return null
    }
    if (subcommand === 'read') {
      onDone(readPaper(query, researchDir))
      return null
    }

    // ask uses LLM — show spinner
    return (
      <AskSpinner
        question={query}
        researchDir={researchDir}
        onDone={result => onDone(result)}
      />
    )
  },
}

export default papers
