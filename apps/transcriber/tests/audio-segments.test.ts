import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audioProcess } from '../src/process'
import { nonEmptyAudioSegments } from '../src/audio-segments'

test('FLAC packet inspection keeps very short real audio and rejects missing or shifted audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uomi-segment-test-'))
  const signal = new AbortController().signal
  try {
    const path = join(directory, 'chunk-000000.flac')
    await audioProcess(
      [
        'ffmpeg',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=0.01',
        '-ar',
        '16000',
        path,
      ],
      signal,
    )
    const audio = await readFile(path)
    // Retain all metadata, including the nonzero STREAMINFO duration, but no frames.
    let offset = 4
    for (;;) {
      const last = Boolean(audio[offset] & 0x80)
      offset += 4 + audio.readUIntBE(offset + 1, 3)
      if (last) break
    }
    const headerOnly = audio.subarray(0, offset)
    await writeFile(join(directory, 'chunk-000001.flac'), headerOnly)
    expect(await nonEmptyAudioSegments(directory, signal)).toEqual(['chunk-000000.flac'])
    await writeFile(join(directory, 'chunk-000002.flac'), audio)
    await expect(nonEmptyAudioSegments(directory, signal)).rejects.toThrow(
      'before remaining source audio',
    )
    await rm(join(directory, 'chunk-000002.flac'))
    await writeFile(path, headerOnly)
    await expect(nonEmptyAudioSegments(directory, signal)).rejects.toThrow('No audio frames')
    const cancelled = new AbortController()
    cancelled.abort(Error('lease lost'))
    await expect(nonEmptyAudioSegments(directory, cancelled.signal)).rejects.toThrow('lease lost')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
