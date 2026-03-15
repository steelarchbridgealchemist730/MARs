import React, { useState } from 'react'
import { Box, Newline, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import { PAPER_ASCII_LOGO } from '@constants/product'

type Props = { onDone(): void }

// ── Types ────────────────────────────────────────────────────────

interface LatexToolStatus {
  name: string
  available: boolean | null
}

interface ComputeInfo {
  os_name: string
  cpu: string
  cores: number
  ram_gb: number
  available_ram_gb: number
  disk_free_gb: number
  gpu: string
  python: string
  uv: boolean
  docker: boolean
}

interface AdvancedModelConfig {
  api_key?: string
  base_url?: string
  max_output_tokens?: number
  thinking_effort?: 'low' | 'medium' | 'high' | 'max'
  context_window?: number
  temperature?: number
}

interface WizardConfig {
  api_keys: { anthropic: string; openai: string; semantic_scholar: string }
  models: Record<string, string>
  advanced_models?: Record<string, AdvancedModelConfig>
  paper: { template: string; language: string }
  proposals: { count: number }
  review: { num_reviewers: number; max_rounds: number; threshold: number }
  access: {
    arxiv: boolean
    semantic_scholar: boolean
    unpaywall: boolean
    core: boolean
    scihub: boolean
    scihub_accepted: boolean
    ezproxy_url: string
    shibboleth: boolean
    zotero_path: string
    pdf_folder: string
  }
  auto_mode: boolean
}

// ── Helpers ──────────────────────────────────────────────────────

const CONFIG_DIR = `${os.homedir()}/.claude-paper`
const CONFIG_PATH = `${CONFIG_DIR}/config.json`
const ACCESS_PATH = `${CONFIG_DIR}/access.json`

import { TemplateResolver } from '../../paper/writing/template-resolver'

const _resolver = new TemplateResolver()
const TEMPLATES = _resolver.listTemplates().map(t => t.id)
const LANGUAGES = ['english', 'chinese']

function defaultConfig(): WizardConfig {
  return {
    api_keys: { anthropic: '', openai: '', semantic_scholar: '' },
    models: {
      research: 'anthropic:claude-opus-4-6',
      reasoning: 'openai:gpt-5.4',
      reasoning_deep: 'openai:gpt-5.4-pro',
      coding: 'anthropic:claude-opus-4-6',
      writing: 'anthropic:claude-opus-4-6',
      review: 'openai:gpt-5.4',
      quick: 'anthropic:claude-haiku-4-5-20251001',
    },
    paper: { template: 'neurips', language: 'english' },
    proposals: { count: 3 },
    review: { num_reviewers: 3, max_rounds: 3, threshold: 7.0 },
    access: {
      arxiv: true,
      semantic_scholar: true,
      unpaywall: true,
      core: true,
      scihub: false,
      scihub_accepted: false,
      ezproxy_url: '',
      shibboleth: false,
      zotero_path: '',
      pdf_folder: '',
    },
    auto_mode: false,
  }
}

async function saveWizardConfig(cfg: WizardConfig): Promise<void> {
  // Save paper-specific config (without access — that goes to access.json)
  mkdirSync(CONFIG_DIR, { recursive: true })
  let existing: Record<string, any> = {}
  try {
    if (existsSync(CONFIG_PATH))
      existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    /* ignore */
  }
  const { access, ...configWithoutAccess } = cfg
  const merged = { ...existing, ...configWithoutAccess }
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8')

  // Save access config separately to ~/.claude-paper/access.json
  writeFileSync(ACCESS_PATH, JSON.stringify(access, null, 2) + '\n', 'utf-8')

  // Set env vars for current session
  if (cfg.api_keys.anthropic)
    process.env.ANTHROPIC_API_KEY = cfg.api_keys.anthropic
  if (cfg.api_keys.openai) process.env.OPENAI_API_KEY = cfg.api_keys.openai
  if (cfg.api_keys.semantic_scholar)
    process.env.S2_API_KEY = cfg.api_keys.semantic_scholar

  // Also register model profile in Claude Paper's global config so /deep-research etc work
  try {
    const { getGlobalConfig, saveGlobalConfig } = await import('@utils/config')
    const globalConfig = getGlobalConfig()

    const anthropicKey =
      cfg.api_keys.anthropic || process.env.ANTHROPIC_API_KEY || ''
    if (anthropicKey) {
      const modelName = 'claude-sonnet-4-6'
      const profileName = 'Claude Sonnet 4.6'
      const existingProfiles = globalConfig.modelProfiles ?? []
      const alreadyExists = existingProfiles.some(
        (p: any) => p.modelName === modelName,
      )
      if (!alreadyExists) {
        const newProfile = {
          name: profileName,
          provider: 'anthropic',
          modelName,
          apiKey: anthropicKey,
          maxTokens: 16384,
          contextLength: 200000,
          reasoningEffort: 'high',
          isActive: true,
          createdAt: Date.now(),
        }
        existingProfiles.push(newProfile)
      }

      saveGlobalConfig({
        ...globalConfig,
        modelProfiles: existingProfiles,
        modelPointers: {
          main: modelName,
          task: modelName,
          compact: modelName,
          quick: modelName,
          ...(globalConfig.modelPointers ?? {}),
        },
      })
    }
  } catch {
    // If config utils fail, still save paper config
  }
}

async function checkTool(name: string): Promise<boolean> {
  try {
    const p = Bun.spawn(['which', name], { stdout: 'pipe', stderr: 'pipe' })
    return (await p.exited) === 0
  } catch {
    return false
  }
}

async function runCmd(cmd: string): Promise<string> {
  try {
    const p = Bun.spawn(cmd.split(' '), { stdout: 'pipe', stderr: 'pipe' })
    return (await new Response(p.stdout).text()).trim()
  } catch {
    return ''
  }
}

async function probeCompute(): Promise<ComputeInfo> {
  const mac = process.platform === 'darwin'
  const [osN, cpuM, cpuC, memS, vmS, freeR, dfR, nv, py, uv, dk] =
    await Promise.all([
      runCmd('uname -s'),
      runCmd('sysctl -n machdep.cpu.brand_string'),
      runCmd('sysctl -n hw.physicalcpu'),
      runCmd('sysctl -n hw.memsize'),
      runCmd('vm_stat'),
      runCmd('free -b'),
      runCmd('df -k /'),
      runCmd(
        'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
      ),
      runCmd('python3 --version'),
      runCmd('uv --version'),
      runCmd('docker --version'),
    ])
  let cpu = mac ? cpuM || 'Apple Silicon' : 'unknown'
  let cores = mac ? parseInt(cpuC, 10) || 0 : 0
  let totalRam = 0
  let availRam = 0
  if (mac) {
    totalRam = parseInt(memS, 10) || 0
    const pF = vmS.match(/Pages free:\s+(\d+)/)
    const pI = vmS.match(/Pages inactive:\s+(\d+)/)
    availRam =
      ((parseInt(pF?.[1] ?? '0', 10) || 0) +
        (parseInt(pI?.[1] ?? '0', 10) || 0)) *
      16384
  } else {
    const m = freeR.split('\n').find(l => l.startsWith('Mem:'))
    if (m) {
      const c = m.trim().split(/\s+/)
      totalRam = parseInt(c[1], 10) || 0
      availRam = parseInt(c[6] ?? c[3], 10) || 0
    }
  }
  let diskFree = 0
  for (const l of dfR.split('\n').slice(1)) {
    if (!l.trim()) continue
    const c = l.trim().split(/\s+/)
    if (c.length >= 4) diskFree = (parseInt(c[3], 10) || 0) / 1e6
  }
  return {
    os_name: osN || process.platform,
    cpu,
    cores,
    ram_gb: +(totalRam / 1e9).toFixed(1),
    available_ram_gb: +(availRam / 1e9).toFixed(1),
    disk_free_gb: +diskFree.toFixed(1),
    gpu: nv ? (nv.split('\n')[0]?.trim() ?? 'none') : 'none',
    python: py.replace('Python ', '') || 'not found',
    uv: uv.length > 0,
    docker: dk.length > 0,
  }
}

// ── Step 0: Welcome ──────────────────────────────────────────────

function WelcomeStep(): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text color="cyan">{PAPER_ASCII_LOGO}</Text>
      <Text bold>End-to-end Autonomous Research System v0.1.0</Text>
      <Text>Let&apos;s set up your research environment.</Text>
      <Newline />
      <Text dimColor>Press Enter to continue</Text>
    </Box>
  )
}

