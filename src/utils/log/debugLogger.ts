import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { format } from 'node:util'
import chalk from 'chalk'
import envPaths from 'env-paths'
import { PRODUCT_COMMAND } from '@constants/product'
import { SESSION_ID } from './index'
import type { Message } from '@kode-types/conversation'

export enum LogLevel {
  TRACE = 'TRACE',
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  FLOW = 'FLOW',
  API = 'API',
  STATE = 'STATE',
  REMINDER = 'REMINDER',
}

const isDebugMode = () =>
  process.argv.includes('--debug-verbose') ||
  process.argv.includes('--mcp-debug') ||
  process.argv.some(
    arg => arg === '--debug' || arg === '-d' || arg.startsWith('--debug='),
  )
const isVerboseMode = () => process.argv.includes('--verbose')
const isDebugVerboseMode = () => process.argv.includes('--debug-verbose')

const TERMINAL_LOG_LEVELS = new Set([
  LogLevel.ERROR,
  LogLevel.WARN,
  LogLevel.INFO,
  LogLevel.REMINDER,
])

const DEBUG_VERBOSE_TERMINAL_LOG_LEVELS = new Set([
  LogLevel.ERROR,
  LogLevel.WARN,
  LogLevel.FLOW,
  LogLevel.API,
  LogLevel.STATE,
  LogLevel.INFO,
  LogLevel.REMINDER,
])

const USER_FRIENDLY_LEVELS = new Set([
  'SESSION_START',
  'QUERY_START',
  'QUERY_PROGRESS',
  'QUERY_COMPLETE',
  'TOOL_EXECUTION',
  'ERROR_OCCURRED',
  'PERFORMANCE_SUMMARY',
])

const STARTUP_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-')
const REQUEST_START_TIME = Date.now()

const KODE_DIR = join(homedir(), '.kode')
function getProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

const DEBUG_PATHS = {
  base: () => join(KODE_DIR, getProjectDir(process.cwd()), 'debug'),
  detailed: () => join(DEBUG_PATHS.base(), `${STARTUP_TIMESTAMP}-detailed.log`),
  flow: () => join(DEBUG_PATHS.base(), `${STARTUP_TIMESTAMP}-flow.log`),
  api: () => join(DEBUG_PATHS.base(), `${STARTUP_TIMESTAMP}-api.log`),
  state: () => join(DEBUG_PATHS.base(), `${STARTUP_TIMESTAMP}-state.log`),
}

function ensureDebugDir() {
  const debugDir = DEBUG_PATHS.base()
  if (!existsSync(debugDir)) {
    mkdirSync(debugDir, { recursive: true })
  }
}

interface LogEntry {
  timestamp: string
  level: LogLevel
  phase: string
  requestId?: string
  data: any
  elapsed?: number
}

class RequestContext {
  public readonly id: string
  public readonly startTime: number
  private phases: Map<string, number> = new Map()

  constructor() {
    this.id = randomUUID().slice(0, 8)
    this.startTime = Date.now()
  }

  markPhase(phase: string) {
    this.phases.set(phase, Date.now() - this.startTime)
  }

  getPhaseTime(phase: string): number {
    return this.phases.get(phase) || 0
  }

  getAllPhases(): Record<string, number> {
    return Object.fromEntries(this.phases)
  }
}

const activeRequests = new Map<string, RequestContext>()
let currentRequest: RequestContext | null = null

function terminalLog(...args: unknown[]): void {
  process.stderr.write(`${format(...args)}\n`)
}

function writeToFile(filePath: string, entry: LogEntry) {
  if (!isDebugMode()) return

  try {
    ensureDebugDir()
    const logLine =
      JSON.stringify(
        {
          ...entry,
          sessionId: SESSION_ID,
          pid: process.pid,
          uptime: Date.now() - REQUEST_START_TIME,
        },
        null,
        2,
      ) + ',\n'

    appendFileSync(filePath, logLine)
  } catch (error) {}
}

const recentLogs = new Map<string, number>()
const LOG_DEDUPE_WINDOW_MS = 5000

function getDedupeKey(level: LogLevel, phase: string, data: any): string {
  if (phase.startsWith('CONFIG_')) {
    const file = data?.file || ''
    return `${level}:${phase}:${file}`
  }

  return `${level}:${phase}`
}

