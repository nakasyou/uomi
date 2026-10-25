import { DEFAULT_BASE_URL, loadConfig, type ConfigOptions } from './config.ts'
import { UomiClient, type JsonObject, type StatusOptions } from './client.ts'
import { CliError } from './errors.ts'
import {
  firstLine,
  formatClock,
  formatDetail,
  formatDuration,
  formatLocal,
  formatPercent,
} from './format.ts'

export interface IO {
  out: (chunk: string | Uint8Array) => void
  err: (chunk: string | Uint8Array) => void
}

export interface RunOptions extends ConfigOptions, Partial<IO> {
  fetch?: typeof fetch
}

interface Context {
  io: IO
  client: UomiClient
}

const HELP = `usage: uomi <command> [options]

Commands:
  search [TERM]              List or search recordings
    --limit N                Maximum results (default: 20, maximum: 50)
    --cursor C               Pagination cursor from a previous run
    --json                   Print the raw JSON response

  show ID                    Show metadata and a transcript
    --json                   Print the raw JSON response

  audio ID                   Download the original Ogg audio
    -o, --output FILE        Output file (default: <id>.ogg, - for stdout)

  transcribe ID             Start or retry standard transcription
    --retry                  Requeue a completed or failed job
    --json                   Print the raw JSON response

  detailed ID               Start or retry detailed transcription
    --retry                  Rerun a completed or failed job
    --json                   Print the raw JSON response

  detailed-result ID        Read the persisted detailed transcript
    --json                   Print the raw JSON response

  status [ID]               Show durable transcription progress
    --mode MODE              standard, long or detailed
    --status STATUS          queued, processing, retry, completed or failed
    --limit N                Jobs per page (default: 20, maximum: 100)
    --cursor C               Pagination cursor from a previous run
    --json                   Print the raw JSON response

  jobs [ID]                 List durable jobs, or all jobs for one recording
    --json                   Print the raw JSON response

  mcp --list                List MCP tools through the device-key API alias
  mcp TOOL                  Call an MCP tool through POST /api/mcp
    --args JSON              Tool arguments as a JSON object (default: {})
    --json                   Print the raw JSON-RPC response

Authentication:
  UOMI_API_KEY              Device API key (required; X-Uomi-Secret)
  UOMI_SITES_TOKEN          Private Sites service token (optional)
  UOMI_BASE_URL             API origin (default: ${'https://uomi-transcript-search.nakasyou.chatgpt.site'})

Missing values are read from ~/.config/uomi/env. Secret values are never printed.
`

interface OptionSpec {
  values?: string[]
  booleans?: string[]
  aliases?: Record<string, string>
}

interface ParsedOptions {
  positionals: string[]
  values: Record<string, string>
  flags: Set<string>
}

function parseOptions(argv: string[], spec: OptionSpec): ParsedOptions {
  const valueOptions = new Set(spec.values ?? [])
  const booleanOptions = new Set([...(spec.booleans ?? []), 'help'])
  const aliases = spec.aliases ?? {}
  const positionals: string[] = []
  const values: Record<string, string> = {}
  const flags = new Set<string>()

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (arg.startsWith('--')) {
      const separator = arg.indexOf('=')
      const rawName = separator >= 0 ? arg.slice(2, separator) : arg.slice(2)
      const inline = separator >= 0 ? arg.slice(separator + 1) : undefined
      const name = aliases[rawName] ?? rawName
      if (booleanOptions.has(name)) {
        if (inline !== undefined) throw new CliError(`option --${name} does not take a value`)
        flags.add(name)
      } else if (valueOptions.has(name)) {
        const value = inline ?? argv[++index]
        if (value === undefined) throw new CliError(`option --${name} requires a value`)
        values[name] = value
      } else {
        throw new CliError(`unknown option: --${name}`)
      }
      continue
    }
    if (arg.startsWith('-') && arg !== '-') {
      const short = arg.slice(1)
      const attached = short.length > 1 ? (aliases[short[0]] ?? short[0]) : undefined
      if (attached && valueOptions.has(attached)) {
        values[attached] = short.slice(1)
        continue
      }
      const name = aliases[short] ?? short
      if (booleanOptions.has(name)) flags.add(name)
      else if (valueOptions.has(name)) {
        const value = argv[++index]
        if (value === undefined) throw new CliError(`option -${short} requires a value`)
        values[name] = value
      } else {
        throw new CliError(`unknown option: -${short}`)
      }
      continue
    }
    positionals.push(arg)
  }
  return { positionals, values, flags }
}

function integerOption(
  value: string | undefined,
  name: string,
  fallback: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return fallback
  if (!/^-?\d+$/.test(value)) throw new CliError(`--${name} must be an integer`)
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new CliError(`--${name} must be between ${min} and ${max}`)
  return parsed
}

