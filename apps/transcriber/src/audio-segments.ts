import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { audioProcess } from './process'

/** FLAC STREAMINFO can retain the original duration even in a header-only segment. */
export async function nonEmptyAudioSegments(directory: string, signal: AbortSignal) {
  const names = (await readdir(directory)).filter((name) => /^chunk-\d+\.flac$/.test(name)).sort()
  const files: string[] = []
  let emptyTail = false
  for (const name of names) {
    const output = await audioProcess(
      [
        'ffprobe',
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-count_packets',
        '-show_entries',
        'stream=codec_name,nb_read_packets',
        '-of',
        'json',
        join(directory, name),
      ],
      signal,
    )
    const stream = JSON.parse(output).streams?.[0]
    if (!stream || stream.codec_name !== 'flac') throw Error(`Invalid FLAC segment: ${name}`)
    // ffprobe omits nb_read_packets (or reports N/A) when no packets were read.
    const packets =
      stream.nb_read_packets == null || stream.nb_read_packets === 'N/A'
        ? 0
        : Number(stream.nb_read_packets)
    if (!Number.isSafeInteger(packets) || packets < 0)
      throw Error(`Invalid audio packet count: ${name}`)
    if (packets === 0) {
      emptyTail = true
      continue
    }
    // Never renumber real audio or reuse checkpoints against shifted timeline offsets.
    if (emptyTail) throw Error('Empty audio segment before remaining source audio.')
    files.push(name)
  }
  if (!files.length) throw Error('No audio frames decoded.')
  return files
}
