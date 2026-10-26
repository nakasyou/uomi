import { Buffer } from 'buffer'
import { putObject } from './object-storage.ts'
import type { AudioManifest } from '@uomi/notion'
export function compactManifest(manifest: AudioManifest) {
  const runs: (string | [string, number, number])[] = []
  for (const id of manifest.frameIds) {
    const m = /^(.*\D)(\d+)$/.exec(id)
    if (!m || !Number.isSafeInteger(+m[2]) || String(+m[2]) !== m[2]) {
      runs.push(id)
      continue
    }
    const last = runs.at(-1)
    if (Array.isArray(last) && last[0] === m[1] && last[1] + last[2] === +m[2]) last[2]++
    else runs.push([m[1], +m[2], 1])
  }
  const { frameIds: _frameIds, ...rest } = manifest
  return { ...rest, cache_format: 2, frame_runs: runs }
}
export function expandManifest(value: any): AudioManifest {
  if (value.cache_format !== 2) return value
  const { cache_format: _cacheFormat, frame_runs, ...rest } = value
  const frameIds: string[] = []
  for (const run of frame_runs) {
    if (typeof run === 'string') frameIds.push(run)
    else {
      if (!Number.isSafeInteger(run[2]) || run[2] <= 0 || frameIds.length + run[2] > 360000)
        throw Error('Invalid cached frame run')
      for (let i = 0; i < run[2]; i++) frameIds.push(run[0] + (run[1] + i))
    }
  }
  return { ...rest, frameIds }
}
export async function unpackManifest(value: any): Promise<AudioManifest> {
  const data = await new Response(
    new Blob([new Uint8Array(value)]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).json()
  return expandManifest(data)
}
export async function saveManifest(env: any, manifest: AudioManifest) {
  const data = await new Response(
    new Blob([JSON.stringify(compactManifest(manifest))])
      .stream()
      .pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer()
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', data)).toString('hex')
  const key = `manifests/${hash}.json.gz`
  await putObject(env.BUCKET, key, data, { httpMetadata: { contentType: 'application/gzip' } })
  return key
}
export async function loadManifest(env: any, row: any) {
  if (row.manifest_key) {
    const object = await env.BUCKET.get(row.manifest_key)
    if (object) {
      const data = await object.arrayBuffer()
      const hash = Buffer.from(await crypto.subtle.digest('SHA-256', data)).toString('hex')
      if (row.manifest_key !== `manifests/${hash}.json.gz`)
        throw Error('Manifest cache hash mismatch')
      return unpackManifest(data)
    }
  }
  if (row.manifest_gzip) return unpackManifest(row.manifest_gzip)
  throw Error('Manifest cache is missing; resync this recording from Notion')
}
