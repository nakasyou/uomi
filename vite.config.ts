import { defineConfig } from 'vite-plus'
export default defineConfig({
  fmt: { semi: false, singleQuote: true },
  lint: {
    ignorePatterns: ['**/node_modules/**', '**/dist/**', '**/target/**', '.codex-artifacts/**'],
    rules: { 'no-empty': 'off', 'no-control-regex': 'off' },
  },
})
