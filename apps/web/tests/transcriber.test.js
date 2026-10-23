import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './helpers.js'
import app from '../worker/app.ts'
import {notifyTranscriber,flushNotifications} from '../worker/transcriber.ts'
const secret='test-webhook-secret-at-least-24-characters'
const pageId='a'.repeat(32), source='b'.repeat(32)
test('outgoing notification is durable, retried and acknowledged without losing source save state',async()=>{
 const f=fixture(), original=globalThis.fetch
 Object.assign(f.env,{TRANSCRIBER_WEBHOOK_URL:'https://daemon.test/webhook',UOMI_WEBHOOK_SECRET:secret})
 f.sqlite.prepare("INSERT INTO recordings(id,edited_at,device,status,url,text,backup_step,backup_page) VALUES('record','now','omi','Pending','','','done',?)").run(pageId)
 let calls=0
 globalThis.fetch=async(url,init)=>{
  calls++;assert.equal(String(url),'https://daemon.test/webhook');assert.equal(init.redirect,'manual')
  assert.equal(init.headers.Authorization,`Bearer ${secret}`);assert.deepEqual(JSON.parse(init.body),{pageId})
  return calls===1?new Response('',{status:503}):Response.json({accepted:false},{status:202})
 }
 try{
  assert.deepEqual(await notifyTranscriber(f.env,'record'),{delivered:false})
  assert.equal(f.sqlite.prepare('SELECT attempts FROM transcriber_notifications').get().attempts,1)
  assert.equal(f.sqlite.prepare('SELECT backup_step FROM recordings').get().backup_step,'done')
  f.sqlite.exec('UPDATE transcriber_notifications SET next_attempt=0')
  await flushNotifications(f.env)
  assert.ok(f.sqlite.prepare('SELECT delivered_at FROM transcriber_notifications').get().delivered_at)
  await notifyTranscriber(f.env,'record');assert.equal(calls,2)
 }finally{globalThis.fetch=original;f.sqlite.close()}
})
test('completion callback authenticates, reads canonical Notion and updates normalized FTS idempotently',async()=>{
 const f=fixture(), original=globalThis.fetch
 Object.assign(f.env,{UOMI_WEBHOOK_SECRET:secret,NOTION_TOKEN:'notion-secret',NOTION_DATA_SOURCE_ID:source})
 let completed=false
 const page={id:pageId,parent:{data_source_id:source},last_edited_time:'2026-10-23T00:00:00Z',url:'https://notion.so/test',properties:{
  'Recording ID':{rich_text:[{plain_text:'record'}]},Device:{rich_text:[{plain_text:'omi'}]},Status:{select:{name:'Completed'}},
  Transcript:{files:[{file:{url:'https://files.test/transcript'}}]},Name:{type:'title',title:[{plain_text:'Title'}]},
 }}
 globalThis.fetch=async(url)=>{
  const path=String(url)
  if(path.includes('/pages/'))return Response.json({...page,properties:{...page.properties,Status:{select:{name:completed?'Completed':'Pending'}}}})
  if(path.includes('/data_sources/'))return Response.json({id:source})
  if(path==='https://files.test/transcript')return Response.json({schema:'uomi.transcript.v1',text:'学校 生活とｼｽﾃﾑ'})
  throw Error('Unexpected outbound request')
 }
 const request=(key=secret)=>new Request('https://uomi.test/api/transcriber/completed',{method:'POST',headers:{'X-Uomi-Webhook-Secret':key},body:JSON.stringify({pageId})})
 try{
  assert.equal((await app.fetch(request('bad'),f.env,f.ctx)).status,401)
  assert.equal((await app.fetch(request(),f.env,f.ctx)).status,400)
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM recordings').get().n,0)
  completed=true
  const r=await app.fetch(request(),f.env,f.ctx);assert.equal(r.status,200);assert.equal((await r.json()).saved,true)
  assert.equal((await app.fetch(request(),f.env,f.ctx)).status,200)
  const row=f.sqlite.prepare('SELECT * FROM recordings').get()
  assert.equal(row.text,'学校 生活とｼｽﾃﾑ');assert.equal(row.search_text,'学校生活としすてむ')
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM recordings').get().n,1)
  const response=await app.fetch(new Request('https://uomi.test/api/recordings?q='+encodeURIComponent('システム'),{headers:{'oai-authenticated-user-id':'owner'}}),f.env,f.ctx)
  assert.equal((await response.json()).results[0].id,'record')
  await Promise.all(f.tasks)
 }finally{globalThis.fetch=original;f.sqlite.close()}
})
