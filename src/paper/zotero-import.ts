/**
 * Import papers from a Zotero library.
 *
 * Zotero stores its data in a SQLite database (zotero.sqlite) inside
 * the Zotero data directory. On macOS: ~/Zotero/zotero.sqlite
 * Attachments (PDFs) are stored alongside in the `storage/` directory.
 *
 * This module reads the Zotero database to extract paper metadata and
 * copies associated PDFs into the project's literature directory.
 */

import { existsSync, copyFileSync, mkdirSync, readdirSync } from 'fs'
import { join, basename, extname } from 'path'

export interface ZoteroPaper {
  title: string
  authors: string[]
  year: number
  doi?: string
  arxiv_id?: string
  pdf_path?: string // path to PDF in Zotero storage
}

export interface ZoteroImportResult {
  imported: number
  skipped: number
  papers: ZoteroPaper[]
  errors: string[]
}

/**
 * Resolve the Zotero data directory from a user-provided path.
 * Accepts either the data dir itself or the zotero.sqlite file path.
 */
function resolveZoteroDir(userPath: string): string | null {
  if (!userPath) return null

  // If user gave the sqlite file directly
  if (userPath.endsWith('zotero.sqlite') && existsSync(userPath)) {
    return userPath.replace(/\/zotero\.sqlite$/, '')
  }

  // If user gave the data directory
  if (existsSync(join(userPath, 'zotero.sqlite'))) {
    return userPath
  }

  // Try common default locations
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const defaults = [
    join(home, 'Zotero'),
    join(home, '.zotero', 'zotero'),
    join(home, 'Library', 'Application Support', 'Zotero', 'Profiles'),
  ]

  for (const dir of defaults) {
    if (existsSync(join(dir, 'zotero.sqlite'))) {
      return dir
    }
  }

  return null
}

/**
 * Scan the Zotero storage directory for PDF files and extract metadata
 * from directory naming conventions.
 *
 * Zotero stores each attachment in storage/<8-char-key>/filename.pdf.
 * We scan these directories and collect PDFs.
 *
 * Note: Full metadata extraction requires SQLite access. This fallback
 * approach finds PDFs and extracts what it can from filenames.
 */
function scanZoteroStorage(zoteroDir: string): ZoteroPaper[] {
  const storageDir = join(zoteroDir, 'storage')
  if (!existsSync(storageDir)) return []

  const papers: ZoteroPaper[] = []
  const entries = readdirSync(storageDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const itemDir = join(storageDir, entry.name)
    try {
      const files = readdirSync(itemDir)
      for (const file of files) {
        if (extname(file).toLowerCase() !== '.pdf') continue

        // Extract title from filename (remove .pdf, replace underscores)
        const rawTitle = basename(file, '.pdf')
          .replace(/_/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()

        // Try to parse author-year-title pattern: "Author et al. - 2023 - Title.pdf"
        const authorYearMatch = rawTitle.match(
          /^(.+?)\s*-\s*(\d{4})\s*-\s*(.+)$/,
        )

        let title = rawTitle
        let authors: string[] = []
        let year = 0

        if (authorYearMatch) {
          authors = [authorYearMatch[1].trim()]
          year = parseInt(authorYearMatch[2], 10)
          title = authorYearMatch[3].trim()
        }

        papers.push({
          title,
          authors,
          year,
          pdf_path: join(itemDir, file),
        })
      }
    } catch {
      // Skip directories we can't read
    }
  }

  return papers
}

/**
 * Import papers from a Zotero library into the project's literature directory.
 *
 * @param zoteroPath - Path to Zotero data directory or zotero.sqlite file
 * @param outputDir - Project literature/papers/ directory
 * @returns Import results with counts and any errors
 */
export async function importFromZotero(
  zoteroPath: string,
  outputDir: string,
): Promise<ZoteroImportResult> {
  const errors: string[] = []

  const zoteroDir = resolveZoteroDir(zoteroPath)
  if (!zoteroDir) {
    return {
      imported: 0,
      skipped: 0,
      papers: [],
      errors: [
        `Could not find Zotero database at "${zoteroPath}". ` +
          'Please provide the path to your Zotero data directory (containing zotero.sqlite).',
      ],
    }
  }

  // Try SQLite-based extraction first (requires bun:sqlite)
  let papers: ZoteroPaper[] = []
  try {
    papers = await extractViaSQL(zoteroDir)
  } catch {
    // SQLite not available or failed — fall back to storage scan
    papers = scanZoteroStorage(zoteroDir)
    if (papers.length === 0) {
      errors.push(
        'SQLite extraction failed and no PDFs found in Zotero storage directory.',
      )
    }
  }

  if (papers.length === 0) {
    return { imported: 0, skipped: 0, papers: [], errors }
  }

  // Copy PDFs to output directory
  mkdirSync(outputDir, { recursive: true })
  let imported = 0
  let skipped = 0
  const importedPapers: ZoteroPaper[] = []

  for (const paper of papers) {
    if (!paper.pdf_path || !existsSync(paper.pdf_path)) {
      skipped++
      continue
    }

    const safeName = (paper.title || 'paper')
      .replace(/[^a-z0-9]/gi, '_')
      .slice(0, 60)
    const destPath = join(outputDir, `zotero_${safeName}.pdf`)

    if (existsSync(destPath)) {
      skipped++
      continue
    }

    try {
      copyFileSync(paper.pdf_path, destPath)
      importedPapers.push({ ...paper, pdf_path: destPath })
      imported++
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`Failed to copy "${paper.title}": ${msg}`)
      skipped++
    }
  }

  return { imported, skipped, papers: importedPapers, errors }
}