function shouldLogWithDedupe(
  level: LogLevel,
  phase: string,
  data: any,
): boolean {
  const key = getDedupeKey(level, phase, data)
  const now = Date.now()
  const lastLogTime = recentLogs.get(key)

  if (!lastLogTime || now - lastLogTime > LOG_DEDUPE_WINDOW_MS) {
    recentLogs.set(key, now)

    for (const [oldKey, oldTime] of recentLogs.entries()) {
      if (now - oldTime > LOG_DEDUPE_WINDOW_MS) {
        recentLogs.delete(oldKey)
      }
    }

    return true
  }

  return false
}
function formatMessages(messages: any): string {
  if (Array.isArray(messages)) {
    const recentMessages = messages.slice(-5)
    return recentMessages
      .map((msg, index) => {
        const role = msg.role || 'unknown'
        let content = ''

        if (typeof msg.content === 'string') {
          content =
            msg.content.length > 300
              ? msg.content.substring(0, 300) + '...'
              : msg.content
        } else if (typeof msg.content === 'object') {
          content = '[complex_content]'
        } else {
          content = String(msg.content || '')
        }

        const totalIndex = messages.length - recentMessages.length + index
        return `[${totalIndex}] ${chalk.dim(role)}: ${content}`
      })
      .join('\n    ')
  }

  if (typeof messages === 'string') {
    try {
      const parsed = JSON.parse(messages)
      if (Array.isArray(parsed)) {
        return formatMessages(parsed)
      }
    } catch {}
  }

  if (typeof messages === 'string' && messages.length > 200) {
    return messages.substring(0, 200) + '...'
  }

  return typeof messages === 'string' ? messages : JSON.stringify(messages)
}

function shouldShowInTerminal(level: LogLevel): boolean {
  if (!isDebugMode()) return false

  if (isDebugVerboseMode()) {
    return DEBUG_VERBOSE_TERMINAL_LOG_LEVELS.has(level)
  }

  return TERMINAL_LOG_LEVELS.has(level)
}

function logToTerminal(entry: LogEntry) {
  if (!shouldShowInTerminal(entry.level)) return

  const { level, phase, data, requestId, elapsed } = entry
  const timestamp = new Date().toISOString().slice(11, 23)

  let prefix = ''
  let color = chalk.gray

  switch (level) {
    case LogLevel.FLOW:
      prefix = '🔄'
      color = chalk.cyan
      break
    case LogLevel.API:
      prefix = '🌐'
      color = chalk.yellow
      break
    case LogLevel.STATE:
      prefix = '📊'
      color = chalk.blue
      break
    case LogLevel.ERROR:
      prefix = '❌'
      color = chalk.red
      break
    case LogLevel.WARN:
      prefix = '⚠️'
      color = chalk.yellow
      break
    case LogLevel.INFO:
      prefix = 'ℹ️'
      color = chalk.green
      break
    case LogLevel.TRACE:
      prefix = '📈'
      color = chalk.magenta
      break
    default:
      prefix = '🔍'
      color = chalk.gray
  }

  const reqId = requestId ? chalk.dim(`[${requestId}]`) : ''
  const elapsedStr = elapsed !== undefined ? chalk.dim(`+${elapsed}ms`) : ''

  let dataStr = ''
  if (typeof data === 'object' && data !== null) {
    if (data.messages) {
      const formattedMessages = formatMessages(data.messages)
      dataStr = JSON.stringify(
        {
          ...data,
          messages: `\n    ${formattedMessages}`,
        },
        null,
        2,
      )
    } else {
      dataStr = JSON.stringify(data, null, 2)
    }
  } else {
    dataStr = typeof data === 'string' ? data : JSON.stringify(data)
  }

  terminalLog(
    `${color(`[${timestamp}]`)} ${prefix} ${color(phase)} ${reqId} ${dataStr} ${elapsedStr}`,
  )
}

export function debugLog(
  level: LogLevel,
  phase: string,
  data: any,
  requestId?: string,
) {
  if (!isDebugMode()) return

  if (!shouldLogWithDedupe(level, phase, data)) {
    return
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    phase,
    data,
    requestId: requestId || currentRequest?.id,
    elapsed: currentRequest ? Date.now() - currentRequest.startTime : undefined,
  }

  writeToFile(DEBUG_PATHS.detailed(), entry)

  switch (level) {
    case LogLevel.FLOW:
      writeToFile(DEBUG_PATHS.flow(), entry)
      break
    case LogLevel.API:
      writeToFile(DEBUG_PATHS.api(), entry)
      break
    case LogLevel.STATE:
      writeToFile(DEBUG_PATHS.state(), entry)
      break
  }

  logToTerminal(entry)
}

