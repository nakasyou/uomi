import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
process.chdir(root)
const portAt = process.argv.indexOf('--port')
const server = await createServer({
  root,
  server: {
    host: '0.0.0.0',
    port: portAt < 0 ? 4173 : Number(process.argv[portAt + 1]),
    strictPort: true,
  },
})
await server.listen()
server.printUrls()
