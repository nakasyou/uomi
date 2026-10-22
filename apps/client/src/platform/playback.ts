import { NativeModules } from 'react-native'
import type { Frame } from '../core/types'
import { muxAudio } from './mux'
import { Buffer } from 'buffer'
let generation = 0
export async function playAudio(frames: Frame[]): Promise<void> {
  stopPlayback()
  const request = generation
  const bytes = await muxAudio(frames)
  if (request !== generation) return
  await NativeModules.Uomi.playAudio(Buffer.from(bytes).toString('base64'))
}
export function stopPlayback() {
  generation++
  void NativeModules.Uomi.stopAudio()
}