// ── Step 1: LLM Provider Config ──────────────────────────────────

const MODEL_ROLES = [
  { key: 'research', icon: '🔬', label: 'Research' },
  { key: 'reasoning', icon: '🧮', label: 'Reasoning' },
  { key: 'coding', icon: '💻', label: 'Coding' },
  { key: 'writing', icon: '✍️', label: 'Writing' },
  { key: 'review', icon: '📝', label: 'Review' },
  { key: 'quick', icon: '⚡', label: 'Quick' },
]

function ModelConfigStep({
  cfg,
  apiKey,
  onApiKeyChange,
  openaiKey,
  onOpenaiKeyChange,
  activeField,
  advancedMode,
  advancedCursor,
  advancedRole,
  advancedEditing,
  advancedValue,
  onAdvancedValueChange,
}: {
  cfg: WizardConfig
  apiKey: string
  onApiKeyChange: (v: string) => void
  openaiKey: string
  onOpenaiKeyChange: (v: string) => void
  activeField: 'anthropic' | 'openai' | 'none'
  advancedMode: boolean
  advancedCursor: number
  advancedRole: string
  advancedEditing: boolean
  advancedValue: string
  onAdvancedValueChange: (v: string) => void
}): React.ReactNode {
  const envAnth = process.env.ANTHROPIC_API_KEY ?? ''
  const envOai = process.env.OPENAI_API_KEY ?? ''
  const effectiveAnth = apiKey || envAnth
  const effectiveOai = openaiKey || envOai

  if (advancedMode) {
    const adv = cfg.advanced_models?.[advancedRole] ?? {}
    const ADVANCED_FIELDS = [
      {
        label: 'API Key Override',
        key: 'api_key',
        value: adv.api_key ? '****' + adv.api_key.slice(-4) : '(default)',
      },
      {
        label: 'Base URL',
        key: 'base_url',
        value: adv.base_url || '(default)',
      },
      {
        label: 'Max Output Tokens',
        key: 'max_output_tokens',
        value: String(adv.max_output_tokens ?? '(default)'),
      },
      {
        label: 'Thinking Effort',
        key: 'thinking_effort',
        value: adv.thinking_effort ?? '(default)',
      },
      {
        label: 'Context Window',
        key: 'context_window',
        value: String(adv.context_window ?? '(default)'),
      },
      {
        label: 'Temperature',
        key: 'temperature',
        value: String(adv.temperature ?? '(default)'),
      },
    ]
    const roleLabel =
      MODEL_ROLES.find(r => r.key === advancedRole)?.label ?? advancedRole

    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>
          Step 1/6: Advanced Config — {roleLabel} ({cfg.models[advancedRole]})
        </Text>
        <Box flexDirection="column">
          {ADVANCED_FIELDS.map((f, i) => (
            <Box key={f.key}>
              <Box width={2}>
                <Text>{advancedCursor === i ? '>' : ' '}</Text>
              </Box>
              <Box width={22}>
                <Text dimColor>{f.label}:</Text>
              </Box>
              {advancedEditing && advancedCursor === i ? (
                <TextInput
                  value={advancedValue}
                  onChange={onAdvancedValueChange}
                  placeholder={f.value}
                />
              ) : (
                <Text
                  bold={advancedCursor === i}
                  color={advancedCursor === i ? 'cyan' : undefined}
                >
                  {f.value}
                </Text>
              )}
            </Box>
          ))}
        </Box>
        <Text dimColor>
          Up/Down: navigate | Enter: edit/save | Left/Right: switch role | Esc:
          back
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Step 1/6: Configure AI Models</Text>

      {/* API Keys */}
      <Box flexDirection="column">
        <Box>
          <Box width={22}>
            <Text
              bold={activeField === 'anthropic'}
              color={activeField === 'anthropic' ? 'cyan' : undefined}
            >
              Anthropic API Key:
            </Text>
          </Box>
          {envAnth && !apiKey ? (
            <Text color="green">[from env ✓]</Text>
          ) : activeField === 'anthropic' ? (
            <TextInput
              value={apiKey}
              onChange={onApiKeyChange}
              mask="*"
              placeholder="sk-ant-..."
            />
          ) : (
            <Text>
              {effectiveAnth ? (
                '****' + effectiveAnth.slice(-4)
              ) : (
                <Text color="red">(required)</Text>
              )}
            </Text>
          )}
        </Box>
        <Box>
          <Box width={22}>
            <Text
              bold={activeField === 'openai'}
              color={activeField === 'openai' ? 'cyan' : undefined}
            >
              OpenAI API Key:
            </Text>
          </Box>
          {envOai && !openaiKey ? (
            <Text color="green">[from env ✓]</Text>
          ) : activeField === 'openai' ? (
            <TextInput
              value={openaiKey}
              onChange={onOpenaiKeyChange}
              mask="*"
              placeholder="sk-... (optional)"
            />
          ) : (
            <Text dimColor>
              {effectiveOai ? '****' + effectiveOai.slice(-4) : '(optional)'}
            </Text>
          )}
        </Box>
      </Box>

      {/* Model Table */}
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Box width={4}>
            <Text> </Text>
          </Box>
          <Box width={14}>
            <Text bold underline>
              Role
            </Text>
          </Box>
          <Box width={34}>
            <Text bold underline>
              Default Model
            </Text>
          </Box>
        </Box>
        {MODEL_ROLES.map(r => (
          <Box key={r.key}>
            <Box width={4}>
              <Text>{r.icon}</Text>
            </Box>
            <Box width={14}>
              <Text>{r.label}</Text>
            </Box>
            <Box width={34}>
              <Text color="green">{cfg.models[r.key]}</Text>
            </Box>
          </Box>
        ))}
      </Box>

      <Text dimColor>
        Tab: switch key field | a: advanced config | Enter: continue | Esc: back
      </Text>
    </Box>
  )
}

