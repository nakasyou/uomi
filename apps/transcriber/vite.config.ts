import { defineConfig } from 'vite-plus'
export default defineConfig({
  pack: {
    deps: { neverBundle: ['bun:sqlite'] },
    entry: ['src/index.ts'],
    dts: false,
    format: ['esm'],
    sourcemap: true,
  },
})
