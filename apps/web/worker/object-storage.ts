import { ApiError } from './jobs.ts'

type BufferedBucket = {
  put(
    key: string,
    data: ArrayBuffer | ArrayBufferView,
    options: { httpMetadata: { contentType: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>
}

// Only replay buffered, content-addressed writes. A consumed stream cannot be retried.
export async function putObject(
  bucket: BufferedBucket,
  key: string,
  data: ArrayBuffer | ArrayBufferView,
  options: Parameters<BufferedBucket['put']>[2],
) {
  for (let attempt = 1; ; attempt++) {
    try {
      await bucket.put(key, data, options)
      return
    } catch (error) {
      // R2's internal error is transient. Validation/auth/quota errors must surface immediately.
      if (!/\(10001\)/.test(String((error as Error).message))) throw error
      console.warn(
        JSON.stringify({ event: 'object_put_retry', key, attempt, exhausted: attempt === 4 }),
      )
      if (attempt === 4)
        throw new ApiError(
          'Audio storage is temporarily unavailable. Audio remains queued on your device; retry sync.',
          503,
          'storage_unavailable',
        )
      await new Promise((resolve) =>
        setTimeout(resolve, 250 * 2 ** (attempt - 1) + Math.random() * 100),
      )
    }
  }
}