// ── Step 2: Academic Access ──────────────────────────────────────

function AcademicAccessStep({
  cfg,
  onToggleScihub,
  s2Key,
  onS2KeyChange,
  s2Active,
  ezproxyUrl,
  onEzproxyChange,
  ezproxyActive,
  pdfFolder,
  onPdfFolderChange,
  pdfFolderActive,
}: {
  cfg: WizardConfig
  onToggleScihub: () => void
  s2Key: string
  onS2KeyChange: (v: string) => void
  s2Active: boolean
  ezproxyUrl: string
  onEzproxyChange: (v: string) => void
  ezproxyActive: boolean
  pdfFolder: string
  onPdfFolderChange: (v: string) => void
  pdfFolderActive: boolean
}): React.ReactNode {
  const envS2 = process.env.S2_API_KEY ?? ''

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Step 2/6: Academic Paper Access</Text>
      <Text>Claude Paper needs to find and read research papers.</Text>

      <Box flexDirection="column" marginTop={1}>
        <Text bold> Free &amp; Open Access</Text>
        <Text color="green"> ✅ arXiv API (always available, no key)</Text>
        <Text color="green">
          {' '}
          ✅ Semantic Scholar (free tier: 100 req/5min)
        </Text>
        <Box>
          <Text> {'  '}S2 API Key: </Text>
          {envS2 ? (
            <Text color="green">[from S2_API_KEY env ✓]</Text>
          ) : s2Active ? (
            <TextInput
              value={s2Key}
              onChange={onS2KeyChange}
              mask="*"
              placeholder="(optional, for 1000 req/5min)"
            />
          ) : (
            <Text dimColor>
              {s2Key ? '****' + s2Key.slice(-4) : '(optional)'}
            </Text>
          )}
        </Box>
        <Text color="green"> ✅ Unpaywall (free OA PDF discovery)</Text>
        <Text color="green"> ✅ CORE API (open access aggregator)</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold> Institutional Access</Text>
        <Box>
          <Text> {cfg.access.ezproxy_url ? '✅' : '⬜'} EZproxy URL: </Text>
          {ezproxyActive ? (
            <TextInput
              value={ezproxyUrl}
              onChange={onEzproxyChange}
              placeholder="https://proxy.university.edu/login?url="
            />
          ) : (
            <Text dimColor>
              {cfg.access.ezproxy_url || "(press 'p' to configure)"}
            </Text>
          )}
        </Box>
        <Box>
          <Text>
            {' '}
            {cfg.access.shibboleth ? '✅' : '⬜'} OpenAthens/Shibboleth SSO{' '}
          </Text>
          <Text dimColor>(press &apos;h&apos; to toggle)</Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold> Alternative Sources (use at your own legal risk)</Text>
        <Text color="yellow">
          {' '}
          ⚠️ These sources may violate publisher terms.
        </Text>
        <Text color="yellow"> ⚠️ Claude Paper does NOT endorse piracy.</Text>
        <Text color="yellow"> ⚠️ YOU assume all legal responsibility.</Text>
        <Box>
          <Text> {cfg.access.scihub ? '✅' : '⬜'} Sci-Hub mirrors </Text>
          <Text dimColor>(press &apos;s&apos; to toggle)</Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold> Local Papers</Text>
        <Box>
          <Text> ⬜ Import PDF folder: </Text>
          {pdfFolderActive ? (
            <TextInput
              value={pdfFolder}
              onChange={onPdfFolderChange}
              placeholder="/path/to/pdf/folder"
            />
          ) : (
            <Text dimColor>
              {cfg.access.pdf_folder || "(press 'f' to set path)"}
            </Text>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Tab: toggle S2 key | s: Sci-Hub | p: EZproxy | h: Shibboleth | f: PDF
          folder | Enter: continue
        </Text>
      </Box>
    </Box>
  )
}

// ── Step 3: LaTeX ────────────────────────────────────────────────

function LatexStep({
  tools,
  checking,
}: {
  tools: LatexToolStatus[]
  checking: boolean
}): React.ReactNode {
  const missing = tools.filter(t => t.available === false).map(t => t.name)
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Step 3/6: LaTeX Environment</Text>
      {checking ? (
        <Text>Checking your LaTeX installation...</Text>
      ) : (
        <Box flexDirection="column">
          {tools.map(t => (
            <Box key={t.name}>
              <Text>
                {' '}
                {t.available === null ? '...' : t.available ? '✅' : '❌'}{' '}
                {t.name}
              </Text>
            </Box>
          ))}
          {missing.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="yellow"> Missing: {missing.join(', ')}</Text>
              {process.platform === 'linux' && (
                <Text dimColor> To install: sudo apt install texlive-full</Text>
              )}
              {process.platform === 'darwin' && (
                <Text dimColor> To install: brew install --cask mactex</Text>
              )}
            </Box>
          )}
        </Box>
      )}
      <Text dimColor>Press Enter to continue</Text>
    </Box>
  )
}