function oneId(positionals: string[], usage: string): string {
  if (positionals.length !== 1) throw new CliError(`usage: ${usage}`)
  return positionals[0]
}

function printJson(io: IO, data: unknown): void {
  io.out(`${JSON.stringify(data, null, 2)}\n`)
}

function titleOf(data: JsonObject): string {
  return String(data.title ?? '').trim() || '(untitled)'
}

function printJob(io: IO, job: JsonObject | null | undefined, prefix = ''): void {
  if (!job) {
    io.out(`${prefix}(no job)\n`)
    return
  }
  const progress = job.progress === undefined ? '' : `  ${formatPercent(job.progress)}`
  const attempt =
    job.attempt === undefined
      ? ''
      : `  attempt ${job.attempt}${job.max_attempts === undefined ? '' : `/${job.max_attempts}`}`
  const stage = job.stage ? `  ${job.stage}` : ''
  io.out(
    `${prefix}${job.recording_id ?? '?'}  ${job.mode ?? '?'}  ${job.status ?? '?'}${stage}${progress}${attempt}\n`,
  )
  if (job.error) io.out(`${prefix}  error: ${job.error}\n`)
  const detail = formatDetail(job.detail)
  if (detail) io.out(`${prefix}  ${detail}\n`)
  if (job.available_at) io.out(`${prefix}  available: ${formatLocal(job.available_at)}\n`)
  if (job.lease_until) io.out(`${prefix}  lease until: ${formatLocal(job.lease_until)}\n`)
  if (job.updated_at) io.out(`${prefix}  updated: ${formatLocal(job.updated_at)}\n`)
}

async function commandSearch(context: Context, argv: string[]): Promise<number> {
  const parsed = parseOptions(argv, { values: ['limit', 'cursor'], booleans: ['json'] })
  if (parsed.positionals.length > 1) throw new CliError('usage: uomi search [TERM] [options]')
  const term = parsed.positionals[0]
  const limit = integerOption(parsed.values.limit, 'limit', 20, 1, 50)
  const data = await context.client.search({ term, limit, cursor: parsed.values.cursor })
  if (parsed.flags.has('json')) {
    printJson(context.io, data)
    return 0
  }
  const results = Array.isArray(data.results) ? data.results : []
  if (!results.length) {
    context.io.out(term ? `No recordings matching "${term}".\n` : 'No recordings found.\n')
  } else {
    context.io.out(
      term
        ? `${results.length} recording(s) matching "${term}":\n`
        : `${results.length} recording(s):\n`,
    )
    for (const recording of results) {
      const title = String(recording.title ?? '').trim() || '(untitled)'
      context.io.out(
        `${recording.id ?? '?'}  ${formatLocal(recording.recorded_at)}  ${recording.status ?? '?'}  ${title}\n`,
      )
      const snippet = firstLine(recording.preview)
      if (snippet) context.io.out(`    ${snippet}\n`)
    }
  }
  if (data.next_cursor)
    context.io.out(`-- more results available (pass --cursor '${data.next_cursor}')\n`)
  return 0
}

async function commandShow(context: Context, argv: string[]): Promise<number> {
  const parsed = parseOptions(argv, { booleans: ['json'] })
  const id = oneId(parsed.positionals, 'uomi show ID [--json]')
  const data = await context.client.recording(id)
  if (parsed.flags.has('json')) {
    printJson(context.io, data)
    return 0
  }
  context.io.out(`Title:    ${titleOf(data)}\n`)
  context.io.out(`Date:     ${formatLocal(data.recorded_at)}\n`)
  context.io.out(`Duration: ${formatDuration(data.duration_ms)}\n`)
  context.io.out(`Status:   ${data.status ?? '?'}\n`)
  if (data.has_audio) context.io.out(`Audio:    available (./uomi audio ${data.id ?? id})\n`)

  const segments: JsonObject[] = Array.isArray(data.segments) ? data.segments : []
  if (!segments.length && Array.isArray(data.detailed_segments)) {
    for (const segment of data.detailed_segments) {
      segments.push({
        start_ms: segment.start_ms ?? segment.start ?? 0,
        speaker: segment.speaker ?? segment.speaker_label ?? '-',
        text: segment.text ?? '',
      })
    }
  }
  context.io.out('\n')
  if (segments.length) {
    const hourMode = segments.some((segment) => Number(segment.start_ms ?? 0) >= 3600000)
    for (const segment of segments) {
      let timestamp = formatClock(Number(segment.start_ms ?? 0))
      if (!hourMode) timestamp = timestamp.padStart(5, '0')
      context.io.out(`[${timestamp}] ${segment.speaker || '-'}: ${segment.text ?? ''}\n`)
    }
  } else {
    const text = String(data.text ?? '').trim()
    if (text) {
      for (const line of text.split(/\r?\n/)) context.io.out(`${line}\n`)
    } else {
      const note =
        data.transcription?.status ?? data.detailed_transcription?.status ?? data.status ?? ''
      context.io.out(`(no transcript available yet — ${note})\n`)
    }
  }
  return 0
}