export const debug = {
  flow: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.FLOW, phase, data, requestId),

  api: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.API, phase, data, requestId),

  state: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.STATE, phase, data, requestId),

  info: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.INFO, phase, data, requestId),

  warn: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.WARN, phase, data, requestId),

  error: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.ERROR, phase, data, requestId),

  trace: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.TRACE, phase, data, requestId),

  ui: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.STATE, `UI_${phase}`, data, requestId),
}

export function startRequest(): RequestContext {
  const ctx = new RequestContext()
  currentRequest = ctx
  activeRequests.set(ctx.id, ctx)

  debug.flow('REQUEST_START', {
    requestId: ctx.id,
    activeRequests: activeRequests.size,
  })

  return ctx
}

export function endRequest(ctx?: RequestContext) {
  const request = ctx || currentRequest
  if (!request) return

  debug.flow('REQUEST_END', {
    requestId: request.id,
    totalTime: Date.now() - request.startTime,
    phases: request.getAllPhases(),
  })

  activeRequests.delete(request.id)
  if (currentRequest === request) {
    currentRequest = null
  }
}

export function getCurrentRequest(): RequestContext | null {
  return currentRequest
}

export function markPhase(phase: string, data?: any) {
  if (!currentRequest) return

  currentRequest.markPhase(phase)
  debug.flow(`PHASE_${phase.toUpperCase()}`, {
    requestId: currentRequest.id,
    elapsed: currentRequest.getPhaseTime(phase),
    data,
  })
}

export function logReminderEvent(
  eventType: string,
  reminderData: any,
  agentId?: string,
) {
  if (!isDebugMode()) return

  debug.info('REMINDER_EVENT_TRIGGERED', {
    eventType,
    agentId: agentId || 'default',
    reminderType: reminderData.type || 'unknown',
    reminderCategory: reminderData.category || 'general',
    reminderPriority: reminderData.priority || 'medium',
    contentLength: reminderData.content ? reminderData.content.length : 0,
    timestamp: Date.now(),
  })
}

