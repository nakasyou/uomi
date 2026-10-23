import { normalizeSearch } from './search.js'
import { saveManifest, unpackManifest, loadManifest } from './manifest.ts'
// Bounded, restart-safe migration. Immutable SQL migrations cannot run JS normalization.
export async function optimizeCache(env: any) {
  const rows = await env.DB.prepare(
    'SELECT rid,id,text FROM recordings WHERE search_version=0 ORDER BY rid LIMIT 100',
  ).all()
  if (rows.results.length)
    await env.DB.batch(
      rows.results.map((r: any) =>
        env.DB.prepare(
          'UPDATE recordings SET search_text=?,search_version=1 WHERE rid=? AND text=? AND search_version=0',
        ).bind(normalizeSearch(r.text), r.rid, r.text),
      ),
    )
  const manifests = await env.DB.prepare(
    'SELECT rid,manifest_gzip FROM recordings WHERE manifest_gzip IS NOT NULL ORDER BY rid LIMIT 1',
  ).all()
  for (const row of manifests.results) {
    const key = await saveManifest(env, await unpackManifest(row.manifest_gzip))
    const saved = await env.BUCKET.get(key)
    if (!saved) throw Error('Manifest cache write could not be verified')
    const verified = await loadManifest(env, { manifest_key: key })
    if (!verified.frameIds.length) throw Error('Manifest cache verification failed')
    await env.DB.prepare(
      'UPDATE recordings SET manifest_key=?,manifest_gzip=NULL WHERE rid=? AND manifest_gzip=?',
    )
      .bind(key, row.rid, row.manifest_gzip)
      .run()
  }
  const state = await env.DB.prepare(
    'SELECT sum(search_version=0) AS search_remaining,sum(manifest_gzip IS NOT NULL) AS manifests_remaining FROM recordings',
  ).first()
  if (rows.results.length && !state.search_remaining)
    await env.DB.prepare("INSERT INTO transcripts(transcripts) VALUES('optimize')").run()
  return state
}
