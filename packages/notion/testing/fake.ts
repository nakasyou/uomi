import { randomUUID } from 'node:crypto'
import { Buffer } from 'buffer'
import { schema, type Transport } from '../src/index'
export const SOURCE = '11111111111111111111111111111111'
export class FakeNotion {
  pages = new Map<string, any>()
  files = new Map<string, Uint8Array>()
  requests: any[] = []
  failAttach = false
  title = 'Name'
  transport: Transport = async (req) => {
    this.requests.push(req)
    if (req.path === `/data_sources/${SOURCE}`)
      return {
        id: SOURCE,
        properties: Object.fromEntries(
          Object.entries(schema).map(([k, v]) => [k, { ...v, type: Object.keys(v)[0] }]),
        ),
      }
    if (req.path === '/users/me')
      return { bot: { workspace_limits: { max_file_upload_size_in_bytes: 64 * 1024 * 1024 } } }
    if (req.path.startsWith('/file_uploads/') && req.method === 'GET') {
      const id = req.path.split('/')[2]
      return { id, status: this.files.has(id) ? 'uploaded' : 'expired', expiry_time: null }
    }
    if (req.path === '/file_uploads') {
      const id = randomUUID()
      return { id }
    }
    if (req.path.endsWith('/send')) {
      const id = req.path.split('/')[2]
      this.files.set(id, Buffer.from(req.upload!.base64, 'base64'))
      return { id, status: 'uploaded' }
    }
    if (req.path.endsWith('/complete')) return {}
    if (req.path.endsWith('/query')) {
      const filter = (req.body as any)?.filter
      const matches = (page: any, f: any): boolean => {
        if (!f) return true
        if (f.and) return f.and.every((part: any) => matches(page, part))
        if (f.or) return f.or.some((part: any) => matches(page, part))
        if (f.timestamp) {
          const value = Date.parse(page[f.timestamp] ?? '2026-01-01T00:00:00Z')
          const range = f[f.timestamp]
          return (
            (!range.on_or_after || value >= Date.parse(range.on_or_after)) &&
            (!range.before || value < Date.parse(range.before))
          )
        }
        const property = page.properties[f.property]
        if (f.rich_text) return property?.rich_text?.[0]?.text?.content === f.rich_text.equals
        if (f.select) return property?.select?.name === f.select.equals
        return true
      }
      const pages = [...this.pages.values()].filter(
        (page) => !!page.archived === !!(req.body as any)?.is_archived && matches(page, filter),
      )
      const offset = Number((req.body as any)?.start_cursor ?? 0)
      const results = pages.slice(offset, offset + 100)
      return {
        results: structuredClone(results),
        has_more: offset + 100 < pages.length,
        next_cursor: offset + 100 < pages.length ? String(offset + 100) : null,
      }
    }
    if (req.path === '/pages') {
      const body = req.body as any
      const id = randomUUID()
      const page = {
        id,
        url: `https://www.notion.so/${id}`,
        parent: body.parent,
        created_time: new Date().toISOString(),
        last_edited_time: new Date().toISOString(),
        properties: structuredClone(body.properties),
      }
      this.pages.set(id, page)
      return structuredClone(page)
    }
    if (req.path.startsWith('/pages/')) {
      const page =
        this.pages.get(req.path.split('/')[2]) ??
        [...this.pages.values()].find((p) => p.id.replace(/-/g, '') === req.path.split('/')[2])
      if (!page) throw Error('Notion HTTP 404')
      if (req.method === 'PATCH') {
        if ((req.body as any).archived !== undefined) page.archived = (req.body as any).archived
        const properties = structuredClone((req.body as any).properties ?? {})
        page.last_edited_time = new Date().toISOString()
        if (this.failAttach && properties.Audio) throw Error('Notion HTTP 503')
        for (const property of Object.values<any>(properties))
          for (const file of property.files ?? [])
            if (file.file_upload)
              file.file = { url: `https://files.example/${file.file_upload.id}` }
        Object.assign(page.properties, properties)
      }
      return structuredClone(page)
    }
    throw Error(`Unexpected fake request: ${req.path}`)
  }
  attachment = async (
    pageId: string,
    property: 'Manifest' | 'Transcript' | 'Detailed transcript' | 'Long transcript',
  ) => {
    const page = this.pages.get(pageId)!
    const file = page.properties[property].files[0]
    return Buffer.from(this.files.get(file.file_upload.id)!).toString()
  }
}
