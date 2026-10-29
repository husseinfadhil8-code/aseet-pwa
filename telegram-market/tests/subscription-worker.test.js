import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker from '../worker.js';
import {touchUser} from '../src/platform.js';
import {syncSubscriptionContacts} from '../src/subscription-contact.js';
import {runScheduledNotifications} from '../src/notification-scheduler.js';
import {budgetFetch} from '../src/notification-budget.js';
import {WELCOME_MESSAGE,SUBSCRIPTION_PROMPT} from '../miniapp/subscription-copy.js';
const require=createRequire(import.meta.url),engine=require(process.env.WASEET_TEST_MINIFLARE||'miniflare');
const Miniflare=engine.Miniflare,convert=engine.convertV4MiniflareOptions||((options)=>options.workers[0]);
function signed(actor,token){const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:actor,first_name:'Synthetic user'})});const check=[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');p.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(token).digest()).update(check).digest('hex'));return p.toString()}

test('subscription Worker routes preserve real-start and shared onboarding invariants',async t=>{
 const mf=new Miniflare(convert({workers:[{name:'subscription-qa',modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['OPS'],compatibilityDate:'2026-10-01'}]})),original=globalThis.fetch;
 try{
  const OPS=await mf.getD1Database('OPS');
  for(const file of ['008_platform_d1.sql','009_cash_rewards_d1.sql','010_notification_center_d1.sql','012_outbox_bridge_d1.sql'])await OPS.exec(readFileSync('db/'+file,'utf8').replace(/^--.*$/gm,'').replace(/\n/g,' '));
  await OPS.prepare("INSERT OR REPLACE INTO tg_n_meta(key,value) VALUES('outbox_cutover','enabled')").run();
  const env={OPS,USER_NOTIFICATIONS:'true',NOTIFICATION_CENTER:'true',TELEGRAM_WEBHOOK_SECRET:'synthetic-hook',TELEGRAM_BOT_TOKEN:'synthetic-bot',SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only',OWNER_TELEGRAM_ID:'999'};
  const users=new Map(),events=[],sent=[];let nextMessage=1;
  function prefs(id){if(!users.has(id))users.set(id,{id:'00000000-0000-4000-8000-'+String(id).padStart(12,'0'),enabled:false,operational:false,categories:[],scope:'all',welcome_seen:false,onboarding_state:'unseen',bot_started:false});return users.get(id)}
  globalThis.fetch=async(input,options={})=>{
   const u=new URL(input),body=options.body?JSON.parse(options.body):{};
   if(u.hostname==='api.telegram.org'){
    events.push({kind:'telegram',method:u.pathname.split('/').at(-1),body});
    if(u.pathname.endsWith('/sendMessage')||u.pathname.endsWith('/editMessageText'))sent.push(body);
    return Response.json({ok:true,result:{message_id:nextMessage++}});
   }
   if(u.pathname==='/rest/v1/tg_market_users'){
    const id=Number(String(u.searchParams.get('telegram_id')).replace('eq.',''));events.push({kind:'read',id,exists:users.has(id),select:u.searchParams.get('select')});const p=users.get(id);return Response.json(p?[{id:p.id,role:'market',banned:false}]:[]);
   }
   if(u.pathname.endsWith('/rpc/tg_market_notify_contacts')){for(const c of body.p_contacts){const p=users.get(c.actor);if(p){p.bot_started=true;p.blocked=c.blocked}}events.push({kind:'contacts',body});return Response.json({synced:body.p_contacts.length})}
   if(u.pathname.endsWith('/rpc/tg_market_notifications')){
    const id=body.p_actor,p=prefs(id),op=body.p_operation;events.push({kind:'notification',id,op});
    if(op==='welcome_claim'){const show=!p.welcome_seen;p.welcome_seen=true;return Response.json({...p,show})}
    if(op==='onboarding_claim'){const show=p.onboarding_state==='unseen';if(show)p.onboarding_state='shown';return Response.json({...p,show})}
    if(op==='bot_seen'){p.bot_started=true;p.blocked=body.p_data.blocked}
    if(op==='onboarding_defer')p.onboarding_state='deferred';
    return Response.json(p);
   }
   throw Error('Unexpected mocked request '+u.pathname);
  };
  async function webhook(update){const pending=[],r=await worker.fetch(new Request('https://synthetic.example/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':env.TELEGRAM_WEBHOOK_SECRET},body:JSON.stringify(update)}),env,{waitUntil:p=>pending.push(p)});await Promise.all(pending);return r}
  const start=(id,update_id,text='/start')=>({update_id,message:{from:{id,first_name:'Synthetic user'},chat:{id,type:'private'},text}});
  async function api(id,operation,data={}){const pending=[],r=await worker.fetch(new Request('https://synthetic.example/api/notifications',{method:'POST',headers:{'content-type':'application/json','x-telegram-init-data':signed(id,env.TELEGRAM_BOT_TOKEN)},body:JSON.stringify({operation,data})}),env,{waitUntil:p=>pending.push(p)});await Promise.all(pending);return r}
  await t.test('a new referral is classified before account creation, with one short welcome and prompt',async()=>{
   const inviter=(await touchUser(env,100,{existing:false,fromStart:true})).user;
   assert.equal((await webhook(start(200,1,'/start ref_'+inviter.code))).status,200);
   const d1user=await OPS.prepare('SELECT known_market,started FROM tg_ops_users WHERE id=200').first();assert.equal(d1user.known_market,0);assert.equal(d1user.started,1);
   assert.equal((await OPS.prepare('SELECT inviter FROM tg_ops_referrals WHERE invitee=200').first()).inviter,100);
   const knownIndex=events.findIndex(e=>e.kind==='read'&&e.id===200&&e.select==='id'),createIndex=events.findIndex(e=>e.kind==='notification'&&e.id===200);assert.ok(knownIndex>=0&&createIndex>knownIndex);assert.equal(events[knownIndex].exists,false);
   assert.equal(sent.filter(m=>m.chat_id===200&&m.text===WELCOME_MESSAGE).length,1);assert.equal(sent.filter(m=>m.chat_id===200&&m.text===SUBSCRIPTION_PROMPT).length,1);assert.equal(prefs(200).bot_started,true);assert.equal(prefs(200).enabled,false);
  });
  await t.test('replayed update and later start do not repeat welcome or opt-in',async()=>{
   await webhook(start(200,1));await webhook(start(200,2));assert.equal(sent.filter(m=>m.chat_id===200&&m.text===WELCOME_MESSAGE).length,1);assert.equal(sent.filter(m=>m.chat_id===200&&m.text===SUBSCRIPTION_PROMPT).length,1);
  });
  await t.test('Mini App first-entry claims suppress the same bot welcome and subscription prompt',async()=>{
   const w=await api(300,'welcome_claim',{surface:'miniapp'}),o=await api(300,'onboarding_claim',{surface:'miniapp'});assert.equal((await w.json()).data.show,true);assert.equal((await o.json()).data.show,true);assert.equal(prefs(300).bot_started,false);
   await webhook(start(300,3));assert.equal((await OPS.prepare('SELECT known_market FROM tg_ops_users WHERE id=300').first()).known_market,1);assert.equal(sent.filter(m=>m.chat_id===300&&[WELCOME_MESSAGE,SUBSCRIPTION_PROMPT].includes(m.text)).length,0);
  });
  await t.test('defer survives the next entry and does not opt a user in',async()=>{
   const cb={update_id:4,callback_query:{id:'synthetic-callback',from:{id:200},data:'ns:later',message:{message_id:3,chat:{id:200,type:'private'}}}};await webhook(cb);await webhook(start(200,5));assert.equal(prefs(200).onboarding_state,'deferred');assert.equal(prefs(200).enabled,false);assert.equal(sent.filter(m=>m.chat_id===200&&m.text===SUBSCRIPTION_PROMPT).length,1);
  });
  await t.test('a verified block is mirrored, and an actual private restart clears it',async()=>{
   await webhook({update_id:6,my_chat_member:{chat:{id:200,type:'private'},new_chat_member:{status:'kicked'}}});assert.equal((await OPS.prepare('SELECT blocked FROM tg_ops_users WHERE id=200').first()).blocked,1);assert.equal(prefs(200).blocked,true);
   await webhook(start(200,7));assert.equal((await OPS.prepare('SELECT blocked FROM tg_ops_users WHERE id=200').first()).blocked,0);assert.equal(prefs(200).blocked,false);
  });
  await t.test('unstarted private commands and group messages cannot establish bot-start evidence',async()=>{
   await webhook(start(400,8,'/id'));assert.equal(users.has(400),false);assert.equal(await OPS.prepare('SELECT id FROM tg_ops_users WHERE id=400').first(),null);
   await webhook({update_id:9,message:{from:{id:500},chat:{id:-100123,type:'group'},text:'/start'}});assert.equal(users.has(500),false);assert.equal(await OPS.prepare('SELECT id FROM tg_ops_users WHERE id=500').first(),null);
  });
  await t.test('Mini App cannot forge trusted bot_seen operation or user identity',async()=>{
   const before=events.length,r=await api(600,'bot_seen',{actor:200,blocked:false});assert.equal(r.status,404);assert.equal(users.has(600),false);assert.equal(events.slice(before).filter(e=>e.kind==='notification').length,0);
  });
  await t.test('contact sync is inside the shared 44-request budget and rotates without queue loss',async()=>{
   const before=events.filter(e=>e.kind==='contacts').length;let workCalls=0;
   const output=await runScheduledNotifications(env,[{name:'contacts',minimum:1,run:e=>syncSubscriptionContacts(e)},{name:'large',minimum:1,run:async e=>{for(let i=0;i<60;i++){await budgetFetch(e,'https://api.telegram.org/botsynthetic-bot/getMe',{method:'POST',body:'{}'});workCalls++}}}]);
   assert.equal(events.filter(e=>e.kind==='contacts').length,before+1);assert.equal(output.requests,44);assert.equal(workCalls,43);assert.equal(output.stages[1].status,'deferred');assert.equal(prefs(200).enabled,false);
  });
 }finally{globalThis.fetch=original;await mf.dispose()}
});
