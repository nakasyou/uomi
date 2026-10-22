import { AppRegistry, NativeModules } from 'react-native'
import App from './src/ui/App'
import { getEngine } from './src/platform/runtime'
AppRegistry.registerComponent('Uomi', () => App)
AppRegistry.registerHeadlessTask('UomiSync', () => async () => {
  const e = getEngine()
  try {
    await e.init()
    await e.sync('periodic')
    await NativeModules.Uomi.finishPeriodic(!e.getSnapshot().error)
  } catch {
    await NativeModules.Uomi.finishPeriodic(false)
  }
})
AppRegistry.registerHeadlessTask('UomiRealtime', () => async () => {
  const e = getEngine()
  await e.init()
  while (e.getSnapshot().settings.mode === 'realtime') {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
})