// ── Step 4: Compute Resources ────────────────────────────────────

function ComputeStep({
  info,
  loading,
}: {
  info: ComputeInfo | null
  loading: boolean
}): React.ReactNode {
  if (loading || !info)
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Step 4/6: Compute Resources</Text>
        <Text>Detecting your system capabilities...</Text>
      </Box>
    )
  const P = ({ l, v }: { l: string; v: string }) => (
    <Box>
      <Box width={22}>
        <Text dimColor> {l}</Text>
      </Box>
      <Text>{v}</Text>
    </Box>
  )
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Step 4/6: Compute Resources</Text>
      <Box flexDirection="column">
        <P l="OS:" v={info.os_name} />
        <P l="CPU:" v={`${info.cpu} (${info.cores} cores)`} />
        <P
          l="RAM:"
          v={`${info.ram_gb} GB total, ${info.available_ram_gb} GB available`}
        />
        <P l="Disk free:" v={`${info.disk_free_gb} GB`} />
        <P l="GPU:" v={info.gpu} />
        <P l="Python:" v={info.python} />
        <P l="uv:" v={info.uv ? 'available' : 'not found'} />
        <P l="Docker:" v={info.docker ? 'available' : 'not found'} />
      </Box>
      <Text dimColor>
        These will be used to estimate experiment feasibility.
      </Text>
      <Text dimColor>You can re-detect anytime with: /system-check</Text>
      <Text dimColor>Press Enter to continue</Text>
    </Box>
  )
}

