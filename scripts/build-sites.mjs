import { spawnSync } from 'node:child_process'
import { cpSync, rmSync, mkdirSync } from 'node:fs'
const vp = new URL('../node_modules/vite-plus/bin/vp', import.meta.url)
for (const [cmd, args] of [
  [process.execPath, [vp.pathname, 'build']],
  [process.execPath, ['scripts/package-build.mjs']],
]) {
  const result = spawnSync(cmd, args, {
    cwd: new URL('../apps/web/', import.meta.url),
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true })
cpSync(new URL('../apps/web/dist/', import.meta.url), new URL('../dist/', import.meta.url), {
  recursive: true,
})
mkdirSync(new URL('../dist/.openai/', import.meta.url), { recursive: true })
cpSync(
  new URL('../apps/web/.openai/hosting.json', import.meta.url),
  new URL('../dist/.openai/hosting.json', import.meta.url),
)