export function logAPIError(context: {
  model: string
  endpoint: string
  status: number
  error: any
  request?: any
  response?: any
  provider?: string
}) {
  const errorDir = join(KODE_DIR, 'logs', 'error', 'api')

  if (!existsSync(errorDir)) {
    try {
      mkdirSync(errorDir, { recursive: true })
    } catch (err) {
      terminalLog('Failed to create error log directory:', err)
      return
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sanitizedModel = context.model.replace(/[^a-zA-Z0-9-_]/g, '_')
  const filename = `${sanitizedModel}_${timestamp}.log`
  const filepath = join(errorDir, filename)

  const fullLogContent = {
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
    requestId: getCurrentRequest()?.id,
    model: context.model,
    provider: context.provider,
    endpoint: context.endpoint,
    status: context.status,
    error: context.error,
    request: context.request,
    response: context.response,
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      cwd: process.cwd(),
    },
  }

  try {
    appendFileSync(filepath, JSON.stringify(fullLogContent, null, 2) + '\n')
    appendFileSync(filepath, '='.repeat(80) + '\n\n')
  } catch (err) {
    terminalLog('Failed to write API error log:', err)
  }

  if (isDebugMode()) {
    debug.error('API_ERROR', {
      model: context.model,
      status: context.status,
      error:
        typeof context.error === 'string'
          ? context.error
          : context.error?.message || 'Unknown error',
      endpoint: context.endpoint,
      logFile: filename,
    })
  }

  if (isVerboseMode() || isDebugVerboseMode()) {
    terminalLog()
    terminalLog(chalk.red('━'.repeat(60)))
    terminalLog(chalk.red.bold('⚠️  API Error'))
    terminalLog(chalk.red('━'.repeat(60)))

    terminalLog(chalk.white('  Model:  ') + chalk.yellow(context.model))
    terminalLog(chalk.white('  Status: ') + chalk.red(context.status))

    let errorMessage = 'Unknown error'
    if (typeof context.error === 'string') {
      errorMessage = context.error
    } else if (context.error?.message) {
      errorMessage = context.error.message
    } else if (context.error?.error?.message) {
      errorMessage = context.error.error.message
    }

    terminalLog(chalk.white('  Error:  ') + chalk.red(errorMessage))

    if (context.response) {
      terminalLog()
      terminalLog(chalk.gray('  Response:'))
      const responseStr =
        typeof context.response === 'string'
          ? context.response
          : JSON.stringify(context.response, null, 2)

      responseStr.split('\n').forEach(line => {
        terminalLog(chalk.gray('    ' + line))
      })
    }

    terminalLog()
    terminalLog(chalk.dim(`  📁 Full log: ${filepath}`))
    terminalLog(chalk.red('━'.repeat(60)))
    terminalLog()
  }
}

export function logLLMInteraction(context: {
  systemPrompt: string
  messages: any[]
  response: any
  usage?: { inputTokens: number; outputTokens: number }
  timing: { start: number; end: number }
  apiFormat?: 'anthropic' | 'openai'
}) {
  if (!isDebugMode()) return

  const duration = context.timing.end - context.timing.start

  terminalLog('\n' + chalk.blue('🧠 LLM CALL DEBUG'))
  terminalLog(chalk.gray('━'.repeat(60)))

  terminalLog(chalk.yellow('📊 Context Overview:'))
  terminalLog(`   Messages Count: ${context.messages.length}`)
  terminalLog(`   System Prompt Length: ${context.systemPrompt.length} chars`)
  terminalLog(`   Duration: ${duration.toFixed(0)}ms`)

  if (context.usage) {
    terminalLog(
      `   Token Usage: ${context.usage.inputTokens} → ${context.usage.outputTokens}`,
    )
  }

  const apiLabel = context.apiFormat
    ? ` (${context.apiFormat.toUpperCase()})`
    : ''
  terminalLog(chalk.cyan(`\n💬 Real API Messages${apiLabel} (last 10):`))

  const recentMessages = context.messages.slice(-10)
  recentMessages.forEach((msg, index) => {
    const globalIndex = context.messages.length - recentMessages.length + index
    const roleColor =
      msg.role === 'user'
        ? 'green'
        : msg.role === 'assistant'
          ? 'blue'
          : msg.role === 'system'
            ? 'yellow'
            : 'gray'

    let content = ''
    let isReminder = false

    if (typeof msg.content === 'string') {
      if (msg.content.includes('<system-reminder>')) {
        isReminder = true
        const reminderContent = msg.content
          .replace(/<\/?system-reminder>/g, '')
          .trim()
        content = `🔔 ${reminderContent.length > 800 ? reminderContent.substring(0, 800) + '...' : reminderContent}`
      } else {
        const maxLength =
          msg.role === 'user' ? 1000 : msg.role === 'system' ? 1200 : 800
        content =
          msg.content.length > maxLength
            ? msg.content.substring(0, maxLength) + '...'
            : msg.content
      }
    } else if (Array.isArray(msg.content)) {
      const textBlocks = msg.content.filter(
        (block: any) => block.type === 'text',
      )
      const toolBlocks = msg.content.filter(
        (block: any) => block.type === 'tool_use',
      )
      if (textBlocks.length > 0) {
        const text = textBlocks[0].text || ''
        const maxLength = msg.role === 'assistant' ? 1000 : 800
        content =
          text.length > maxLength ? text.substring(0, maxLength) + '...' : text
      }
      if (toolBlocks.length > 0) {
        content += ` [+ ${toolBlocks.length} tool calls]`
      }
      if (textBlocks.length === 0 && toolBlocks.length === 0) {
        content = `[${msg.content.length} blocks: ${msg.content.map(b => b.type || 'unknown').join(', ')}]`
      }
    } else {
      content = '[complex_content]'
    }

    if (isReminder) {
      terminalLog(
        `   [${globalIndex}] ${chalk.magenta('🔔 REMINDER')}: ${chalk.dim(content)}`,
      )
    } else {
      const roleIcon =
        msg.role === 'user'
          ? '👤'
          : msg.role === 'assistant'
            ? '🤖'
            : msg.role === 'system'
              ? '⚙️'
              : '📄'
      terminalLog(
        `   [${globalIndex}] ${(chalk as any)[roleColor](roleIcon + ' ' + msg.role.toUpperCase())}: ${content}`,
      )
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolCalls = msg.content.filter(
        (block: any) => block.type === 'tool_use',
      )
      if (toolCalls.length > 0) {
        terminalLog(
          chalk.cyan(
            `       🔧 → Tool calls (${toolCalls.length}): ${toolCalls.map((t: any) => t.name).join(', ')}`,
          ),
        )
        toolCalls.forEach((tool: any, idx: number) => {
          const inputStr = JSON.stringify(tool.input || {})
          const maxLength = 200
          const displayInput =
            inputStr.length > maxLength
              ? inputStr.substring(0, maxLength) + '...'
              : inputStr
          terminalLog(
            chalk.dim(`         [${idx}] ${tool.name}: ${displayInput}`),
          )
        })
      }
    }
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      terminalLog(
        chalk.cyan(
          `       🔧 → Tool calls (${msg.tool_calls.length}): ${msg.tool_calls.map((t: any) => t.function.name).join(', ')}`,
        ),
      )
      msg.tool_calls.forEach((tool: any, idx: number) => {
        const inputStr = tool.function.arguments || '{}'
        const maxLength = 200
        const displayInput =
          inputStr.length > maxLength
            ? inputStr.substring(0, maxLength) + '...'
            : inputStr
        terminalLog(
          chalk.dim(`         [${idx}] ${tool.function.name}: ${displayInput}`),
        )
      })
    }
  })

  terminalLog(chalk.magenta('\n🤖 LLM Response:'))

  let responseContent = ''
  let toolCalls: any[] = []

  if (Array.isArray(context.response.content)) {
    const textBlocks = context.response.content.filter(
      (block: any) => block.type === 'text',
    )
    responseContent = textBlocks.length > 0 ? textBlocks[0].text || '' : ''
    toolCalls = context.response.content.filter(
      (block: any) => block.type === 'tool_use',
    )
  } else if (typeof context.response.content === 'string') {
    responseContent = context.response.content
    toolCalls = context.response.tool_calls || context.response.toolCalls || []
  } else if (context.response.message?.content) {
    if (Array.isArray(context.response.message.content)) {
      const textBlocks = context.response.message.content.filter(
        (block: any) => block.type === 'text',
      )
      responseContent = textBlocks.length > 0 ? textBlocks[0].text || '' : ''
      toolCalls = context.response.message.content.filter(
        (block: any) => block.type === 'tool_use',
      )
    } else if (typeof context.response.message.content === 'string') {
      responseContent = context.response.message.content
    }
  } else {
    responseContent = JSON.stringify(
      context.response.content || context.response || '',
    )
  }

  const maxResponseLength = 1000
  const displayContent =
    responseContent.length > maxResponseLength
      ? responseContent.substring(0, maxResponseLength) + '...'
      : responseContent
  terminalLog(`   Content: ${displayContent}`)

  if (toolCalls.length > 0) {
    const toolNames = toolCalls.map(
      (t: any) => t.name || t.function?.name || 'unknown',
    )
    terminalLog(
      chalk.cyan(
        `   🔧 Tool Calls (${toolCalls.length}): ${toolNames.join(', ')}`,
      ),
    )
    toolCalls.forEach((tool: any, index: number) => {
      const toolName = tool.name || tool.function?.name || 'unknown'
      const toolInput = tool.input || tool.function?.arguments || '{}'
      const inputStr =
        typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
      const maxToolInputLength = 300
      const displayInput =
        inputStr.length > maxToolInputLength
          ? inputStr.substring(0, maxToolInputLength) + '...'
          : inputStr
      terminalLog(chalk.dim(`     [${index}] ${toolName}: ${displayInput}`))
    })
  }

  terminalLog(
    `   Stop Reason: ${context.response.stop_reason || context.response.finish_reason || 'unknown'}`,
  )
  terminalLog(chalk.gray('━'.repeat(60)))
}

