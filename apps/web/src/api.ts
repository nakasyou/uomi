/** Every failed request retains its operation, HTTP status and server diagnostic. */
export async function api(path: string, options: RequestInit = {}) {
  const method = options.method ?? 'GET'
  let response: Response
  try {
    response = await fetch(path, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', ...options.headers },
    })
  } catch (error) {
    throw Error(`${method} ${path}: ${(error as Error).message}`)
  }
  const raw = await response.text()
  let value
  try {
    value = raw ? JSON.parse(raw) : {}
  } catch {
    throw Error(
      `${method} ${path} · HTTP ${response.status}: ${raw.slice(0, 500) || 'Empty response'}`,
    )
  }
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
