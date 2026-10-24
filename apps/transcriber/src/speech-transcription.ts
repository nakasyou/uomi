import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { readFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { TranscribeOptions, Transcription } from '@nakasyou/ntranscribe'
import { audioProcess } from './process'
import { saveCheckpoint } from './checkpoint'
import {
  normalizeSpeechPlan,
  offsetSpeechSegments,
  speechPlanFingerprint,
  longSpeechSlices,
  LONG_SPEECH_GAP_MS,
  type SpeechPlan,
} from './speech-plan'

import type { ProgressDetail } from './progress'
type Stage = (stage: string, progress: number, detail?: ProgressDetail) => Promise<void>
export async function transcribeSpeech(options: {
  audioPath: string
  directory: string
  stateDir: string
  helper: string
  audioSha: string
  recordingId: string
  mode: string
  language: string
  durationMs: number
  splitSeconds: number
  timeoutMs: number
  signal: AbortSignal
  analyze: <T>(work: () => Promise<T>) => Promise<T>
  recognize: (
    path: string,
    options: TranscribeOptions,
    signal: AbortSignal,
    onStart?: () => Promise<void>,
  ) => Promise<Transcription>
  stage: Stage
}) {
  const { signal, directory } = options
  const wav = join(directory, 'source.wav')
  await options.stage('decoding', 0)
  await audioProcess(
    [
      'ffmpeg',
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      options.audioPath,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_f32le',
      wav,
    ],
    signal,
  )
  // The deployed helper path is content-addressed by Nix, including model/config revisions.
  const cacheId = createHash('sha256')
    .update(JSON.stringify([options.audioSha, options.helper, 'fluid-v1']))
    .digest('hex')
  const cache = join(options.stateDir, `plan-${cacheId}.json`)
  let plan: SpeechPlan
  try {
    if ((await stat(cache)).size > 8 * 1024 * 1024)
      throw Error('Speech plan cache exceeds size limit')
    plan = normalizeSpeechPlan(JSON.parse(await readFile(cache, 'utf8')), options.durationMs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw Error(`Cannot read speech plan: ${String(error)}`)
    await options.stage('waiting_analysis', 0)
    plan = await options.analyze(async () => {
      await options.stage('diarizing', 0)
      const output = join(directory, 'speech.json')
      const analysisCancellation = new AbortController()
      const analysisSignal = AbortSignal.any([signal, analysisCancellation.signal])
      let updates = Promise.resolve()
      await audioProcess(
        [options.helper, '--input', wav, '--output', output],
        analysisSignal,
        Math.max(180000, Math.min(1800000, options.durationMs * 2)),
        (progress) => {
          updates = updates.then(() =>
            options.stage('diarizing', progress * 0.2, {
              analyzed_ms: Math.round(progress * options.durationMs),
              duration_ms: Math.round(options.durationMs),
            }),
          )
          // The original rejection is awaited below; cancellation also stops inference promptly.
          void updates.catch((error) => analysisCancellation.abort(error))
        },
      )
      await updates
      if ((await stat(output)).size > 8 * 1024 * 1024)
        throw Error('FluidAudio output exceeds size limit')
      const raw = JSON.parse(await readFile(output, 'utf8'))
      const normalized = normalizeSpeechPlan(
        { ...raw, engine: raw.engine ?? raw.engine_version },
        options.durationMs,
      )
      if (!normalized.engine)
        throw Error('FluidAudio helper did not identify its engine/model version')
      await saveCheckpoint(cache, normalized, signal)
      return normalized
    })
  }
  // Standard keeps speech/speaker boundaries; long mode retains short source pauses.
  const slices =
    options.mode === 'long'
      ? longSpeechSlices(plan, options.splitSeconds * 1000)
      : plan.segments.flatMap((segment) => {
          const parts = []
          for (
            let start = segment.start_ms;
            start < segment.end_ms;
            start += options.splitSeconds * 1000
          )
            parts.push({
              ...segment,
              start_ms: start,
              end_ms: Math.min(segment.end_ms, start + options.splitSeconds * 1000),
            })
          return parts
        })
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        options.recordingId,
        options.mode,
        options.audioSha,
        options.language,
        options.splitSeconds,
        speechPlanFingerprint(plan, plan.engine!),
        'fluid-asr-v2-streaming',
        ...(options.mode === 'long' ? ['long-v1', LONG_SPEECH_GAP_MS] : []),
      ]),
    )
    .digest('hex')
  const checkpoint = join(options.stateDir, `api-${fingerprint}.json`)
  let results: (Transcription | null)[] = slices.map(() => null)
  try {
    const saved = JSON.parse(await readFile(checkpoint, 'utf8'))
    if (
      !Array.isArray(saved) ||
      saved.length !== slices.length ||
      saved.some((value) => value !== null && (!value || typeof value.text !== 'string'))
    )
      throw Error('Speech checkpoint does not match plan')
    results = saved
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw Error(`Cannot read speech checkpoint: ${String(error)}`)
  }
  let next = 0,
    completed = results.filter(Boolean).length
  let writes = Promise.resolve()
  const active = new Map<number, NonNullable<ProgressDetail['active']>[number]>()
  const report = () =>
    options.stage('transcribing', 0.2 + 0.75 * (slices.length ? completed / slices.length : 1), {
      completed,
      total: slices.length,
      active: [...active.values()].sort((a, b) => a.index - b.index),
    })
  const cancellation = new AbortController()
  const workSignal = AbortSignal.any([signal, cancellation.signal])
  await report()
  const work = async () => {
    for (;;) {
      workSignal.throwIfAborted()
      const index = next++
      if (index >= slices.length) return
      if (results[index]) continue
      const slice = slices[index],
        path = join(directory, `speech-${index}.flac`)
      try {
        await audioProcess(
          [
            'ffmpeg',
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-ss',
            String(slice.start_ms / 1000),
            '-i',
            wav,
            '-t',
            String((slice.end_ms - slice.start_ms) / 1000),
            '-c:a',
            'flac',
            path,
          ],
          workSignal,
        )
        let recognized: Transcription | undefined
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            active.set(index, {
              index: index + 1,
              start_ms: slice.start_ms,
              end_ms: slice.end_ms,
              attempt: attempt + 1,
              state: 'waiting',
            })
            await report()
            recognized = await options.recognize(
              path,
              {
                provider: 'chrome-recognizetion',
                language: options.language,
                timeoutMs: options.timeoutMs,
                splitSeconds: options.splitSeconds,
              },
              workSignal,
              async () => {
                active.get(index)!.state = 'transcribing'
                await report()
              },
            )
            break
          } catch (error) {
            workSignal.throwIfAborted()
            const status = (error as { status?: number }).status
            const pairingFailure =
              status === 400 && /(?:matching pair ID|pair ID is not unique)/i.test(String(error))
            if (
              attempt === 2 ||
              !(pairingFailure || status === 429 || (status != null && status >= 500))
            )
              throw error
            active.get(index)!.state = 'retrying'
            await report()
            await delay(500 * 2 ** attempt, undefined, { signal: workSignal })
          }
        }
        signal.throwIfAborted()
        if (typeof recognized?.text !== 'string')
          throw Error('Chrome recognition returned an invalid transcript')
        results[index] = {
          text: recognized.text,
          ...(Array.isArray(recognized.segments) ? { segments: recognized.segments } : {}),
        }
        const snapshot = [...results]
        writes = writes.then(() => saveCheckpoint(checkpoint, snapshot, signal))
        await writes
        completed++
        active.delete(index)
        await report()
      } catch (error) {
        cancellation.abort(error)
        throw error
      } finally {
        await rm(path, { force: true })
      }
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(2, slices.length) }, work))
  const failed = workers.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  await writes
  const segments =
    options.mode === 'long'
      ? []
      : results.flatMap((result, index) => {
          if (!result?.text.trim()) return []
          const slice = slices[index]
          return Array.isArray(result.segments) && result.segments.length
            ? offsetSpeechSegments(result.segments, slice)
            : [{ ...slice, text: result.text.trim() }]
        })
  if (segments.length > 20000) throw Error('Transcription exceeds the 20000-segment API limit')
  return {
    checkpoint,
    outcome: (slices.length === 0
      ? 'no_speech'
      : results.some((result) => result?.text.trim())
        ? 'transcribed'
        : 'empty') as 'no_speech' | 'transcribed' | 'empty',
    text: results
      .map((result) => result?.text.trim())
      .filter(Boolean)
      .join('\n'),
    segments,
  }
}
