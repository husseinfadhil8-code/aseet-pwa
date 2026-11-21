import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, event, req } from './helpers.mjs';
import { receive, drain, itemView } from '../src/memory.mjs';
import { open } from '../src/security.mjs';
import worker from '../src/worker.mjs';
const require = createRequire(import.meta.url);
const sdk = process.env.MANDOB_LOCAL_SDK;
// Opt in to the installed SDK; default unit suite remains dependency-free.
test('native local D1: seller → budget search → private owner retrieval → dedup → availability', {skip: !sdk}, async () => {
  const {Miniflare,convertV4MiniflareOptions} = require(sdk + '/miniflare');
  const mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("local only")}}',compatibilityDate:'2026-11-20',d1Databases:{DB:'mandob-synthetic-memory'}}));
  try {
    const DB = await mf.getD1Database('DB');
    const parsed = spawnSync('python', ['-c', `import sqlite3,json,pathlib,sys
statements=[]
for p in sorted(pathlib.Path(sys.argv[1]).glob('*.sql')):
 s=''
 for line in p.read_text().splitlines(True):
  s+=line
  if sqlite3.complete_statement(s):
   statements.append(s);s=''
print(json.dumps(statements))`, fileURLToPath(new URL('../migrations',import.meta.url))], {encoding:'utf8'});
    assert.equal(parsed.status,0,parsed.stderr);
    for (const sql of JSON.parse(parsed.stdout)) await DB.prepare(sql).run();
    assert.equal((await DB.prepare('PRAGMA quick_check').first()).quick_check,'ok');
    const {env,sql:shim}=fixture(); shim.close(); env.DB=DB;
    await DB.prepare('INSERT INTO settings(page_id,replies,alerts,ai,photos) VALUES(?,1,1,0,0)').bind(env.PAGE_ID).run();
    env.AI={run(){throw new Error('AI must not run');}};
    const message=async e=>{await receive(env,e);await drain(env);};
    const sale=event('عندي تخم للبيع بسعر 300 ألف في المنصور','sale','222');
    await message(sale);
    let item=await DB.prepare("SELECT * FROM items WHERE title='تخم'").first();
    assert(item); assert.equal(item.price_iqd,300000); assert.equal(item.area,'المنصور');
    assert.equal(item.status,'unknown');assert.equal(item.last_confirmed,null);
    const originalId=item.id;
    await message(sale);await message(event(sale.message.text,'repeat','222'));
    assert.equal((await DB.prepare('SELECT count(*) n FROM items').first()).n,1);
    await message(event('تخم للبيع بسعر 400 ألف في المنصور','expensive','444'));
    await message(event('ثلاجة للبيع بسعر 200 ألف في المنصور','fridge','555'));
    await message(event('أريد تخم بميزانية 350 ألف','buyer','333'));
    const interests=(await DB.prepare('SELECT * FROM interests').all()).results;
    assert.equal(interests.length,1);assert.equal(interests[0].item_id,originalId);
    const admin=await worker.fetch(req(env,'/api/items?q='+encodeURIComponent('تخم')),env);
    assert.equal(admin.status,200);
    const natural = await worker.fetch(req(env,'/api/assistant','POST',{query:'منو صاحب التخم مال 300 ألف بالمنصور؟'}),env);
    assert.equal(natural.status,200);
    const answer=await natural.json();assert.equal(answer.items.length,1);assert.equal(answer.items[0].seller.psid,'222');
    env.ALLOW_AI='true';env.AI_DAILY_CALL_LIMIT='1';
    await DB.prepare('UPDATE settings SET ai=1 WHERE page_id=?').bind(env.PAGE_ID).run();
    env.AI={async run(model,input){assert.match(model,/gemma-4/);assert(!JSON.stringify(input).includes('psid'));return {response:JSON.stringify({ids:[originalId]})};}};
    const grounded=await worker.fetch(req(env,'/api/assistant','POST',{query:'منو صاحب التخم مال 300 ألف بالمنصور؟'}),env);
    const gd=await grounded.json();assert.equal(gd.engine,'gemma_grounded');assert.equal(gd.items[0].seller.psid,'222');
    env.ALLOW_AI='false';await DB.prepare('UPDATE settings SET ai=0 WHERE page_id=?').bind(env.PAGE_ID).run();
    const found=(await admin.json()).items.find(i=>i.id===originalId);
    assert.equal(found.seller.psid,'222');assert.equal(found.seller.name,null);assert.equal(found.inbox_url,null);
    assert.equal(found.conversation_id,item.conversation_id);
    assert.equal(found.availability_notice,'لم يتم تأكيد التوفر');
    for(const path of ['/api/items','/api/sellers','/api/interests','/api/settings']) {
      const r=await worker.fetch(new Request('https://mandob.test'+path,{headers:{Authorization:'Bearer 333'}}),env);
      assert.equal(r.status,401);
    }
    const denied=await worker.fetch(new Request('https://mandob.test/api/items/'+originalId,{method:'PATCH',headers:{Authorization:'Bearer 333','Content-Type':'application/json'},body:JSON.stringify({status:'available',confirmed:true})}),env);
    assert.equal(denied.status,401);
    const buyerMessage=await DB.prepare("SELECT e.id FROM events e JOIN messages m ON m.id=e.id WHERE m.intent='buyer'").first();
    const replies=(await DB.prepare("SELECT * FROM outbox WHERE kind='reply'").all()).results;
    const reply=replies.find(r=>r.id==='reply:'+buyerMessage.id);
    const payload=await open(env,reply.payload_cipher,env.PAGE_ID+':outbox:'+reply.id);
    assert.match(payload.text,/نتأكد/);assert(!payload.text.includes('222'));assert(!payload.text.includes(item.seller_id));
    const alerts=(await DB.prepare("SELECT * FROM outbox WHERE kind='alert'").all()).results;
    const alert=await open(env,alerts[0].payload_cipher,env.PAGE_ID+':outbox:'+alerts[0].id);
    assert.equal(alert.seller_id,item.seller_id);assert.equal(alert.status,'unknown');assert.equal(alert.last_confirmed,null);
    await message(event('بعده متوفر','availability','222'));
    item=await DB.prepare('SELECT * FROM items WHERE id=?').bind(originalId).first();
    assert.equal(item.status,'available');assert(item.last_confirmed>0);
    assert.equal((await itemView(env,item)).seller.psid,'222');
    assert.equal(item.price_iqd,300000);
    console.log('LOCAL_D1_MEMORY: 300000 IQD / المنصور; 350000 budget → one matching item; private owner 222; duplicate blocked; seller confirmation dated; AI/network sends=0');
  } finally {await mf.dispose();}
});
