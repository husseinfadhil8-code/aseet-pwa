import {SafeError} from './services.js';
// Shared deployment barrier. It blocks new mutations briefly while all existing
// writers drain; Telegram retains/retries 503 webhook deliveries.
export async function acquireNotificationRuntime(env){
 if(!env.OPS||env.NOTIFICATION_CENTER!=='true')return {env,release:async()=>{}};
 const state=async()=>await env.OPS.prepare("SELECT value FROM tg_n_meta WHERE key='outbox_cutover'").first();
 let config=await state();if(config?.value==='paused')throw new SafeError('notification_upgrade_retry',503);
 const name='outbox_writer:'+crypto.randomUUID();
 await env.OPS.prepare('INSERT INTO tg_ops_leases(name,expires) VALUES(?,?)').bind(name,Date.now()+900000).run();
 const release=()=>env.OPS.prepare('DELETE FROM tg_ops_leases WHERE name=?').bind(name).run();
 try{config=await state();if(config?.value==='paused')throw new SafeError('notification_upgrade_retry',503)}catch(e){await release();throw e}
 return {env:{...env,...(config?.value==='enabled'?{NOTIFICATION_OUTBOX:'true'}:{})},release};
}
