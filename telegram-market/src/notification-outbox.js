import {remainingRequests} from './notification-budget.js';
import {SafeError} from './services.js';
import {rpc} from './services.js';
export const outboxEnabled=env=>env.NOTIFICATION_OUTBOX==='true';
const call=async(env,name,args={})=>{
 for(let attempt=0;;attempt++){try{return await rpc({...env,NOTIFICATION_CENTER:'false'},'notification_outbox_'+name,args)}catch(error){if(!['queued','health'].includes(name)||attempt>=1||remainingRequests(env)<2||!['database_network','database_timeout','database_unavailable','database_invalid_json'].includes(error.message))throw error}}
};
const rows=value=>{if(!Array.isArray(value))throw new SafeError('outbox_invalid_rows',503);return value};
export async function bridgeNotificationOutbox(env,{limit=5}={}){
 if(!outboxEnabled(env))return {disabled:true};
 const {classifyNotice,enqueueNotice,noticeRead}=await import('./notification-center.js');
 if(remainingRequests(env)<8)return {deferred:true};const events=rows(await call(env,'claim',{p_limit:Math.min(limit,Math.max(1,Math.floor((remainingRequests(env)-3)/3)))}));let queued=0;
 for(const event of events){try{
  const source=event.source_table.replace(/^tg_market_/,''),old=event.payload.old,row=event.payload.row||{...event.payload.old,status:'deleted'};
  let notices=classifyNotice(source,old,row);
  if(source==='users'&&!old&&event.payload.origin==='miniapp')notices.push({kind:'app_registered',payload:{subject_id:row.id,actor_name:row.display_name,actor_telegram:row.telegram_id},users:[]});
  if(source==='audit')notices=[{kind:'admin_operation',payload:{subject_id:event.record_id,actor_id:row.actor,title:row.action},users:[]}];
  if(!notices.length)notices=[{kind:'admin_operation',payload:{subject_id:event.record_id,title:source+':'+event.event_type},users:[]}];
  await env.OPS.prepare('INSERT OR IGNORE INTO tg_n_outbox(id,created_at) VALUES(?,?)').bind(event.id,Date.now()).run();
  for(let i=0;i<notices.length;i++){
   const n=notices[i],key='outbox:'+event.id+':'+i;
   if(n.payload.actor_id&&/^[a-f0-9-]{36}$/.test(n.payload.actor_id)){const [actor]=await noticeRead(env,'users',{select:'display_name,telegram_id',id:'eq.'+n.payload.actor_id,limit:'1'});if(actor){n.payload.actor_name=actor.display_name;n.payload.actor_telegram=actor.telegram_id}}
   if(n.kind==='wanted_offer'){const [wanted]=await noticeRead(env,'wanted',{select:'owner_id,title',id:'eq.'+row.request_id,limit:'1'});if(wanted){n.users.push(wanted.owner_id);n.payload.title=wanted.title}}
   await enqueueNotice(env,key,n.kind,{...n.payload,...(event.is_test?{test:true,reason:'اختبار إنتاج معزول؛ لا حساب أو إعلان أو استحقاق حقيقي.'}:{})},{users:event.is_test?[]:n.users,test:!!event.is_test});
   await env.OPS.prepare('INSERT OR IGNORE INTO tg_n_outbox_events(outbox_id,event_key) VALUES(?,?)').bind(event.id,key).run();
  }
  if(!await call(env,'bridge_ack',{p_id:event.id,p_token:event.lease_token}))throw Error('lease_lost');
  queued++;
 }catch{
  // Lease expiry recovers an interrupted bridge. Stable IDs replay into the same
  // D1 jobs even when Telegram already accepted their messages.
  await call(env,'bridge_ack',{p_id:event.id,p_token:event.lease_token,p_error:'outbox_bridge_failed'}).catch(()=>{});
 }}return {queued};
}
export async function reconcileNotificationOutbox(env){
 if(!outboxEnabled(env))return;
 for(const event of rows(await call(env,'queued',{p_limit:5}))){
  const jobs=(await env.OPS.prepare("SELECT d.state,d.attempts,d.message_id,d.error_code FROM tg_n_outbox_events m JOIN tg_n_delivery d ON d.event_key=m.event_key WHERE m.outbox_id=? AND d.audience='admin'").bind(event.id).all()).results;
  if(!jobs.length)continue;
  const sent=jobs.every(j=>j.state==='sent'&&Number.isSafeInteger(j.message_id)),review=jobs.some(j=>['review','cancelled'].includes(j.state));
  await call(env,'delivery',{p_id:event.id,p_status:sent?'sent':review?'review':'queued',p_attempts:jobs.reduce((n,j)=>n+j.attempts,0),p_message_ids:jobs.filter(j=>j.message_id).map(j=>j.message_id),p_error:jobs.find(j=>j.error_code)?.error_code||null});
 }
}
export async function monitorNotificationOutbox(env){
 if(!outboxEnabled(env))return;
 const {importantNotice}=await import('./notification-center.js'),r=await call(env,'health');
 if(!r||typeof r!=='object'||Array.isArray(r))throw new SafeError('outbox_invalid_health',503);if(r.stalled||r.repeated_failures||r.review)await importantNotice(env,'notification_outbox','backlog_requires_attention');
 const d=await env.OPS.prepare("SELECT COUNT(*) n FROM tg_n_delivery WHERE state='review' OR (state IN ('retry','pending','sending') AND (attempts>=5 OR updated_at<?))").bind(Date.now()-900000).first();
 if(d.n)await importantNotice(env,'notification_delivery','backlog_requires_attention');
}

export async function notificationOutboxHealth(env){return outboxEnabled(env)?{enabled:true,...await call(env,'health')}:null}
