// Explicit diagnostics only: these scans must never run during uploads/search or
// lightweight recording status polls. Unsupported D1 PRAGMAs remain visible data.
export async function storageDiagnostics(env: any) {
  const result =
    await env.DB.prepare(`SELECT count(*) AS ranges,count(DISTINCT prefix) AS distinct_prefixes,
   count(DISTINCT recording_id) AS recordings,sum(end-start) AS frames,
   coalesce(sum(length(CAST(device AS BLOB))),0) AS device_utf8_bytes,
   coalesce(sum(length(CAST(prefix AS BLOB))),0) AS prefix_utf8_bytes,
   sum(start=0) AS ranges_starting_at_zero,min(end-start) AS minimum_span,max(end-start) AS maximum_span,
   avg(end-start) AS average_span FROM source_ranges`).first()
  const largest =
    await env.DB.prepare(`SELECT recording_id,count(*) AS ranges,sum(end-start) AS frames,
   sum(length(CAST(prefix AS BLOB))+length(CAST(device AS BLOB))) AS identity_utf8_bytes
   FROM source_ranges GROUP BY recording_id ORDER BY ranges DESC LIMIT 10`).all()
  const allocation: Record<string, unknown> = {},
    errors: Record<string, string> = {}
  await Promise.all(
    ['page_count', 'page_size', 'freelist_count'].map(async (name) => {
      try {
        const row = await env.DB.prepare('PRAGMA ' + name).first()
        allocation[name] = row?.[name] ?? null
      } catch (error) {
        allocation[name] = null
        errors[name] = String((error as Error).message).slice(0, 1000)
      }
    }),
  )
  const pageCount = allocation.page_count,
    pageSize = allocation.page_size,
    freeCount = allocation.freelist_count
  return {
    source_ranges: { ...result, largest_recordings: largest.results },
    allocation: {
      ...allocation,
      allocated_bytes:
        typeof pageCount === 'number' && typeof pageSize === 'number' ? pageCount * pageSize : null,
      free_page_bytes:
        typeof freeCount === 'number' && typeof pageSize === 'number' ? freeCount * pageSize : null,
      ...(Object.keys(errors).length ? { errors } : {}),
    },
  }
}
