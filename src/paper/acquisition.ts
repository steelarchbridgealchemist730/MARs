import { mkdirSync } from 'fs'
import { join } from 'path'

export interface PaperMetadata {
  title: string
  doi?: string
  arxiv_id?: string
  s2_paper_id?: string
  ssrn_id?: string
  pdf_url?: string
  year?: number
}

export interface AcquisitionResult {
  success: boolean
  paper: PaperMetadata
  pdf_path?: string
  source_used?: string
  status: 'downloaded' | 'oa_found' | 'abstract_only' | 'failed'
  error?: string
}

export interface AcquisitionConfig {
  output_dir: string
  scihub_enabled?: boolean // default false - legal risk
  scihub_mirrors?: string[]
  unpaywall_email?: string // required for Unpaywall API
  ezproxy_url?: string // EZproxy base URL for institutional access
  timeout_ms?: number // default 30000
}

class ArxivSource {
  async download(
    paper: PaperMetadata,
    outputDir: string,
  ): Promise<AcquisitionResult | null> {
    if (!paper.arxiv_id) return null

    // Clean arxiv ID (remove version suffix for canonical URL)
    const cleanId = paper.arxiv_id.replace(/v\d+$/, '')
    const pdfUrl = `https://arxiv.org/pdf/${cleanId}.pdf`

    try {
      const response = await fetch(pdfUrl, {
        headers: { 'User-Agent': 'Claude-Paper/0.1 (research tool)' },
      })
      if (!response.ok) return null

      const buffer = await response.arrayBuffer()
      const bytes = new Uint8Array(buffer)

      // Validate PDF magic bytes
      if (
        bytes[0] !== 0x25 ||
        bytes[1] !== 0x50 ||
        bytes[2] !== 0x44 ||
        bytes[3] !== 0x46
      ) {
        return null
      }

      const filename = `arxiv_${cleanId.replace('/', '_')}.pdf`
      const outputPath = join(outputDir, filename)
      await Bun.write(outputPath, buffer)

      return {
        success: true,
        paper,
        pdf_path: outputPath,
        source_used: 'arxiv',
        status: 'downloaded',
      }
    } catch {
      return null
    }
  }
}

class UnpaywallSource {
  async download(
    paper: PaperMetadata,
    outputDir: string,
    email?: string,
  ): Promise<AcquisitionResult | null> {
    if (!paper.doi) return null

    const apiEmail = email || 'research@claude-paper.ai'
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(paper.doi)}?email=${apiEmail}`

    try {
      const response = await fetch(url)
      if (!response.ok) return null
      const data = (await response.json()) as any

      const oaUrl =
        data?.best_oa_location?.url_for_pdf || data?.best_oa_location?.url
      if (!oaUrl) return null

      const pdfResp = await fetch(oaUrl, {
        headers: { 'User-Agent': 'Claude-Paper/0.1' },
      })
      if (!pdfResp.ok) return null

      const buffer = await pdfResp.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      if (bytes[0] !== 0x25 || bytes[1] !== 0x50) return null

      const safeTitle = (paper.doi || paper.title || 'paper')
        .replace(/[^a-z0-9]/gi, '_')
        .slice(0, 50)
      const outputPath = join(outputDir, `unpaywall_${safeTitle}.pdf`)
      await Bun.write(outputPath, buffer)

      return {
        success: true,
        paper,
        pdf_path: outputPath,
        source_used: 'unpaywall',
        status: 'oa_found',
      }
    } catch {
      return null
    }
  }
}

class S2OASource {
  async download(
    paper: PaperMetadata,
    outputDir: string,
  ): Promise<AcquisitionResult | null> {
    if (!paper.s2_paper_id) return null

    try {
      const url = `https://api.semanticscholar.org/graph/v1/paper/${paper.s2_paper_id}?fields=openAccessPdf`
      const response = await fetch(url)
      if (!response.ok) return null
      const data = (await response.json()) as any

      const pdfUrl = data?.openAccessPdf?.url
      if (!pdfUrl) return null

      const pdfResp = await fetch(pdfUrl, {
        headers: { 'User-Agent': 'Claude-Paper/0.1' },
      })
      if (!pdfResp.ok) return null

      const buffer = await pdfResp.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      if (bytes[0] !== 0x25 || bytes[1] !== 0x50) return null

      const safeId = paper.s2_paper_id.replace(/[^a-z0-9]/gi, '_').slice(0, 40)
      const outputPath = join(outputDir, `s2_${safeId}.pdf`)
      await Bun.write(outputPath, buffer)