async function commandAudio(context: Context, argv: string[]): Promise<number> {
  const parsed = parseOptions(argv, {
    values: ['output'],
    aliases: { o: 'output' },
  })
  const id = oneId(parsed.positionals, 'uomi audio ID [-o FILE|-]')
  const output = parsed.values.output ?? `${id}.ogg`
  const response = await context.client.audio(id)
  const reader = response.body?.getReader()
  if (!reader) throw new CliError('API returned an empty response body', 2)
  let total = 0
  if (output === '-') {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      total += value.byteLength
      context.io.out(value)
    }
    if (!total) throw new CliError('empty response body', 2)
    return 0
  }
  const writer = Bun.file(output).writer()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      total += value.byteLength
      await writer.write(value)
    }
  } finally {
    await writer.end()
  }
  context.io.out(`Saved ${total} bytes to ${output}\n`)
  return 0
}

async function commandTranscribe(context: Context, argv: string[]): Promise<number> {
  const parsed = parseOptions(argv, { booleans: ['retry', 'json'] })
  const id = oneId(parsed.positionals, 'uomi transcribe ID [--retry] [--json]')
  const data = await context.client.startTranscription(id, parsed.flags.has('retry'))
  if (parsed.flags.has('json')) {
    printJson(context.io, data)
    return 0
  }
  printJob(context.io, data.transcription, 'Transcription: ')
  return 0
}

async function commandDetailed(context: Context, argv: string[]): Promise<number> {
  const parsed = parseOptions(argv, { booleans: ['retry', 'json'] })
  const id = oneId(parsed.positionals, 'uomi detailed ID [--retry] [--json]')
  const data = await context.client.startDetailed(id, parsed.flags.has('retry'))
  if (parsed.flags.has('json')) {
    printJson(context.io, data)
    return 0
  }
  context.io.out(`Detailed status: ${data.detailed_status ?? '?'}\n`)
  if (data.detailed_error) context.io.out(`Error: ${data.detailed_error}\n`)
  printJob(context.io, data.detailed_transcription, 'Job: ')
  return 0
}

async function commandDetailedResult(context: Context, argv: string[]): Promise<number> {
  const parsed = parseOptions(argv, { booleans: ['json'] })
  const id = oneId(parsed.positionals, 'uomi detailed-result ID [--json]')
  const data = await context.client.detailedResult(id)
  if (parsed.flags.has('json')) {
    printJson(context.io, data)
    return 0
  }
  context.io.out(`Detailed status: ${data.detailed_status ?? '?'}\n`)
  if (data.detailed_error) context.io.out(`Error: ${data.detailed_error}\n`)
  printJob(context.io, data.detailed_transcription, 'Job: ')
  const text = String(data.detailed_text ?? '').trim()
  context.io.out('\n')
  context.io.out(text ? `${text}\n` : '(no detailed transcript available yet)\n')
  return 0
}

async function commandStatus(context: Context, argv: string[]): Promise<number> {
  const parsed = parseOptions(argv, {
    values: ['mode', 'status', 'limit', 'cursor'],
    booleans: ['json'],
  })
  if (parsed.positionals.length > 1)
    throw new CliError('usage: uomi status [ID] [--mode MODE] [options]')
  const mode = parsed.values.mode
  if (mode !== undefined && !['standard', 'long', 'detailed'].includes(mode))
    throw new CliError('--mode must be standard, long or detailed')
  const status = parsed.values.status
  if (
    status !== undefined &&
    !['queued', 'processing', 'retry', 'completed', 'failed'].includes(status)
  )
    throw new CliError('--status must be queued, processing, retry, completed or failed')
  const options: StatusOptions = {
    id: parsed.positionals[0],
    mode,
    status,
    limit: integerOption(parsed.values.limit, 'limit', undefined, 1, 100),
    cursor: parsed.values.cursor,
  }
  const data = await context.client.status(options)
  if (parsed.flags.has('json')) {
    printJson(context.io, data)
    return 0
  }
  context.io.out(`As of: ${formatLocal(data.as_of)}\n\nSummary:\n`)
  const summary = Array.isArray(data.summary) ? data.summary : []
  if (!summary.length) context.io.out('  (none)\n')
  for (const item of summary)
    context.io.out(`  ${item.mode ?? '?'} ${item.status ?? '?'}: ${item.count ?? 0}\n`)
  context.io.out('\nJobs:\n')
  const jobs = Array.isArray(data.jobs) ? data.jobs : []
  if (!jobs.length) context.io.out('  (none)\n')
  for (const job of jobs) {
    printJob(context.io, job, '  ')
    if (job.title) context.io.out(`    ${job.title}\n`)
  }
  if (data.next_cursor)
    context.io.out(`\n-- more jobs available (pass --cursor '${data.next_cursor}')\n`)
  return 0
}