export function logSystemPromptConstruction(construction: {
  basePrompt: string
  kodeContext?: string
  reminders: string[]
  finalPrompt: string
}) {
  if (!isDebugMode()) return

  terminalLog('\n' + chalk.yellow('📝 SYSTEM PROMPT CONSTRUCTION'))
  terminalLog(`   Base Prompt: ${construction.basePrompt.length} chars`)

  if (construction.kodeContext) {
    terminalLog(`   + Context: ${construction.kodeContext.length} chars`)
  }

  if (construction.reminders.length > 0) {
    terminalLog(
      `   + Dynamic Reminders: ${construction.reminders.length} items`,
    )
    construction.reminders.forEach((reminder, index) => {
      terminalLog(chalk.dim(`     [${index}] ${reminder.substring(0, 80)}...`))
    })
  }

  terminalLog(`   = Final Length: ${construction.finalPrompt.length} chars`)
}

export function logContextCompression(compression: {
  beforeMessages: number
  afterMessages: number
  trigger: string
  preservedFiles: string[]
  compressionRatio: number
}) {
  if (!isDebugMode()) return

  terminalLog('\n' + chalk.red('🗜️  CONTEXT COMPRESSION'))
  terminalLog(`   Trigger: ${compression.trigger}`)
  terminalLog(
    `   Messages: ${compression.beforeMessages} → ${compression.afterMessages}`,
  )
  terminalLog(
    `   Compression Ratio: ${(compression.compressionRatio * 100).toFixed(1)}%`,
  )

  if (compression.preservedFiles.length > 0) {
    terminalLog(`   Preserved Files: ${compression.preservedFiles.join(', ')}`)
  }
}

