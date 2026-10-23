import { defineConfig } from 'void/config'
export default defineConfig({
  worker: { compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'] },
  cloudflare: {
    name: 'uomi-web',
    d1_databases: [{ binding: 'DB', database_name: 'uomi', database_id: 'local-uomi' }],
    r2_buckets: [{ binding: 'BUCKET', bucket_name: 'uomi-audio' }],
  },
})
