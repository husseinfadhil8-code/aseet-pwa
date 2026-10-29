import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {notificationContent,notificationAction,processNotifications} from '../src/notifications.js';
const id='11111111-1111-4111-8111-111111111111';
const env={TELEGRAM_BOT_TOKEN:'synthetic',SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic'};
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch});
test('user delivery test is visibly a test and offers no implicit marketing opt-in',()=>{
 const content=notificationContent({kind:'test_user'});
 assert.match(content.text,/اختبار/);
 assert.match(content.text,/طلبتها لحسابك/);
 assert.match(content.text,/إعدادات Telegram والجهاز/);
 assert.equal(content.reply_markup.inline_keyboard.flat().filter(b=>b.callback_data).length,0);
 assert.match(content.reply_markup.inline_keyboard[0][0].url,/startapp=account$/);
});
test('signed self-service operations cannot expose trusted bot-contact or worker methods',async()=>{
 const operations=[];
 globalThis.fetch=async(url,options)=>{assert.match(String(url),/\/rpc\/tg_market_notifications$/);const args=JSON.parse(options.body);operations.push(args.p_operation);assert.equal(args.p_actor,19);assert.equal(args.p_admin,false);return Response.json({state:'sent',telegram_message_id:321})};
 for(const operation of ['welcome_claim','onboarding_claim','onboarding_enable','onboarding_defer','onboarding_filter','user_test','user_test_status']){
  const result=await notificationAction(env,{id:19,name:'صاحب الطلب'},operation,{request:id,confirmed:true});
  assert.equal(result.telegram_message_id,321);
 }
 assert.equal(operations.length,7);
 for(const operation of ['bot_seen','bot_enable','tg_market_notify_contacts','claim','test_user','activate','finish'])await assert.rejects(()=>notificationAction(env,{id:19},operation),error=>error.message==='not_found');
 assert.equal(operations.length,7);
});
test('self-service test uses the existing queue and records Telegram acceptance once',async()=>{
 let claimCount=0,sendCount=0,ack;
 globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);
  if(String(url).includes('/rpc/')){
   if(body.p_operation==='finish')ack=body.p_data;
   return Response.json(body.p_operation==='claim'&&claimCount++===0?{id:'queue',lease:'lease',chat:19,kind:'test_user'}:body.p_operation==='validate'?{valid:true}:{});
  }
  assert.ok(String(url).endsWith('/sendMessage'));
  assert.equal(body.chat_id,19);assert.match(body.text,/طلبتها لحسابك/);
  assert.equal(body.reply_markup.inline_keyboard.flat().some(button=>button.callback_data),false);
  sendCount++;return Response.json({ok:true,result:{message_id:321}});
 };
 assert.equal((await processNotifications(env,{limit:2})).sent,1);
 assert.equal(sendCount,1);assert.equal(ack.outcome,'sent');assert.equal(ack.message,321);
});
test('database outage causes no Telegram request and a later tick can deliver the same queued test',async()=>{
 let offline=true,sends=0;
 globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);
  if(String(url).includes('/rpc/')){
   if(offline)return Response.json({message:'database temporary outage'},{status:503});
   return Response.json(body.p_operation==='claim'?{id:'same-queue',lease:'lease',chat:19,kind:'test_user'}:body.p_operation==='validate'?{valid:true}:{});
  }
  sends++;return Response.json({ok:true,result:{message_id:321}});
 };
 await assert.rejects(()=>processNotifications(env,{limit:1}),error=>error.message==='database_unavailable');
 assert.equal(sends,0);
 offline=false;
 assert.equal((await processNotifications(env,{limit:1})).sent,1);assert.equal(sends,1);
});
test('Telegram throttling preserves retry and subsequent acceptance for the same self-service queue',async()=>{
 let throttled=true;const acks=[];
 globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);
  if(String(url).includes('/rpc/')){
   if(body.p_operation==='finish')acks.push(body.p_data);
   return Response.json(body.p_operation==='claim'?{id:'same-queue',lease:throttled?'lease-a':'lease-b',chat:19,kind:'test_user'}:body.p_operation==='validate'?{valid:true}:{});
  }
  return throttled?Response.json({ok:false,error_code:429,parameters:{retry_after:47}},{status:429}):Response.json({ok:true,result:{message_id:321}});
 };
 await processNotifications(env,{limit:1});assert.equal(acks[0].outcome,'rate_limited');assert.equal(acks[0].retry_after,47);
 throttled=false;
 assert.equal((await processNotifications(env,{limit:1})).sent,1);assert.equal(acks[1].id,acks[0].id);assert.equal(acks[1].message,321);
});
test('ambiguous Telegram response is retained for review rather than claimed as accepted',async()=>{
 let ack;
 globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);
  if(String(url).includes('/rpc/')){
   if(body.p_operation==='finish')ack=body.p_data;
   return Response.json(body.p_operation==='claim'?{id:'queue',lease:'lease',chat:19,kind:'test_user'}:body.p_operation==='validate'?{valid:true}:{});
  }
  throw new Error('response lost after remote acceptance is possible');
 };
 const summary=await processNotifications(env,{limit:1});assert.equal(summary.sent,0);assert.equal(summary.review,1);assert.equal(ack.outcome,'review');assert.equal(ack.message,undefined);
});
test('a lost database ACK after Telegram acceptance leaves no automatic in-process repeat',async()=>{
 let sends=0;
 globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);
  if(String(url).includes('/rpc/')){
   if(body.p_operation==='finish')return Response.json({message:'database temporarily unavailable'},{status:503});
   return Response.json(body.p_operation==='claim'?{id:'queue',lease:'lease',chat:19,kind:'test_user'}:body.p_operation==='validate'?{valid:true}:{});
  }
  sends++;return Response.json({ok:true,result:{message_id:321}});
 };
 await assert.rejects(()=>processNotifications(env,{limit:2}),error=>error.message==='database_unavailable');assert.equal(sends,1);
});
test('Telegram block is recorded in shared D1 contact state before the durable queue finish',async()=>{
 const calls=[];
 const OPS={prepare(sql){
  assert.equal(sql,'UPDATE tg_ops_users SET blocked=1,marketing=0 WHERE id=?');
  return {bind(actor){
   assert.equal(actor,19);
   return {async run(){calls.push('block');return {meta:{changes:1}}}};
  }};
 }};
 globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);
  if(String(url).includes('/rpc/')){
   if(body.p_operation==='finish'){assert.equal(body.p_data.outcome,'blocked');calls.push('finish')}
   return Response.json(body.p_operation==='claim'?{id:'queue',lease:'lease',chat:19,kind:'test_user'}:body.p_operation==='validate'?{valid:true}:{});
  }
  return Response.json({ok:false,error_code:403},{status:403});
 };
 assert.equal((await processNotifications({...env,OPS},{limit:1})).failed,1);assert.deepEqual(calls,['block','finish']);
});
test('test recipient ad preview retains approved ad metadata and opens exact listing',()=>{
 const content=notificationContent({kind:'test_user',listing:id,title:'كرسي اختبار القراءة',price:7500,area:'بغداد · الكرادة',description:'غرض معتمد للمعاينة'});
 assert.match(content.text,/اختبار/);assert.ok(content.text.includes('كرسي اختبار القراءة'));
 assert.ok(content.text.includes(Number(7500).toLocaleString('ar-IQ')+' د.ع'));
 assert.ok(content.text.includes('بغداد · الكرادة'));
 assert.match(content.reply_markup.inline_keyboard[0][0].url,new RegExp('startapp=ad_'+id+'$'));
 assert.equal(content.reply_markup.inline_keyboard.flat().filter(b=>b.callback_data).length,0);
});
test('ordinary listing and radar deliveries still contain no user private message text',()=>{
 for(const kind of ['listing','radar']){
  const content=notificationContent({kind,listing:id,title:'خزانة',price:99000,area:'بابل · الحلة',description:'وصف الإعلان',body:'private thread body must not appear'});
  assert.ok(!content.text.includes('private thread body'));
  assert.match(content.reply_markup.inline_keyboard[0][0].url,new RegExp('startapp=ad_'+id+'$'));
 }
});
