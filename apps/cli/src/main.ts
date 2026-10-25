#!/usr/bin/env bun
import { run } from './cli.ts'

if (import.meta.main) {
  const code = await run(process.argv.slice(2))
  if (code) process.exitCode = code
}