// ── Step 5: Default Settings ─────────────────────────────────────

function SettingsStep({
  cfg,
  cursor,
}: {
  cfg: WizardConfig
  cursor: number
}): React.ReactNode {
  const items = [
    {
      label: 'Default template',
      value: cfg.paper.template,
      options: TEMPLATES,
    },
    {
      label: 'Default language',
      value: cfg.paper.language,
      options: LANGUAGES,
    },
    { label: 'Proposals per run', value: String(cfg.proposals.count) },
    { label: 'Number of reviewers', value: String(cfg.review.num_reviewers) },
    { label: 'Max review rounds', value: String(cfg.review.max_rounds) },
    { label: 'Acceptance threshold', value: `${cfg.review.threshold}/10` },
    { label: 'Full-auto mode', value: cfg.auto_mode ? 'yes' : 'no' },
  ]
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Step 5/6: Default Research Settings</Text>
      <Box flexDirection="column">
        {items.map((item, i) => (
          <Box key={item.label}>
            <Box width={2}>
              <Text>{cursor === i ? '>' : ' '}</Text>
            </Box>
            <Box width={26}>
              <Text dimColor>{item.label}:</Text>
            </Box>
            <Text bold={cursor === i} color={cursor === i ? 'cyan' : undefined}>
              {item.value}
            </Text>
            {cursor === i && item.options && (
              <Text dimColor> (Left/Right to change)</Text>
            )}
          </Box>
        ))}
      </Box>
      <Text dimColor>
        Up/Down: navigate | Left/Right: change value | Enter: accept all
      </Text>
    </Box>
  )
}

// ── Step 6: Complete ─────────────────────────────────────────────

