let active = 0
const waiting: (() => void)[] = []
export async function workerSlot<T>(task: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    const start = () => {
      active++
      resolve()
    }
    if (active < 2) start()
    else waiting.push(start)
  })
  try {
    return await task()
  } finally {
    active--
    waiting.shift()?.()
  }
}
