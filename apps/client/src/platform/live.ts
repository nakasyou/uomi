import { NativeModules } from 'react-native'
import type { Frame } from '../core/types'
export async function startLiveAudio(onError: (error: Error) => void) {
  await NativeModules.Uomi.startLiveAudio()
  let active = true
  let inFlight = 0
  return {
    push(frame: Frame) {
      if (!active || inFlight > 20) return
      inFlight++
      void NativeModules.Uomi.pushLiveAudio(frame.data, frame.durationMs)
        .catch((error: Error) => {
          if (active) onError(error)
        })
        .finally(() => {
          inFlight--
        })
    },
    stop() {
      active = false
      void NativeModules.Uomi.stopLiveAudio()
    },
  }
}
