import { NativeModules } from 'react-native'
import { Buffer } from 'buffer'
import type { Frame } from '../core/types'
export async function muxAudio(frames: Frame[]): Promise<Uint8Array> {
  const value = await NativeModules.Uomi.muxAudio(
    JSON.stringify(frames.map(({ data, durationMs }) => ({ data, durationMs }))),
  )
  return Buffer.from(value, 'base64')
}