      return {
        success: true,
        paper,
        pdf_path: outputPath,
        source_used: 's2_oa',
        status: 'oa_found',
      }
    } catch {
      return null
    }
  }
}

class CORESource {
  async download(
    paper: PaperMetadata,
    outputDir: string,
  ): Promise<AcquisitionResult | null> {
    // CORE API: https://core.ac.uk/services/api
    // Free tier: 10 req/10s, no API key required for basic search
    // Only use CORE with DOI for reliable matching; title-only search is too slow/unreliable
    if (!paper.doi) return null

    try {
      const searchParam = paper.doi
        ? `doi:"${paper.doi}"`
        : encodeURIComponent(paper.title)
      const url = `https://api.core.ac.uk/v3/search/works?q=${searchParam}&limit=1`
      const headers: Record<string, string> = {
        'User-Agent': 'Claude-Paper/0.1 (research tool)',
      }
      const coreKey = process.env.CORE_API_KEY
      if (coreKey) {
        headers['Authorization'] = `Bearer ${coreKey}`
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (!response.ok) return null

      const data = (await response.json()) as any
      const results = data?.results
      if (!Array.isArray(results) || results.length === 0) return null

      const work = results[0]
      const downloadUrl = work?.downloadUrl || work?.sourceFulltextUrls?.[0]
      if (!downloadUrl) return null

      const pdfResp = await fetch(downloadUrl, {
        headers: { 'User-Agent': 'Claude-Paper/0.1' },
      })
      if (!pdfResp.ok) return null

      const buffer = await pdfResp.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      if (bytes[0] !== 0x25 || bytes[1] !== 0x50) return null

      const safeTitle = (paper.title || 'paper')
        .replace(/[^a-z0-9]/gi, '_')
        .slice(0, 50)
      const outputPath = join(outputDir, `core_${safeTitle}.pdf`)
      await Bun.write(outputPath, buffer)

      return {
        success: true,
        paper,
        pdf_path: outputPath,
        source_used: 'core',
        status: 'oa_found',
      }
    } catch {
      return null
    }
  }
}

class EZProxySource {
  private baseUrl: string

  constructor(baseUrl: string) {
    // Normalize: remove trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async download(
    paper: PaperMetadata,
    outputDir: string,
  ): Promise<AcquisitionResult | null> {
    if (!paper.doi) return null

    // EZproxy rewrites DOI-based URLs: https://doi-org.proxy.example.edu/10.xxx/yyy
    // Standard EZproxy pattern: replace "." in DOI host with "-" and append proxy suffix
    const proxyHost = this.baseUrl.replace(/^https?:\/\//, '')
    const proxiedUrl = `https://doi-org.${proxyHost}/${paper.doi}`

    try {
      const response = await fetch(proxiedUrl, {
        headers: { 'User-Agent': 'Claude-Paper/0.1 (institutional access)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return null

      // Follow redirect to actual PDF — many publishers redirect from DOI
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('pdf')) {
        // Try to find PDF link in HTML response
        const html = await response.text()
        const pdfLink = html.match(/href="([^"]*\.pdf[^"]*)"/i)
        if (!pdfLink) return null

        let pdfUrl = pdfLink[1]
        if (pdfUrl.startsWith('/')) {
          pdfUrl = `https://${proxyHost}${pdfUrl}`
        }

        const pdfResp = await fetch(pdfUrl, {
          headers: { 'User-Agent': 'Claude-Paper/0.1' },
          signal: AbortSignal.timeout(15000),
        })
        if (!pdfResp.ok) return null

        const buffer = await pdfResp.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        if (bytes[0] !== 0x25 || bytes[1] !== 0x50) return null

        const safeDoi = paper.doi.replace(/[^a-z0-9]/gi, '_').slice(0, 50)
        const outputPath = join(outputDir, `ezproxy_${safeDoi}.pdf`)
        await Bun.write(outputPath, buffer)

        return {
          success: true,
          paper,
          pdf_path: outputPath,
          source_used: 'ezproxy',
          status: 'downloaded',
        }
      }

      // Direct PDF response
      const buffer = await response.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      if (bytes[0] !== 0x25 || bytes[1] !== 0x50) return null

      const safeDoi = paper.doi.replace(/[^a-z0-9]/gi, '_').slice(0, 50)
      const outputPath = join(outputDir, `ezproxy_${safeDoi}.pdf`)
      await Bun.write(outputPath, buffer)

      return {
        success: true,
        paper,
        pdf_path: outputPath,
        source_used: 'ezproxy',
        status: 'downloaded',
      }
    } catch {
      return null
    }
  }
}

// LEGAL WARNING: Sci-Hub access may violate publisher terms of service and copyright law.
// This source is DISABLED by default. Users must explicitly opt-in and accept legal responsibility.
// Claude Paper does NOT endorse or encourage use of Sci-Hub.
class ScihubSource {
  private mirrors: string[]

  constructor(mirrors: string[]) {
    this.mirrors = mirrors
  }

  async download(
    paper: PaperMetadata,
    outputDir: string,
  ): Promise<AcquisitionResult | null> {
    const identifier = paper.doi || paper.arxiv_id
    if (!identifier) return null

    for (const mirror of this.mirrors) {
      try {
        const url = `${mirror}/${identifier}`
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        })
        if (!response.ok) continue

        const html = await response.text()
        const pdfMatch = html.match(/embed[^>]+src="([^"]+\.pdf[^"]*)"/)
        if (!pdfMatch) continue

        let pdfUrl = pdfMatch[1]
        if (pdfUrl.startsWith('//')) pdfUrl = 'https:' + pdfUrl

        const pdfResp = await fetch(pdfUrl)
        if (!pdfResp.ok) continue

        const buffer = await pdfResp.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        if (bytes[0] !== 0x25 || bytes[1] !== 0x50) continue

        const safeId = identifier.replace(/[^a-z0-9]/gi, '_').slice(0, 50)
        const outputPath = join(outputDir, `scihub_${safeId}.pdf`)
        await Bun.write(outputPath, buffer)

        return {
          success: true,
          paper,
          pdf_path: outputPath,
          source_used: 'scihub',
          status: 'downloaded',
        }
      } catch {
        continue
      }
    }
    return null
  }
}

export class PaperAcquisitionChain {
  private config: AcquisitionConfig
  private arxiv = new ArxivSource()
  private unpaywall = new UnpaywallSource()
  private s2oa = new S2OASource()
  private core = new CORESource()
  private ezproxy?: EZProxySource
  private scihub?: ScihubSource

