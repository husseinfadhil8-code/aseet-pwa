import {rpc,supabase,clipText,SafeError} from './services.js';
import {MARKET_LINK} from '../miniapp/links.js';
export class DeliveryError extends Error{constructor(outcome,retryAfter=30){super(outcome);this.outcome=outcome;this.retryAfter=retryAfter}}
export async function sendNotification(env,method,payload){
 if(!env.TELEGRAM_BOT_TOKEN)throw new DeliveryError('review');
 let r,d;try{r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',...(payload instanceof FormData?{body:payload}:{headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),signal:AbortSignal.timeout(8000)});d=await r.json()}catch{throw new DeliveryError('review')}
 if(r.ok&&d.ok&&Number.isSafeInteger(d.result?.message_id))return d.result;
 const code=Number(d.error_code||r.status);
 if(code===429){const retry=Number(d.parameters?.retry_after)||Number(r.headers.get('retry-after'))||30;throw new DeliveryError('rate_limited',Math.min(86400,Math.max(1,Math.ceil(retry))))}
 if(code===403)throw new DeliveryError('blocked');
 if(code===400)throw new DeliveryError('failed');
 // HTTP 5xx, malformed responses and network timeouts may have followed delivery.
 throw new DeliveryError('review');
}
export function notificationContent(job){
 let text,parameter='account';
 if(job.kind==='listing'||job.kind==='rep_good'||(job.kind==='test'&&job.listing)){
  text=(job.kind==='test'?'🔔 اختبار خاص وافقت عليه — إعلانك الحقيقي في وسيط':job.kind==='listing'?'🔔 إعلان جديد معتمد في وسيط':'غرض جديد للمندوبين لدى وسيط')+'\n'+job.title+'\n'+Number(job.price).toLocaleString('ar-IQ')+' د.ع\n'+job.area+'\n'+clipText(job.description,350);
  parameter=(job.kind==='rep_good'?'rep_':'ad_')+(job.kind==='rep_good'?job.good:job.listing);
 }else if(job.kind==='message'){text='💬 وصلتك رسالة جديدة في سوق وسيط. افتح المحادثة للاطلاع عليها بأمان.';parameter='thread_'+job.thread}
 else text=({listing_approved:'✅ اعتمدت إدارة وسيط إعلانك.',listing_rejected:'لم تعتمد إدارة وسيط إعلانك. راجع إعلاناتي أو تواصل مع الدعم.',rep_application:'وصل طلب انضمام مندوب جديد إلى وسيط. راجعه من لوحة الإدارة.',rep_approved:'✅ قُبل طلب انضمامك كمندوب لدى وسيط. لوحتك جاهزة داخل حسابي.',rep_rejected:'راجعت إدارة وسيط طلب الانضمام، ولم يُعتمد حالياً. حساب السوق العادي يبقى متاحاً.',test:'🔔 اختبار توصيل خاص وافقت عليه من وسيط. هذه رسالة اختبار وليست إعلاناً أو اشتراكاً تلقائياً. وصول التنبيه إلى الهاتف يعتمد على إعدادات Telegram والجهاز.'})[job.kind]||'لديك تحديث في وسيط.';
 if(job.kind==='test')text+='\nزر التفعيل اختياري ويشمل الإعلانات وتنبيهات رسائلك وطلباتك؛ عدّل الفلاتر أو ألغِ الاشتراك من حسابي.';
 if(job.kind==='listing_approved')parameter='ad_'+job.listing;
 if(job.kind==='listing_rejected')parameter='mine';
 const extra=job.kind==='test'?[[{text:'🔔 تفعيل إشعارات الإعلانات بموافقتي',callback_data:'notify:enable'}]]:[];
 return {text:clipText(text,900),reply_markup:{inline_keyboard:[[{text:job.kind==='listing'||(job.kind==='test'&&job.listing)?'🛍 عرض الإعلان':job.kind==='message'?'فتح المحادثة':'فتح سوق وسيط',url:MARKET_LINK+'?startapp='+parameter}],...extra]}};
}
export async function processNotifications(env,{limit=5,scheduled=false,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const work=(operation,data={})=>rpc(env,'tg_market_notify_worker',{p_operation:operation,p_data:data});
 // Every iteration is bounded. No public endpoint can invoke the worker RPC.
 if(scheduled)await work('heartbeat');
 await work('fanout');await work('fanout');
 const summary={sent:0,failed:0,review:0};
 for(let i=0;i<Math.min(limit,5);i++){
  let job=await work('claim');
  if(job.wait_ms){if(job.wait_ms>1500)break;await sleep(job.wait_ms);job=await work('claim')}
  if(job.skipped)continue;if(!job.id)break;
  let outcome='review',message,fileId,retryAfter=30;
  try{
   let photo;
   if(job.image&&!job.file_id){
    try{
     const r=await fetch(supabase(env)+'/storage/v1/object/authenticated/waseet-telegram-images/'+job.image.path,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY},signal:AbortSignal.timeout(6000)});
     if(!r.ok)throw new Error();photo=await r.blob();if(photo.size>5242880)throw new Error();
    }catch{throw new DeliveryError('retryable')}
   }
   if(!(await work('validate',{id:job.id,lease:job.lease})).valid)continue;
   const content=notificationContent(job);let sent;
   if(photo){const form=new FormData();form.set('chat_id',String(job.chat));form.set('photo',photo,'waseet.jpg');form.set('caption',content.text);form.set('reply_markup',JSON.stringify(content.reply_markup));sent=await sendNotification(env,'sendPhoto',form)}
   else if(job.file_id)sent=await sendNotification(env,'sendPhoto',{chat_id:job.chat,photo:job.file_id,caption:content.text,reply_markup:content.reply_markup});
   else sent=await sendNotification(env,'sendMessage',{chat_id:job.chat,...content,disable_notification:false});
   message=sent.message_id;fileId=sent.photo?.at(-1)?.file_id;outcome='sent';summary.sent++;
  }catch(e){if(e instanceof DeliveryError){outcome=e.outcome;retryAfter=e.retryAfter}if(outcome==='review')summary.review++;else summary.failed++}
  // If ACK fails, leave sending for explicit review: never blindly resend.
  await work('finish',{id:job.id,lease:job.lease,outcome,message,file_id:fileId,retry_after:retryAfter});
  if(outcome==='rate_limited')break;
 }
 return summary;
}
export const notificationOperations=new Set(['get','save','pause','unsubscribe','presence','stats','goods','good_save','good_hide','reject_listing','test']);
export async function notificationAction(env,user,operation,data={},isAdmin=false){
 if(!notificationOperations.has(operation))throw new SafeError('not_found',404);
 return rpc(env,'tg_market_notifications',{p_actor:user.id,p_operation:operation,p_data:data,p_admin:isAdmin,p_name:user.name||'مستخدم'});
}