export function logUserFriendly(type: string, data: any, requestId?: string) {
  if (!isDebugMode()) return

  const timestamp = new Date().toLocaleTimeString()
  let message = ''
  let color = chalk.gray
  let icon = '•'

  switch (type) {
    case 'SESSION_START':
      icon = '🚀'
      color = chalk.green
      message = `Session started with ${data.model || 'default model'}`
      break
    case 'QUERY_START':
      icon = '💭'
      color = chalk.blue
      message = `Processing query: "${data.query?.substring(0, 50)}${data.query?.length > 50 ? '...' : ''}"`
      break
    case 'QUERY_PROGRESS':
      icon = '⏳'
      color = chalk.yellow
      message = `${data.phase} (${data.elapsed}ms)`
      break
    case 'QUERY_COMPLETE':
      icon = '✅'
      color = chalk.green
      message = `Query completed in ${data.duration}ms - Cost: $${data.cost} - ${data.tokens} tokens`
      break
    case 'TOOL_EXECUTION':
      icon = '🔧'
      color = chalk.cyan
      message = `${data.toolName}: ${data.action} ${data.target ? '→ ' + data.target : ''}`
      break
    case 'ERROR_OCCURRED':
      icon = '❌'
      color = chalk.red
      message = `${data.error} ${data.context ? '(' + data.context + ')' : ''}`
      break
    case 'PERFORMANCE_SUMMARY':
      icon = '📊'
      color = chalk.magenta
      message = `Session: ${data.queries} queries, $${data.totalCost}, ${data.avgResponseTime}ms avg`
      break
    default:
      message = JSON.stringify(data)
  }

  const reqId = requestId ? chalk.dim(`[${requestId.slice(0, 8)}]`) : ''
  terminalLog(`${color(`[${timestamp}]`)} ${icon} ${color(message)} ${reqId}`)
}

export function initDebugLogger() {
  if (!isDebugMode()) return

  debug.info('DEBUG_LOGGER_INIT', {
    startupTimestamp: STARTUP_TIMESTAMP,
    sessionId: SESSION_ID,
    debugPaths: {
      detailed: DEBUG_PATHS.detailed(),
      flow: DEBUG_PATHS.flow(),
      api: DEBUG_PATHS.api(),
      state: DEBUG_PATHS.state(),
    },
  })

  const terminalLevels = isDebugVerboseMode()
    ? Array.from(DEBUG_VERBOSE_TERMINAL_LOG_LEVELS).join(', ')
    : Array.from(TERMINAL_LOG_LEVELS).join(', ')

  terminalLog(
    chalk.dim(`[DEBUG] Terminal output filtered to: ${terminalLevels}`),
  )
  terminalLog(
    chalk.dim(`[DEBUG] Complete logs saved to: ${DEBUG_PATHS.base()}`),
  )
  if (!isDebugVerboseMode()) {
    terminalLog(
      chalk.dim(
        `[DEBUG] Use --debug-verbose for detailed system logs (FLOW, API, STATE)`,
      ),
    )
  }
}

interface ErrorDiagnosis {
  errorType: string
  category:
    | 'NETWORK'
    | 'API'
    | 'PERMISSION'
    | 'CONFIG'
    | 'SYSTEM'
    | 'USER_INPUT'
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  description: string
  suggestions: string[]
  debugSteps: string[]
  relatedLogs?: string[]
}

