import { cpSync, mkdirSync, rmSync } from 'node:fs'
rmSync('dist/server', { recursive: true, force: true })
cpSync('dist/ssr', 'dist/server', { recursive: true })
mkdirSync('dist/.openai', { recursive: true })
cpSync('.openai/hosting.json', 'dist/.openai/hosting.json')