  constructor(config: AcquisitionConfig) {
    this.config = config
    mkdirSync(config.output_dir, { recursive: true })

    if (config.ezproxy_url) {
      this.ezproxy = new EZProxySource(config.ezproxy_url)
    }

    if (config.scihub_enabled) {
      const mirrors = config.scihub_mirrors || [
        'https://sci-hub.se',
        'https://sci-hub.st',
        'https://sci-hub.ru',
      ]
      this.scihub = new ScihubSource(mirrors)
    }
  }

  async acquire(paper: PaperMetadata): Promise<AcquisitionResult> {
    const outputDir = this.config.output_dir

    // 1. Try arXiv first (free, fast)
    const arxivResult = await this.arxiv.download(paper, outputDir)
    if (arxivResult) return arxivResult

    // 2. Try Unpaywall (if DOI available)
    const unpaywallResult = await this.unpaywall.download(
      paper,
      outputDir,
      this.config.unpaywall_email,
    )
    if (unpaywallResult) return unpaywallResult

    // 3. Try Semantic Scholar OA
    const s2Result = await this.s2oa.download(paper, outputDir)
    if (s2Result) return s2Result

    // 4. Try CORE (core.ac.uk open access aggregator)
    const coreResult = await this.core.download(paper, outputDir)
    if (coreResult) return coreResult

    // 5. Try EZproxy institutional access (if configured)
    if (this.ezproxy) {
      const ezproxyResult = await this.ezproxy.download(paper, outputDir)
      if (ezproxyResult) return ezproxyResult
    }

    // 6. Try Sci-Hub (only if enabled by user)
    // WARNING: Legal risk. User opted in.
    if (this.scihub) {
      const scihubResult = await this.scihub.download(paper, outputDir)
      if (scihubResult) return scihubResult
    }

    // 7. Fallback: abstract only
    return {
      success: false,
      paper,
      status: 'abstract_only',
      error: 'Could not obtain full text. Will use abstract only.',
    }
  }

  async acquireBatch(
    papers: PaperMetadata[],
    onProgress?: (done: number, total: number, paper: string) => void,
  ): Promise<AcquisitionResult[]> {
    const results: AcquisitionResult[] = []
    const concurrency = 5 // download 5 at a time

    for (let i = 0; i < papers.length; i += concurrency) {
      const batch = papers.slice(i, i + concurrency)
      const batchResults = await Promise.all(batch.map(p => this.acquire(p)))
      results.push(...batchResults)
      onProgress?.(
        results.length,
        papers.length,
        batch[batch.length - 1]?.title || '',
      )
    }

    return results
  }
}
