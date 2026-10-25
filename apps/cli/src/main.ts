#!/usr/bin/env bun
import { run } from './cli.ts'

if (import.meta.main) {
  // Stop quietly when the reader goes away (`uomi transcripts ... | head`).
  for (const stream of [process.stdout, process.stderr])
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') process.exit(0)
      throw error
    })
  const code = await run(process.argv.slice(2))
  if (code) process.exitCode = code
}
