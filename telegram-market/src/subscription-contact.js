import {rpc} from './services.js';
export async function syncSubscriptionContacts(env){
 if(env.USER_NOTIFICATIONS!=='true'||!env.OPS)return;
 const cursor=Number((await env.OPS.prepare("SELECT value FROM tg_n_meta WHERE key='subscription_contacts_cursor'").first())?.value)||0;
 const rows=(await env.OPS.prepare('SELECT id,blocked FROM tg_ops_users WHERE started=1 AND id>? ORDER BY id LIMIT 50').bind(cursor).all()).results;
 if(rows.length)await rpc({...env,NOTIFICATION_CENTER:'false'},'tg_market_notify_contacts',{p_contacts:rows.map(r=>({actor:r.id,blocked:!!r.blocked}))});
 await env.OPS.prepare("INSERT INTO tg_n_meta(key,value) VALUES('subscription_contacts_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(rows.length===50?String(rows.at(-1).id):'0').run();
}
export async function recordSubscriptionContact(env,id,blocked=false){
 if(env.USER_NOTIFICATIONS!=='true'||!env.OPS||!Number.isSafeInteger(id))return;
 const row=await env.OPS.prepare('SELECT started FROM tg_ops_users WHERE id=?').bind(id).first();if(!row?.started)return;
 await rpc({...env,NOTIFICATION_CENTER:'false'},'tg_market_notifications',{p_actor:id,p_operation:'bot_seen',p_data:{blocked},p_admin:false,p_name:'مستخدم'});
}
