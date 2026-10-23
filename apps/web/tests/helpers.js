import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { Buffer } from 'buffer'
export function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  for (const name of ['0000_index.sql', '0001_primary.sql', '0002_compact.sql', '0003_transcription.sql'])
    sqlite.exec(readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8'))
  const DB = {
    prepare(sql) {
      let args = []
      return {
        bind(...v) {
          args = v.map((x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : x))
          return this
        },
        async first() {
          return sqlite.prepare(sql).get(...args) ?? null
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args) }
        },
        async run() {
          const r = sqlite.prepare(sql).run(...args)
          return { meta: { changes: r.changes } }
        },
      }
    },
    async batch(statements) {
      sqlite.exec('BEGIN')
      try {
        const values = []
        for (const s of statements) values.push(await s.run())
        sqlite.exec('COMMIT')
        return values
      } catch (e) {
        sqlite.exec('ROLLBACK')
        throw e
      }
    },
  }
  const files = new Map()
  const BUCKET = {
    async head(key) { return files.has(key) ? {} : null },
    async put(key, data) {
      files.set(key, Buffer.from(data))
    },
    async get(key) {
      const value = files.get(key)
      return value
        ? { body: value, size: value.length, httpEtag: '"test"', arrayBuffer: async () => value }
        : null
    },
  }
  const tasks = [],
    ctx = {
      waitUntil(task) {
        tasks.push(task)
      },
    }
  return { sqlite, env: { DB, BUCKET }, files, tasks, ctx }
}