export function diagnoseError(error: any, context?: any): ErrorDiagnosis {
  const errorMessage = error instanceof Error ? error.message : String(error)
  const errorStack = error instanceof Error ? error.stack : undefined

  if (
    errorMessage.includes('aborted') ||
    errorMessage.includes('AbortController')
  ) {
    return {
      errorType: 'REQUEST_ABORTED',
      category: 'SYSTEM',
      severity: 'MEDIUM',
      description:
        'Request was aborted, often due to user cancellation or timeout',
      suggestions: [
        '检查是否按下了 ESC 键取消请求',
        '检查网络连接是否稳定',
        '验证 AbortController 状态: isActive 和 signal.aborted 应该一致',
        '查看是否有重复的请求导致冲突',
      ],
      debugSteps: [
        '使用 --debug-verbose 模式查看详细的请求流程',
        '检查 debug 日志中的 BINARY_FEEDBACK_* 事件',
        '验证 REQUEST_START 和 REQUEST_END 日志配对',
        '查看 QUERY_ABORTED 事件的触发原因',
      ],
    }
  }

  if (
    errorMessage.includes('api-key') ||
    errorMessage.includes('authentication') ||
    errorMessage.includes('401')
  ) {
    return {
      errorType: 'API_AUTHENTICATION',
      category: 'API',
      severity: 'HIGH',
      description: 'API authentication failed - invalid or missing API key',
      suggestions: [
        '运行 /login 重新设置 API 密钥',
        '检查 ~/.claude/ 配置文件中的 API 密钥',
        '验证 API 密钥是否已过期或被撤销',
        '确认使用的 provider 设置正确 (anthropic/opendev/bigdream)',
      ],
      debugSteps: [
        '检查 CONFIG_LOAD 日志中的 provider 和 API 密钥状态',
        '运行 cpaper doctor 检查系统健康状态',
        '查看 API_ERROR 日志了解详细错误信息',
        '使用 cpaper config 命令查看当前配置',
      ],
    }
  }

  if (
    errorMessage.includes('ECONNREFUSED') ||
    errorMessage.includes('ENOTFOUND') ||
    errorMessage.includes('timeout')
  ) {
    return {
      errorType: 'NETWORK_CONNECTION',
      category: 'NETWORK',
      severity: 'HIGH',
      description: 'Network connection failed - unable to reach API endpoint',
      suggestions: [
        '检查网络连接是否正常',
        '确认防火墙没有阻止相关端口',
        '检查 proxy 设置是否正确',
        '尝试切换到不同的网络环境',
        '验证 baseURL 配置是否正确',
      ],
      debugSteps: [
        '检查 API_REQUEST_START 和相关网络日志',
        '查看 LLM_REQUEST_ERROR 中的详细错误信息',
        '使用 ping 或 curl 测试 API 端点连通性',
        '检查企业网络是否需要代理设置',
      ],
    }
  }

  if (
    errorMessage.includes('permission') ||
    errorMessage.includes('EACCES') ||
    errorMessage.includes('denied')
  ) {
    return {
      errorType: 'PERMISSION_DENIED',
      category: 'PERMISSION',
      severity: 'MEDIUM',
      description: 'Permission denied - insufficient access rights',
      suggestions: [
        '检查文件和目录的读写权限',
        '确认当前用户有足够的系统权限',
        '查看是否需要管理员权限运行',
        '检查工具权限设置是否正确配置',
      ],
      debugSteps: [
        '查看 PERMISSION_* 日志了解权限检查过程',
        '检查文件系统权限: ls -la',
        '验证工具审批状态',
        '查看 TOOL_* 相关的调试日志',
      ],
    }
  }

  if (
    errorMessage.includes('substring is not a function') ||
    errorMessage.includes('content')
  ) {
    return {
      errorType: 'RESPONSE_FORMAT',
      category: 'API',
      severity: 'MEDIUM',
      description: 'LLM response format mismatch between different providers',
      suggestions: [
        '检查当前使用的 provider 是否与期望一致',
        '验证响应格式处理逻辑',
        '确认不同 provider 的响应格式差异',
        '检查是否需要更新响应解析代码',
      ],
      debugSteps: [
        '查看 LLM_CALL_DEBUG 中的响应格式',
        '检查 provider 配置和实际使用的 API',
        '对比 Anthropic 和 OpenAI 响应格式差异',
        '验证 logLLMInteraction 函数的格式处理',
      ],
    }
  }

  if (
    errorMessage.includes('too long') ||
    errorMessage.includes('context') ||
    errorMessage.includes('token')
  ) {
    return {
      errorType: 'CONTEXT_OVERFLOW',
      category: 'SYSTEM',
      severity: 'MEDIUM',
      description: 'Context window exceeded - conversation too long',
      suggestions: [
        '运行 /compact 手动压缩对话历史',
        '检查自动压缩设置是否正确配置',
        '减少单次输入的内容长度',
        '清理不必要的上下文信息',
      ],
      debugSteps: [
        '查看 AUTO_COMPACT_* 日志检查压缩触发',
        '检查 token 使用量和阈值',
        '查看 CONTEXT_COMPRESSION 相关日志',
        '验证模型的最大 token 限制',
      ],
    }
  }

  if (
    errorMessage.includes('config') ||
    (errorMessage.includes('undefined') && context?.configRelated)
  ) {
    return {
      errorType: 'CONFIGURATION',
      category: 'CONFIG',
      severity: 'MEDIUM',
      description: 'Configuration error - missing or invalid settings',
      suggestions: [
        '运行 cpaper config 检查配置设置',
        '删除损坏的配置文件重新初始化',
        '检查 JSON 配置文件语法是否正确',
        '验证环境变量设置',
      ],
      debugSteps: [
        '查看 CONFIG_LOAD 和 CONFIG_SAVE 日志',
        '检查配置文件路径和权限',
        '验证 JSON 格式: cat ~/.claude/config.json | jq',
        '查看配置缓存相关的调试信息',
      ],
    }
  }

  return {
    errorType: 'UNKNOWN',
    category: 'SYSTEM',
    severity: 'MEDIUM',
    description: `Unexpected error: ${errorMessage}`,
    suggestions: [
      '重新启动应用程序',
      '检查系统资源是否充足',
      '查看完整的错误日志获取更多信息',
      '如果问题持续，请报告此错误',
    ],
    debugSteps: [
      '使用 --debug-verbose 获取详细日志',
      '检查 error.log 中的完整错误信息',
      '查看系统资源使用情况',
      '收集重现步骤和环境信息',
    ],
    relatedLogs: errorStack ? [errorStack] : undefined,
  }
}

