/** Every failed request retains its operation, HTTP status and server diagnostic. */
export async function api(path: string, options: RequestInit = {}) {
  const method = options.method ?? 'GET'
  const deadline = AbortSignal.timeout(30000)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  const headers = new Headers(options.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(path, { ...options, signal, headers })
  } catch (error) {
    throw Error(`${method} ${path}: ${(error as Error).message}`)
  }
  let raw: string
  try {
    raw = await response.text()
  } catch (error) {
    throw Error(
      `${method} ${path} · HTTP ${response.status}: response read failed: ${(error as Error).message}`,
    )
  }
  let value
  try {
    value = raw ? JSON.parse(raw) : {}
  } catch {
    throw Error(
      `${method} ${path} · HTTP ${response.status}: ${raw.slice(0, 500) || 'Empty response'}`,
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error(
      `${method} ${path} · HTTP ${response.status}: Expected a JSON object, received ${raw.slice(0, 500)}`,
    )
  if (!response.ok) {
    const message =
      typeof value.error === 'string'
        ? value.error
        : (value.error?.message ?? value.message ?? raw.slice(0, 500))
    const requestId = value.request_id ?? response.headers.get('x-request-id')
    throw Error(
      `${method} ${path} · HTTP ${response.status}: ${message}${requestId ? ` (request ${requestId})` : ''}`,
    )
  }
  return value
}