/**
 * Extract paper metadata via Zotero's SQLite database using Bun's built-in SQLite.
 */
async function extractViaSQL(zoteroDir: string): Promise<ZoteroPaper[]> {
  const dbPath = join(zoteroDir, 'zotero.sqlite')
  if (!existsSync(dbPath)) {
    throw new Error('zotero.sqlite not found')
  }

  // Use Bun's built-in SQLite support
  const { Database } = await import('bun:sqlite')
  const db = new Database(dbPath, { readonly: true })

  try {
    // Query items with their metadata
    const rows = db
      .query(
        `
      SELECT
        i.itemID,
        idv_title.value AS title,
        idv_date.value AS date,
        idv_doi.value AS doi
      FROM items i
      LEFT JOIN itemData id_title ON i.itemID = id_title.itemID
        AND id_title.fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'title')
      LEFT JOIN itemDataValues idv_title ON id_title.valueID = idv_title.valueID
      LEFT JOIN itemData id_date ON i.itemID = id_date.itemID
        AND id_date.fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'date')
      LEFT JOIN itemDataValues idv_date ON id_date.valueID = idv_date.valueID
      LEFT JOIN itemData id_doi ON i.itemID = id_doi.itemID
        AND id_doi.fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'DOI')
      LEFT JOIN itemDataValues idv_doi ON id_doi.valueID = idv_doi.valueID
      WHERE i.itemTypeID NOT IN (
        SELECT itemTypeID FROM itemTypes WHERE typeName IN ('attachment', 'note')
      )
        AND idv_title.value IS NOT NULL
      ORDER BY i.itemID
    `,
      )
      .all() as Array<{
      itemID: number
      title: string
      date: string | null
      doi: string | null
    }>

    const papers: ZoteroPaper[] = []

    for (const row of rows) {
      // Get authors
      const authorRows = db
        .query(
          `
        SELECT firstName, lastName
        FROM itemCreators ic
        JOIN creators c ON ic.creatorID = c.creatorID
        WHERE ic.itemID = ?
        ORDER BY ic.orderIndex
      `,
        )
        .all(row.itemID) as Array<{
        firstName: string | null
        lastName: string | null
      }>

      const authors = authorRows.map(a =>
        [a.firstName, a.lastName].filter(Boolean).join(' '),
      )

      // Get PDF attachment path
      const attachmentRows = db
        .query(
          `
        SELECT ia.path, ia.parentItemID
        FROM itemAttachments ia
        WHERE ia.parentItemID = ?
          AND ia.contentType = 'application/pdf'
        LIMIT 1
      `,
        )
        .all(row.itemID) as Array<{
        path: string | null
        parentItemID: number
      }>

      let pdfPath: string | undefined
      if (attachmentRows.length > 0 && attachmentRows[0].path) {
        const attachPath = attachmentRows[0].path
        // Zotero stores paths as "storage:filename.pdf" for linked files
        if (attachPath.startsWith('storage:')) {
          // Need to find the storage key for this attachment
          const keyRow = db
            .query(
              `SELECT key FROM items WHERE itemID = (
              SELECT itemID FROM itemAttachments WHERE parentItemID = ? AND contentType = 'application/pdf' LIMIT 1
            )`,
            )
            .get(row.itemID) as { key: string } | null
          if (keyRow) {
            const candidate = join(
              zoteroDir,
              'storage',
              keyRow.key,
              attachPath.replace('storage:', ''),
            )
            if (existsSync(candidate)) {
              pdfPath = candidate
            }
          }
        } else if (existsSync(attachPath)) {
          pdfPath = attachPath
        }
      }

      // Parse year from date
      let year = 0
      if (row.date) {
        const yearMatch = row.date.match(/(\d{4})/)
        if (yearMatch) year = parseInt(yearMatch[1], 10)
      }

      // Check for arXiv ID in extra field or DOI
      let arxivId: string | undefined
      if (row.doi && row.doi.includes('arxiv')) {
        const match = row.doi.match(/(\d{4}\.\d+)/)
        if (match) arxivId = match[1]
      }

      papers.push({
        title: row.title,
        authors,
        year,
        doi: row.doi || undefined,
        arxiv_id: arxivId,
        pdf_path: pdfPath,
      })
    }

    return papers
  } finally {
    db.close()
  }
}