export function logErrorWithDiagnosis(
  error: any,
  context?: any,
  requestId?: string,
) {
  if (!isDebugMode()) return

  const diagnosis = diagnoseError(error, context)
  const errorMessage = error instanceof Error ? error.message : String(error)

  debug.error(
    'ERROR_OCCURRED',
    {
      error: errorMessage,
      errorType: diagnosis.errorType,
      category: diagnosis.category,
      severity: diagnosis.severity,
      context,
    },
    requestId,
  )

  terminalLog('\n' + chalk.red('🚨 ERROR DIAGNOSIS'))
  terminalLog(chalk.gray('━'.repeat(60)))

  terminalLog(chalk.red(`❌ ${diagnosis.errorType}`))
  terminalLog(
    chalk.dim(
      `Category: ${diagnosis.category} | Severity: ${diagnosis.severity}`,
    ),
  )
  terminalLog(`\n${diagnosis.description}`)

  terminalLog(chalk.yellow('\n💡 Recovery Suggestions:'))
  diagnosis.suggestions.forEach((suggestion, index) => {
    terminalLog(`   ${index + 1}. ${suggestion}`)
  })

  terminalLog(chalk.cyan('\n🔍 Debug Steps:'))
  diagnosis.debugSteps.forEach((step, index) => {
    terminalLog(`   ${index + 1}. ${step}`)
  })

  if (diagnosis.relatedLogs && diagnosis.relatedLogs.length > 0) {
    terminalLog(chalk.magenta('\n📋 Related Information:'))
    diagnosis.relatedLogs.forEach((log, index) => {
      const truncatedLog =
        log.length > 200 ? log.substring(0, 200) + '...' : log
      terminalLog(chalk.dim(`   ${truncatedLog}`))
    })
  }

  const debugPath = DEBUG_PATHS.base()
  terminalLog(chalk.gray(`\n📁 Complete logs: ${debugPath}`))
  terminalLog(chalk.gray('━'.repeat(60)))
}
export function getDebugInfo() {
  return {
    isDebugMode: isDebugMode(),
    isVerboseMode: isVerboseMode(),
    isDebugVerboseMode: isDebugVerboseMode(),
    startupTimestamp: STARTUP_TIMESTAMP,
    sessionId: SESSION_ID,
    currentRequest: currentRequest?.id,
    activeRequests: Array.from(activeRequests.keys()),
    terminalLogLevels: isDebugVerboseMode()
      ? Array.from(DEBUG_VERBOSE_TERMINAL_LOG_LEVELS)
      : Array.from(TERMINAL_LOG_LEVELS),
    debugPaths: {
      detailed: DEBUG_PATHS.detailed(),
      flow: DEBUG_PATHS.flow(),
      api: DEBUG_PATHS.api(),
      state: DEBUG_PATHS.state(),
    },
  }
}
