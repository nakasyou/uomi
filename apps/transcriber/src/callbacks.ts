import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
export interface SitesCallback { url: string; accessToken: string }
export class CompletionOutbox {
  private flushing = false
  private delivery: Promise<void> | undefined
  constructor(private directory: string, private config: SitesCallback | undefined, private secret: string, private ready: (id: string) => Promise<boolean>, private fetcher: typeof fetch = fetch) {}
  async enqueue(id: string) {
    if (!this.config) return
    if (!/^[a-f0-9]{32}$/i.test(id)) throw Error('Invalid callback page ID')
    await mkdir(this.directory,{recursive:true,mode:0o700})
    const path=join(this.directory,id+'.json')
    try { JSON.parse(await readFile(path,'utf8')); return }
    catch (e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT' && !(e instanceof SyntaxError)) throw e }
    const temporary=path+`.${crypto.randomUUID()}.tmp`
    await writeFile(temporary,JSON.stringify({attempts:0,nextAt:0}),{mode:0o600})
    await rename(temporary,path)
  }
  async discard(id: string) {
    if (!/^[a-f0-9]{32}$/i.test(id)) throw Error('Invalid callback page ID')
    await rm(join(this.directory,id+'.json'),{force:true})
  }
  flush(limit=4): Promise<void> {
    if (this.delivery) return this.delivery
    const work=this.deliver(limit)
    this.delivery=work
    void work.finally(()=>{this.delivery=undefined}).catch(()=>{})
    return work
  }
  private async deliver(limit: number) {
    if (!this.config || this.flushing) return
    this.flushing = true
    try {
      let files: string[]
      try { files = await readdir(this.directory) } catch (e) { if ((e as NodeJS.ErrnoException).code==='ENOENT') return; throw e }
      let attempted = 0
      for (const file of files.sort()) {
        if (!/^[a-f0-9]{32}\.json$/i.test(file) || attempted>=limit) continue
        const path=join(this.directory,file), state=JSON.parse(await readFile(path,'utf8'))
        if (state.nextAt>Date.now()) continue
        attempted++
        try {
          // Entries are persisted before the Notion commit for crash recovery.
          // Recheck canonical state on every delivery, including after restart.
          if (!(await this.ready(file.slice(0,-5)))) { attempted--; continue }
          const response=await this.fetcher(this.config.url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(25000),
            headers:{'Content-Type':'application/json','X-Uomi-Webhook-Secret':this.secret,'OAI-Sites-Authorization':`Bearer ${this.config.accessToken}`},body:JSON.stringify({pageId:file.slice(0,-5)})})
          if (response.status!==200) { await response.body?.cancel(); throw Error('Completion callback not committed') }
          const receipt=await response.json() as any
          if (receipt.saved!==true) throw Error('Invalid completion receipt')
          await rm(path)
        } catch {
          state.attempts++; state.nextAt=Date.now()+Math.min(300000,1000*2**Math.min(state.attempts,8))
          await writeFile(path+'.tmp',JSON.stringify(state),{mode:0o600});await rename(path+'.tmp',path)
          console.error(JSON.stringify({pageId:file.slice(0,-5),status:'Callback pending'}))
        }
      }
    } finally { this.flushing=false }
  }
}
export function sitesCallback(url: string | undefined, accessToken: string | undefined): SitesCallback | undefined {
  if (!url && !accessToken) return
  if (!url || !accessToken) throw Error('Set both SITES_URL and SITES_ACCESS_TOKEN for completion callbacks')
  const target=new URL(url)
  if (target.protocol!=='https:' || target.username || target.password || target.search || target.hash) throw Error('SITES_URL must be an HTTPS Site URL without credentials or query parameters')
  return {url:new URL('/api/transcriber/completed',target.origin).href,accessToken}
}
