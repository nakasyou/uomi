import type { Config } from './config.ts'
import { DEFAULT_BASE_URL } from './config.ts'
import { CliError } from './errors.ts'

export interface JsonObject {
  [key: string]: any
}

export interface SearchOptions {
  term?: string
  limit?: number
  cursor?: string
  /** ISO time; the API keeps recordings that finished after it. */
  from?: string
  /** ISO time; the API keeps recordings that started before it. */
  to?: string
}

export interface StatusOptions {
  id?: string
  mode?: string
  status?: string
  limit?: number
  cursor?: string
}

type FetchLike = typeof fetch
type QueryValue = string | number | undefined | null

function queryPath(path: string, query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const search = params.toString()
  return path + (search ? `?${search}` : '')
}

export class UomiClient {
  readonly baseUrl: string
  readonly apiKey: string
  readonly sitesToken?: string
  private readonly fetcher: FetchLike

  constructor(config: Config, fetcher: FetchLike = fetch) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '') || DEFAULT_BASE_URL
    this.apiKey = config.apiKey
    this.sitesToken = config.sitesToken
    this.fetcher = fetcher
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('X-Uomi-Secret', this.apiKey)
    if (this.sitesToken) headers.set('OAI-Sites-Authorization', `Bearer ${this.sitesToken}`)
    try {
      const response = await this.fetcher(this.baseUrl + path, { ...init, headers })
      if (response.ok) return response
      throw await responseError(response)
    } catch (error) {
      if (error instanceof CliError) throw error
      throw new CliError(`cannot reach API: ${(error as Error).message}`)
    }
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<JsonObject> {
    const response = await this.request(path, init)
    const text = await response.text()
    if (!text) return {}
    try {
      return JSON.parse(text) as JsonObject
    } catch {
      throw new CliError('API returned invalid JSON')
    }
  }

  private async post(path: string, body?: JsonObject): Promise<JsonObject> {
    return this.requestJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  }

  search({ term, limit, cursor, from, to }: SearchOptions = {}): Promise<JsonObject> {
    return this.requestJson(queryPath('/api/recordings', { q: term, limit, cursor, from, to }))
  }

  recording(id: string): Promise<JsonObject> {
    return this.requestJson(`/api/recordings/${encodeURIComponent(id)}`)
  }

  recordingStatus(id: string): Promise<JsonObject> {
    return this.requestJson(`/api/recordings/${encodeURIComponent(id)}/status`)
  }

  jobs(): Promise<JsonObject> {
    return this.requestJson('/api/jobs')
  }

  status(options: StatusOptions = {}): Promise<JsonObject> {
    return this.requestJson(queryPath('/api/transcriptions', { ...options }))
  }

  startTranscription(id: string, retry: boolean): Promise<JsonObject> {
    return this.post(`/api/recordings/${encodeURIComponent(id)}/transcription`, { retry })
  }

  startDetailed(id: string, retry: boolean): Promise<JsonObject> {
    return this.post(`/api/recordings/${encodeURIComponent(id)}/detailed-transcription`, { retry })
  }

  detailedResult(id: string): Promise<JsonObject> {
    return this.requestJson(`/api/recordings/${encodeURIComponent(id)}/detailed-transcription`)
  }

  audio(id: string): Promise<Response> {
    return this.request(`/api/recordings/${encodeURIComponent(id)}/audio`)
  }

  async mcpList(): Promise<JsonObject> {
    return this.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  }

  async mcpCall(name: string, args: JsonObject): Promise<JsonObject> {
    const body = await this.rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    if (body.error) throw new CliError(`MCP error: ${String(body.error.message ?? body.error)}`)
    if (body.result?.isError) {
      const text = body.result.content?.map((item: any) => item?.text ?? '').join(' ')
      throw new CliError(`MCP tool failed: ${text || 'unknown error'}`)
    }
    return body
  }

  private async rpc(payload: JsonObject): Promise<JsonObject> {
    return this.requestJson('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
  }
}

async function responseError(response: Response): Promise<CliError> {
  let body = ''
  try {
    body = await response.text()
  } catch {}
  let message = ''
  try {
    const data = JSON.parse(body)
    const candidate = data.error ?? data.message
    if (typeof candidate === 'string') message = candidate
    else if (candidate) message = JSON.stringify(candidate)
  } catch {}
  if (!message && response.status === 401)
    message = 'authentication failed (check UOMI_SITES_TOKEN / UOMI_API_KEY)'
  if (!message) message = body.replace(/\s+/g, ' ').slice(0, 120) || 'no details'
  return new CliError(`HTTP ${response.status}: ${message}`)
}