async function commandJobs(context: Context, argv: string[]): Promise<number> {
  const parsed = parseOptions(argv, { booleans: ['json'] })
  if (parsed.positionals.length > 1) throw new CliError('usage: uomi jobs [ID] [--json]')
  const id = parsed.positionals[0]
  if (id) {
    const data = await context.client.recordingStatus(id)
    if (parsed.flags.has('json')) {
      printJson(context.io, data)
      return 0
    }
    context.io.out(`Recording: ${data.id ?? id}\n`)
    context.io.out(`Status:    ${data.status ?? '?'}\n`)
    context.io.out(`Detailed:  ${data.detailed_status ?? '?'}\n`)
    context.io.out(`Long:      ${data.long_status ?? '?'}\n`)
    context.io.out(`Audio:     ${data.has_audio ? 'available' : 'missing'}\n\n`)
    printJob(context.io, data.transcription)
    printJob(context.io, data.detailed_transcription)
    printJob(context.io, data.long_transcription)
    return 0
  }
  const data = await context.client.jobs()
  if (parsed.flags.has('json')) {
    printJson(context.io, data)
    return 0
  }
  const jobs = Array.isArray(data.results) ? data.results : []
  if (!jobs.length) context.io.out('No jobs found.\n')
  for (const job of jobs) printJob(context.io, job)
  return 0
}

async function commandMcp(context: Context, argv: string[]): Promise<number> {
  const parsed = parseOptions(argv, {
    values: ['args', 'tool'],
    booleans: ['list', 'json'],
  })
  if (parsed.flags.has('list')) {
    const body = await context.client.mcpList()
    if (parsed.flags.has('json')) {
      printJson(context.io, body)
      return 0
    }
    const tools = Array.isArray(body.result?.tools) ? body.result.tools : []
    for (const tool of tools) {
      context.io.out(`${tool.name}\n`)
      if (tool.description) context.io.out(`  ${tool.description}\n`)
    }
    return 0
  }
  const name = parsed.values.tool ?? parsed.positionals[0]
  if (!name || parsed.positionals.length > 1)
    throw new CliError('usage: uomi mcp TOOL [--args JSON] [--json] | uomi mcp --list')
  let args: JsonObject = {}
  if (parsed.values.args !== undefined) {
    let parsedArgs: unknown
    try {
      parsedArgs = JSON.parse(parsed.values.args)
    } catch {
      throw new CliError('--args must be valid JSON')
    }
    if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs))
      throw new CliError('--args must be a JSON object')
    args = parsedArgs as JsonObject
  }
  const body = await context.client.mcpCall(name, args)
  if (parsed.flags.has('json')) {
    printJson(context.io, body)
    return 0
  }
  const result = body.result ?? {}
  if (result.structuredContent !== undefined) printJson(context.io, result.structuredContent)
  else {
    const text = Array.isArray(result.content)
      ? result.content.map((item: any) => item?.text ?? '').join('\n')
      : ''
    context.io.out(text ? `${text}\n` : `${JSON.stringify(result, null, 2)}\n`)
  }
  return 0
}

export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const io: IO = {
    out: options.out ?? ((chunk) => process.stdout.write(chunk)),
    err: options.err ?? ((chunk) => process.stderr.write(chunk)),
  }
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    io.out(HELP)
    return 0
  }
  const [command, ...rest] = argv
  if (rest.includes('--help') || rest.includes('-h')) {
    io.out(HELP)
    return 0
  }
  try {
    const config = loadConfig(options)
    const client = new UomiClient(config, options.fetch)
    const context: Context = { io, client }
    switch (command) {
      case 'search':
        return await commandSearch(context, rest)
      case 'show':
        return await commandShow(context, rest)
      case 'audio':
        return await commandAudio(context, rest)
      case 'transcribe':
        return await commandTranscribe(context, rest)
      case 'detailed':
        return await commandDetailed(context, rest)
      case 'detailed-result':
        return await commandDetailedResult(context, rest)
      case 'status':
        return await commandStatus(context, rest)
      case 'jobs':
        return await commandJobs(context, rest)
      case 'mcp':
        return await commandMcp(context, rest)
      default:
        throw new CliError(`unknown command: ${command}\n\n${HELP}`)
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.err(`uomi: error: ${error.message}\n`)
      return error.exitCode
    }
    io.err(`uomi: error: ${(error as Error).message}\n`)
    return 1
  }
}
