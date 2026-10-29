import {importantNotice} from './notification-center.js';
import {notificationError} from './notification-errors.js';
import {remainingRequests} from './notification-budget.js';
export async function runScheduledNotifications(env,tasks){
 const db=env.OPS,budget={limit:44,used:0},bounded={...env,NOTIFICATION_REQUEST_BUDGET:budget};
 let expires=Date.now()+180000;if(db){const lock=await db.prepare("INSERT INTO tg_ops_leases(name,expires) VALUES('notification_scheduler',?) ON CONFLICT(name) DO UPDATE SET expires=excluded.expires WHERE expires<? RETURNING name").bind(expires,Date.now()).first();if(!lock)return {busy:true}}
 try{
 const cursor=db?Number((await db.prepare("SELECT value FROM tg_n_meta WHERE key='notification_scheduler_cursor'").first())?.value)||0:0;
 const result={started_at:Date.now(),requests:0,limit:budget.limit,stages:[]};
 for(let i=0;i<tasks.length;i++){
  if(db){const renewed=Date.now()+180000;const held=await db.prepare("UPDATE tg_ops_leases SET expires=? WHERE name='notification_scheduler' AND expires=?").bind(renewed,expires).run();if(!held.meta.changes)break;expires=renewed}
  const task=tasks[(cursor+i)%tasks.length];let status='ok',code=null;
  if(remainingRequests(bounded)<task.minimum){status='deferred';code='notification_budget_deferred'}else try{await task.run(bounded)}catch(error){code=notificationError(error).code;status=code==='notification_budget_deferred'?'deferred':'error';if(status==='error')await importantNotice(env,'scheduled_'+task.name,error)}
  const checkpoint={stage:task.name,status,code,at:Date.now()};result.stages.push(checkpoint);
  if(db)await db.prepare("INSERT INTO tg_n_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind('notification_stage:'+task.name,JSON.stringify(checkpoint)).run();
 }
 result.requests=budget.used;
 if(db)await db.batch([db.prepare("INSERT INTO tg_n_meta(key,value) VALUES('notification_scheduler_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String((cursor+1)%tasks.length)),db.prepare("INSERT INTO tg_n_meta(key,value) VALUES('notification_scheduler_last',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(result))]);
 console.log('notification_scheduler_tick',JSON.stringify(result));return result;
 }finally{if(db)await db.prepare("DELETE FROM tg_ops_leases WHERE name='notification_scheduler' AND expires=?").bind(expires).run()}
}