function CompleteStep(): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold color="green">
        Step 6/6: Setup Complete! 🎓
      </Text>
      <Text>
        Configuration saved to: <Text color="cyan">{CONFIG_PATH}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Quick start:</Text>
        <Text color="yellow">
          {' '}
          cpaper init &quot;Your research topic&quot; # Start a new project
        </Text>
        <Text color="yellow"> cpaper # Enter interactive mode</Text>
        <Text color="yellow"> cpaper --help # See all commands</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Key commands inside interactive mode:</Text>
        <Text color="yellow">
          {' '}
          /deep-research {'<topic>'} Deep literature research
        </Text>
        <Text color="yellow"> /propose Generate research proposals</Text>
        <Text color="yellow"> /experiment Run experiments</Text>
        <Text color="yellow"> /write Write paper</Text>
        <Text color="yellow"> /review Run peer review</Text>
        <Text color="yellow"> /status Show project progress</Text>
        <Text color="yellow"> /settings Modify settings</Text>
      </Box>
      <Newline />
      <Text dimColor>Press Enter to start</Text>
    </Box>
  )
}

// ── Main Component ──────────────────────────────────────────────

const LATEX_TOOLS = ['pdflatex', 'xelatex', 'lualatex', 'bibtex', 'latexmk']

export function PaperOnboarding({ onDone }: Props): React.ReactNode {
  const [step, setStep] = useState(0)
  const [cfg, setCfg] = useState<WizardConfig>(defaultConfig())

  // Step 1 state
  const [apiKey, setApiKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [keyField, setKeyField] = useState<'anthropic' | 'openai'>('anthropic')
  const [apiFieldActive, setApiFieldActive] = useState(true)

  // Step 1 advanced state
  const [advancedMode, setAdvancedMode] = useState(false)
  const [advancedCursor, setAdvancedCursor] = useState(0)
  const [advancedRoleIdx, setAdvancedRoleIdx] = useState(0)
  const [advancedEditing, setAdvancedEditing] = useState(false)
  const [advancedValue, setAdvancedValue] = useState('')

  // Step 2 state
  const [s2Key, setS2Key] = useState('')
  const [s2Active, setS2Active] = useState(false)
  const [ezproxyUrl, setEzproxyUrl] = useState('')
  const [ezproxyActive, setEzproxyActive] = useState(false)
  const [pdfFolder, setPdfFolder] = useState('')
  const [pdfFolderActive, setPdfFolderActive] = useState(false)

  // Step 3 state
  const [latexTools, setLatexTools] = useState<LatexToolStatus[]>(
    LATEX_TOOLS.map(name => ({ name, available: null })),
  )
  const [latexChecking, setLatexChecking] = useState(false)
  const [latexChecked, setLatexChecked] = useState(false)

  // Step 4 state
  const [computeInfo, setComputeInfo] = useState<ComputeInfo | null>(null)
  const [computeLoading, setComputeLoading] = useState(false)

  // Step 5 state
  const [settingsCursor, setSettingsCursor] = useState(0)

  const hasTextInput =
    (step === 1 && !advancedMode && apiFieldActive && keyField !== 'none') ||
    (step === 1 && advancedMode && advancedEditing) ||
    (step === 2 && (s2Active || ezproxyActive || pdfFolderActive))

  async function runLatexCheck() {
    setLatexChecking(true)
    const r = await Promise.all(
      LATEX_TOOLS.map(async n => ({ name: n, available: await checkTool(n) })),
    )
    setLatexTools(r)
    setLatexChecking(false)
    setLatexChecked(true)
  }

  async function runComputeProbe() {
    setComputeLoading(true)
    try {
      setComputeInfo(await probeCompute())
    } catch {
      setComputeInfo({
        os_name: process.platform,
        cpu: 'unknown',
        cores: 0,
        ram_gb: 0,
        available_ram_gb: 0,
        disk_free_gb: 0,
        gpu: 'unknown',
        python: 'unknown',
        uv: false,
        docker: false,
      })
    }
    setComputeLoading(false)
  }

  // Step 5 setting changes
  function changeSetting(direction: number) {
    const c = { ...cfg }
    switch (settingsCursor) {
      case 0: {
        // template
        const idx = TEMPLATES.indexOf(c.paper.template)
        c.paper = {
          ...c.paper,
          template:
            TEMPLATES[(idx + direction + TEMPLATES.length) % TEMPLATES.length],
        }
        break
      }
      case 1: {
        // language
        const idx = LANGUAGES.indexOf(c.paper.language)
        c.paper = {
          ...c.paper,
          language:
            LANGUAGES[(idx + direction + LANGUAGES.length) % LANGUAGES.length],
        }
        break
      }
      case 2:
        c.proposals = {
          ...c.proposals,
          count: Math.max(1, Math.min(10, c.proposals.count + direction)),
        }
        break
      case 3:
        c.review = {
          ...c.review,
          num_reviewers: Math.max(
            1,
            Math.min(5, c.review.num_reviewers + direction),
          ),
        }
        break
      case 4:
        c.review = {
          ...c.review,
          max_rounds: Math.max(1, Math.min(5, c.review.max_rounds + direction)),
        }
        break
      case 5:
        c.review = {
          ...c.review,
          threshold: Math.max(
            1,
            Math.min(10, +(c.review.threshold + direction * 0.5).toFixed(1)),
          ),
        }
        break
      case 6:
        c.auto_mode = !c.auto_mode
        break
    }
    setCfg(c)
  }

  useInput(
    async (input, key) => {
      // Step 1: 'a' toggles advanced mode
      if (step === 1 && !advancedMode && input === 'a') {
        setAdvancedMode(true)
        setAdvancedCursor(0)
        setAdvancedRoleIdx(0)
        return
      }
      // Step 1 advanced: navigation
      if (step === 1 && advancedMode) {
        if (key.escape) {
          setAdvancedMode(false)
          setAdvancedEditing(false)
          return
        }
        if (key.upArrow) {
          setAdvancedCursor(c => Math.max(0, c - 1))
          return
        }
        if (key.downArrow) {
          setAdvancedCursor(c => Math.min(5, c + 1))
          return
        }
        if (key.leftArrow) {
          setAdvancedRoleIdx(
            i => (i - 1 + MODEL_ROLES.length) % MODEL_ROLES.length,
          )
          return
        }
        if (key.rightArrow) {
          setAdvancedRoleIdx(i => (i + 1) % MODEL_ROLES.length)
          return
        }
        if (key.return && !advancedEditing) {
          setAdvancedEditing(true)
          const role = MODEL_ROLES[advancedRoleIdx].key
          const adv = cfg.advanced_models?.[role] ?? {}
          const keys = [
            'api_key',
            'base_url',
            'max_output_tokens',
            'thinking_effort',
            'context_window',
            'temperature',
          ]
          const k = keys[advancedCursor] as keyof AdvancedModelConfig
          setAdvancedValue(adv[k] != null ? String(adv[k]) : '')
          return
        }
        if (key.return && advancedEditing) {
          // Save the advanced value
          const role = MODEL_ROLES[advancedRoleIdx].key
          const keys = [
            'api_key',
            'base_url',
            'max_output_tokens',
            'thinking_effort',
            'context_window',
            'temperature',
          ]
          const k = keys[advancedCursor]
          setCfg(prev => {
            const existing = prev.advanced_models?.[role] ?? {}
            let val: any = advancedValue
            if (k === 'max_output_tokens' || k === 'context_window')
              val = parseInt(advancedValue, 10) || undefined
            if (k === 'temperature')
              val = parseFloat(advancedValue) || undefined
            if (!advancedValue) val = undefined
            return {
              ...prev,
              advanced_models: {
                ...(prev.advanced_models ?? {}),
                [role]: { ...existing, [k]: val },
              },
            }
          })
          setAdvancedEditing(false)
          setAdvancedValue('')
          return
        }
        return
      }
      // Step 2: toggle Sci-Hub with 's'
      if (step === 2 && input === 's') {
        setCfg(prev => ({
          ...prev,
          access: {
            ...prev.access,
            scihub: !prev.access.scihub,
            scihub_accepted: !prev.access.scihub,
          },
        }))
        return
      }
      // Step 2: 'p' toggles EZproxy input
      if (step === 2 && input === 'p') {
        setEzproxyActive(a => !a)
        return
      }
      // Step 2: 'h' toggles Shibboleth
      if (step === 2 && input === 'h') {
        setCfg(prev => ({
          ...prev,
          access: { ...prev.access, shibboleth: !prev.access.shibboleth },
        }))
        return
      }
      // Step 2: 'f' toggles PDF folder input
      if (step === 2 && input === 'f') {
        setPdfFolderActive(a => !a)
        return
      }
      // Step 2: Tab toggles S2 key input
      if (step === 2 && key.tab) {
        setS2Active(a => !a)
        return
      }
      // Step 1: Tab cycles anthropic/openai key fields
      if (step === 1 && key.tab) {
        setKeyField(f => (f === 'anthropic' ? 'openai' : 'anthropic'))
        return
      }

      // Escape: go back to previous step
      if (key.escape && step > 0) {
        setStep(s => s - 1)
        return
      }

      // Step 5: navigation
      if (step === 5) {
        if (key.upArrow) {
          setSettingsCursor(c => Math.max(0, c - 1))
          return
        }
        if (key.downArrow) {
          setSettingsCursor(c => Math.min(6, c + 1))
          return
        }
        if (key.leftArrow) {
          changeSetting(-1)
          return
        }
        if (key.rightArrow) {
          changeSetting(1)
          return
        }
      }

      if (!key.return) return

      switch (step) {
        case 0:
          setStep(1)
          break
        case 1:
          setCfg(prev => ({
            ...prev,
            api_keys: {
              ...prev.api_keys,
              anthropic: apiKey || process.env.ANTHROPIC_API_KEY || '',
              openai: openaiKey || process.env.OPENAI_API_KEY || '',
            },
          }))
          setStep(2)
          break
        case 2:
          setCfg(prev => ({
            ...prev,
            api_keys: {
              ...prev.api_keys,
              semantic_scholar: s2Key || process.env.S2_API_KEY || '',
            },
            access: {
              ...prev.access,
              ezproxy_url: ezproxyUrl || prev.access.ezproxy_url,
              pdf_folder: pdfFolder || prev.access.pdf_folder,
            },
          }))
          setStep(3)
          if (!latexChecked) void runLatexCheck()
          break
        case 3:
          setStep(4)
          void runComputeProbe()
          break
        case 4:
          setStep(5)
          break
        case 5:
          try {
            await saveWizardConfig(cfg)
          } catch {
            /* best effort */
          }
          setStep(6)
          break
        case 6:
          onDone()
          break
      }
    },
    { isActive: !hasTextInput },
  )

  // Separate handler for text input active steps
  useInput(
    async (_input, key) => {
      if (step === 1 && key.tab) {
        setKeyField(f => (f === 'anthropic' ? 'openai' : 'anthropic'))
        return
      }
      if (step === 2 && key.tab) {
        setS2Active(a => !a)
        return
      }
      if (step === 2 && _input === 's') {
        setCfg(prev => ({
          ...prev,
          access: { ...prev.access, scihub: !prev.access.scihub },
        }))
        return
      }
      if (key.escape && step > 0) {
        setStep(s => s - 1)
        return
      }
      if (key.return) {
        if (step === 1) {
          setCfg(prev => ({
            ...prev,
            api_keys: {
              ...prev.api_keys,
              anthropic: apiKey || process.env.ANTHROPIC_API_KEY || '',
              openai: openaiKey || process.env.OPENAI_API_KEY || '',
            },
          }))
          setStep(2)
        } else if (step === 2) {
          setCfg(prev => ({
            ...prev,
            api_keys: {
              ...prev.api_keys,
              semantic_scholar: s2Key || process.env.S2_API_KEY || '',
            },
          }))
          setStep(3)
          if (!latexChecked) void runLatexCheck()
        }
      }
    },
    { isActive: hasTextInput },
  )

  const content: Record<number, React.ReactNode> = {
    0: <WelcomeStep />,
    1: (
      <ModelConfigStep
        cfg={cfg}
        apiKey={apiKey}
        onApiKeyChange={setApiKey}
        openaiKey={openaiKey}
        onOpenaiKeyChange={setOpenaiKey}
        activeField={apiFieldActive ? keyField : 'none'}
        advancedMode={advancedMode}
        advancedCursor={advancedCursor}
        advancedRole={MODEL_ROLES[advancedRoleIdx]?.key ?? 'research'}
        advancedEditing={advancedEditing}
        advancedValue={advancedValue}
        onAdvancedValueChange={setAdvancedValue}
      />
    ),
    2: (
      <AcademicAccessStep
        cfg={cfg}
        onToggleScihub={() =>
          setCfg(prev => ({
            ...prev,
            access: { ...prev.access, scihub: !prev.access.scihub },
          }))
        }
        s2Key={s2Key}
        onS2KeyChange={setS2Key}
        s2Active={s2Active}
        ezproxyUrl={ezproxyUrl}
        onEzproxyChange={setEzproxyUrl}
        ezproxyActive={ezproxyActive}
        pdfFolder={pdfFolder}
        onPdfFolderChange={setPdfFolder}
        pdfFolderActive={pdfFolderActive}
      />
    ),
    3: <LatexStep tools={latexTools} checking={latexChecking} />,
    4: <ComputeStep info={computeInfo} loading={computeLoading} />,
    5: <SettingsStep cfg={cfg} cursor={settingsCursor} />,
    6: <CompleteStep />,
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>Step {Math.min(step + 1, 6)} of 6</Text>
      {content[step]}
    </Box>
  )
}
