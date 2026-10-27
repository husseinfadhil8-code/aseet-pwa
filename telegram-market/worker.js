import {requireOwner,userSnapshot,updateUser,adminSnapshot,listingSnapshot,conversationInfo,enrichThreads,conversationAvatar,listingIdentities,authorizedAvatar,representativeIdentities,publicationPreview} from './src/presentation.js';
import {notificationAction,processNotifications} from './src/notifications.js';
import {validateChannel,dispatchPublication,publicationLink} from './src/publication.js';
import {MARKET_LINK} from './miniapp/links.js';
import {verifyInitData,equal} from './src/auth.js';
import {SafeError,boundedJSON,rpc,telegram,admin,supabase,clipText} from './src/services.js';
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const allowed=new Set(['publication_preview','conversation','admin_user_state','admin_listing_state','me','mine','save','status','favorite','favorites','report','thread','inbox','messages','send','orders','support','rep','admin','admin_user','admin_listing','admin_report','admin_sale','training','lesson','quiz','rep_apply','rep_application','rep_requests','rep_review','rep_payout','settings','packages_save','purchases_save','admin_listing_approve','publication_resolve','checkout_release']);
const action=(env,user,name,data={})=>rpc(env,'tg_market_action',{p_actor:user.id,p_action:name,p_data:data,p_admin:admin(env,user.id),p_name:user.name||'مستخدم'});
async function identity(request,env){const user=await verifyInitData(request.headers.get('x-telegram-init-data'),env.TELEGRAM_BOT_TOKEN);if(!user)throw new SafeError('telegram_session_required',401);return user}
async function webhook(request,env,origin){
 if(!env.TELEGRAM_WEBHOOK_SECRET||!equal(request.headers.get('x-telegram-bot-api-secret-token'),env.TELEGRAM_WEBHOOK_SECRET))throw new SafeError('unauthorized',401);
 const update=await boundedJSON(request,65536);
 if(!Number.isSafeInteger(update.update_id))throw new SafeError('invalid_update');
 const checkout=update.pre_checkout_query;
 if(checkout){
  let ok=false;try{const result=await rpc(env,'tg_market_checkout',{p_actor:checkout.from.id,p_order:checkout.invoice_payload,p_stars:checkout.total_amount,p_currency:checkout.currency,p_checkout:checkout.id},3500);ok=result.approved===true}catch{}
  await telegram(env,'answerPreCheckoutQuery',{pre_checkout_query_id:checkout.id,ok,...(!ok?{error_message:'تعذّر تأكيد هذا الطلب. لم يُفعّل الترويج؛ حاول من إعلان نشط أو تواصل مع الدعم.'}:{})},3500);return response({ok:true});
 }
 const cb=update.callback_query;
 if(cb){
  if(cb.message?.chat?.type!=='private'||cb.message.chat.id!==cb.from?.id)return response({ok:true});
  if(['notify:enable','notify:stop'].includes(cb.data)){
   let denied=false;try{await rpc(env,'tg_market_notifications',{p_actor:cb.from.id,p_operation:cb.data==='notify:enable'?'bot_enable':'bot_stop',p_data:{update:update.update_id},p_admin:admin(env,cb.from.id),p_name:cb.from.first_name||'مستخدم'})}catch(e){if(e instanceof SafeError&&e.status===403)denied=true;else throw e}
   try{await telegram(env,'answerCallbackQuery',{callback_query_id:cb.id,text:denied?'لا يمكن تفعيل الإشعارات لهذا الحساب حالياً.':cb.data==='notify:enable'?'تم تفعيل الإشعارات بموافقتك. غيّر الفلاتر من حسابي.':'تم إلغاء الاشتراك.'})}catch{}

  }
  return response({ok:true});
 }
 const message=update.message;
 if(!message)return response({ok:true});
 const payment=message.successful_payment;
 if(payment){await rpc(env,'tg_market_payment',{p_actor:message.from.id,p_order:payment.invoice_payload,p_stars:payment.total_amount,p_currency:payment.currency,p_charge:payment.telegram_payment_charge_id});return response({ok:true})}
 const text=String(message.text||''),chatId=message.chat?.id;
 if(!chatId)return response({ok:true});
 const button=message.chat.type==='private'?{text:'🛍 افتح السوق',web_app:{url:origin+'/miniapp/'}}:{text:'🛍 افتح السوق',url:MARKET_LINK};
 let reply;
 if(/^\/(start|market)(?:@WaseetIraqMarketBot)?(?:\s|$)/i.test(text))reply='أهلاً بك في وسيط | سوق العراق 🇮🇶\nبيع واشتري مجاناً وتواصل بأمان داخل السوق.\nتفعيل الإشعارات اختياري. تختار المحافظات والأقسام، وتوقف التنبيهات من حسابي في أي وقت.';
 else if(/^\/stop(?:\s|$)/.test(text)&&message.chat.type==='private'){await rpc(env,'tg_market_notifications',{p_actor:message.from.id,p_operation:'bot_stop',p_data:{update:update.update_id},p_admin:admin(env,message.from.id),p_name:message.from.first_name||'مستخدم'});reply='تم إلغاء اشتراك الإشعارات. يمكنك تفعيله بموافقتك من الزر أدناه.'}
 else if(/^\/notifications(?:\s|$)/.test(text)&&message.chat.type==='private')reply='اضبط المحافظات والأقسام أو أوقف التنبيهات من السوق ← حسابي ← إعدادات الإشعارات. التفعيل اختياري.';
 else if(/^\/id(?:\s|$)/.test(text)&&message.chat.type==='private')reply='معرف حسابك في تلغرام: '+message.from.id;
 else if(/^\/paysupport(?:\s|$)/.test(text))reply='لدعم المدفوعات: أرسل رقم طلب الترويج ووصف المشكلة هنا، أو افتح السوق ← حسابي ← الدعم. لا ترسل كلمات مرور أو بيانات بطاقة. يمكن للإدارة مراجعة الطلب ورد Stars عند استحقاق الرد.';
 else if(/^\/terms(?:\s|$)/.test(text))reply='نشر الإعلانات مجاني. الترويج الرقمي بـTelegram Stars فقط، وسعر الباقة ومدتها معروضان قبل الدفع، وتبدأ المدة من تأكيد تلغرام. الإعلانات المخالفة تُخفى ولا تُروّج. للدعم أو طلب مراجعة/استرداد: /paysupport. لا تحويل ثابت بين Stars والدينار.';
 else if(message.chat.type==='private'&&text&&!text.startsWith('/')){await action(env,{id:message.from.id,name:message.from.first_name},'support',{body:text.slice(0,2000)});reply='وصلت رسالتك إلى دعم وسيط. لنشر إعلان أو مراسلة بائع، افتح السوق من الزر أدناه.'}
 if(reply)await telegram(env,'sendMessage',{chat_id:chatId,text:reply,reply_markup:{inline_keyboard:[[button],...(message.chat.type==='private'?[[{text:'🔔 تفعيل إشعارات الإعلانات',callback_data:'notify:enable'}],[{text:'إلغاء الاشتراك في الإشعارات',callback_data:'notify:stop'}]]:[])]}});
 return response({ok:true});
}
export default {async scheduled(event,env,ctx){ctx.waitUntil(processNotifications(env,{scheduled:true}).catch(()=>{}))},async fetch(request,env,ctx){
 try{
  const url=new URL(request.url);
  if(url.pathname==='/internal/setup'&&request.method==='POST'){
   if(!env.DEPLOY_SETUP_KEY||!equal(request.headers.get('x-waseet-setup'),env.DEPLOY_SETUP_KEY))throw new SafeError('unauthorized',401);
   const setupInput=await boundedJSON(request);const bot=await telegram(env,'getMe',{});if(String(bot.username).toLowerCase()!=='waseetiraqmarketbot')throw new SafeError('wrong_bot',409);
   await rpc(env,'tg_market_public',{p_query:'',p_category:'',p_min:0,p_max:0,p_offset:0});
   await telegram(env,'setWebhook',{url:url.origin+'/webhook',secret_token:env.TELEGRAM_WEBHOOK_SECRET,drop_pending_updates:false,allowed_updates:['message','pre_checkout_query','callback_query']});
   await telegram(env,'setMyCommands',{commands:[{command:'start',description:'افتح سوق وسيط'},{command:'market',description:'السوق'},{command:'id',description:'معرف حسابك لإعداد المدير'},{command:'terms',description:'شروط الترويج'},{command:'paysupport',description:'دعم المدفوعات'},{command:'notifications',description:'إعدادات إشعارات الإعلانات'},{command:'stop',description:'إلغاء اشتراك الإشعارات'}]});
   await telegram(env,'setChatMenuButton',{menu_button:{type:'web_app',text:'افتح السوق',web_app:{url:url.origin+'/miniapp/'}}});
   const info=await telegram(env,'getWebhookInfo',{});if(info.url!==url.origin+'/webhook')throw new SafeError('webhook_not_verified',503);
   const menu=await telegram(env,'getChatMenuButton',{}),commands=await telegram(env,'getMyCommands',{});
   if(menu.type!=='web_app'||menu.web_app?.url!==url.origin+'/miniapp/'||!commands.some(c=>c.command==='start'))throw new SafeError('bot_settings_not_verified',503);
   const ownerId=Number(String(env.OWNER_TELEGRAM_ID||env.ADMIN_TELEGRAM_IDS||''));let ownerVerified=false;if(admin(env,ownerId)){const owner=await action(env,{id:ownerId,name:'مدير وسيط'},'me');const publicIdentity=await rpc(env,'tg_market_identity',{p_user:owner.id});ownerVerified=owner.role==='admin'&&owner.name==='مدير وسيط'&&owner.verified_internal===true&&publicIdentity.name==='مدير وسيط'&&publicIdentity.verified_internal===true;if(!ownerVerified)throw new SafeError('owner_not_verified',503)}
   let channelVerified=false;if(setupInput.channel){if(!ownerVerified)throw new SafeError('owner_required',403);const channel=await validateChannel(env,String(setupInput.channel).trim());await action(env,{id:ownerId,name:'مدير وسيط'},'channel_save',{...channel,auto:setupInput.auto===true});channelVerified=true}
   const settings=ownerVerified?await action(env,{id:ownerId,name:'مدير وسيط'},'settings'):null;
   if(setupInput.verifyChannel===true&&settings?.channel){await validateChannel(env,settings.channel);channelVerified=true}
   const readiness=settings?{channelConfigured:!!settings.channel,channelVerified:settings.channel_verified===true,autoPublish:settings.auto_publish===true,purchasesEnabled:settings.purchases_enabled===true,paymentsVerified:settings.payments_verified===true,packageCount:Array.isArray(settings.packages)?settings.packages.length:0,enabledPricedPackages:Array.isArray(settings.packages)?settings.packages.filter(p=>p.enabled===true&&Number(p.stars)>0).length:0}:null;
   let channelPublication=null;
   if(setupInput.channelPublication){
    if(env.SUPABASE_URL!=='https://beyrctbxojpuvhevfyok.supabase.co'||!ownerVerified||settings.channel!==setupInput.channelPublication.expected_channel||!settings.channel_verified)throw new SafeError('owner_or_channel_mismatch',403);
    const input=setupInput.channelPublication,verified=await validateChannel(env,settings.channel),prior=(settings.publications||[]).find(p=>p.listing_id===input.listing&&p.channel===settings.channel&&p.state==='sent');
    if(prior)channelPublication={state:'sent',already_processed:true,message_id:prior.message_id,channel_verified:true,message_link:publicationLink(verified.channel,verified.username,prior.message_id)};
    else{const act=(name,values)=>action(env,{id:ownerId,name:'مدير وسيط'},name,values),pub=await act('publication_queue',{id:input.listing,key:input.request,repost:false});channelPublication=await dispatchPublication(env,act,pub.id)}
   }
   let notificationTest=null;
   if(setupInput.notificationApprove){if(!ownerVerified||setupInput.notificationTest!==true)throw new SafeError('owner_required',403);await action(env,{id:ownerId,name:'مدير وسيط'},'admin_listing_approve',{id:setupInput.notificationApprove})}
   if(setupInput.notificationTest===true){if(!ownerVerified)throw new SafeError('owner_required',403);await notificationAction(env,{id:ownerId,name:'مدير وسيط'},'test',{confirmed:true,request:setupInput.notificationRequest,...(setupInput.notificationListing?{listing:setupInput.notificationListing}:{})},true);notificationTest=await processNotifications(env,{limit:1});}
   if(setupInput.notificationActivate===true){if(!ownerVerified)throw new SafeError('owner_required',403);await rpc(env,'tg_market_notify_worker',{p_operation:'activate',p_data:{}})}
   let presentationAudit=null;if(setupInput.presentationAudit===true){if(!ownerVerified||env.SUPABASE_URL!=='https://beyrctbxojpuvhevfyok.supabase.co')throw new SafeError('owner_required',403);const who={id:ownerId,name:'مدير وسيط'},raw=(name,data)=>action(env,who,name,data),panel=await adminSnapshot(env,who,{listing_filter:'pending'},raw),threads=await enrichThreads(env,who,await raw('inbox'),raw);presentationAudit={adminRead:true,rootProtected:panel.users.some(u=>u.is_owner&&u.role==='admin'),pendingFilter:panel.listing_filter==='pending'&&panel.listings.every(a=>a.review_state==='pending'),conversationCount:threads.length,namedPeers:threads.filter(t=>t.peer.name&&t.peer.name!=='مستخدم وسيط').length}}
   return response({ok:true,presentationAudit,channelPublication,notificationTest,readiness,ownerVerified,channelVerified,bot:bot.username,webhook:info.url,pendingUpdates:info.pending_update_count,mainMiniApp:bot.has_main_web_app===true,menuVerified:true,commandsVerified:true});
  }
  if(url.pathname==='/health'&&request.method==='GET')return response({ok:true,service:'waseet-telegram',version:'1'});
  if(url.pathname==='/webhook'&&request.method==='POST')return await webhook(request,env,url.origin);
  if(url.pathname.startsWith('/api/')&&request.headers.get('origin')&&request.headers.get('origin')!==url.origin)throw new SafeError('origin_denied',403);
  if(/^\/api\/(admin|listing)\/avatar\/[a-f0-9-]{36}$/.test(url.pathname)&&request.method==='GET'){const user=await identity(request,env),parts=url.pathname.split('/');return await authorizedAvatar(env,user,parts[2],parts[4],(name,data)=>action(env,user,name,data))}
  if(url.pathname==='/api/avatar/self'&&request.method==='GET'){const user=await identity(request,env);return await authorizedAvatar(env,user,'self',null,(name,data)=>action(env,user,name,data))}
  if(/^\/api\/chat\/avatar\/[a-f0-9-]{36}$/.test(url.pathname)&&request.method==='GET'){const user=await identity(request,env);return await conversationAvatar(env,user,url.pathname.split('/').pop(),(name,data)=>action(env,user,name,data))}
  if(url.pathname==='/api/listings'&&request.method==='GET'){
   const integer=(key,fallback)=>{const n=Number(url.searchParams.get(key)??fallback);if(!Number.isSafeInteger(n)||n<0)throw new SafeError('invalid_filter');return n};
   let listings=await rpc(env,'tg_market_public',{p_query:(url.searchParams.get('q')||'').slice(0,60),p_category:url.searchParams.get('category')||'',p_min:integer('min',0),p_max:integer('max',1000000000000),p_offset:integer('offset',0)});const user=await verifyInitData(request.headers.get('x-telegram-init-data'),env.TELEGRAM_BOT_TOKEN);if(user){try{listings=await listingIdentities(env,listings,(name,data)=>action(env,user,name,data))}catch{ /* Optional identity must not break public browsing. */ }}return response({data:listings,offers:await rpc(env,'tg_market_offers',{})});
  }
  if(/^\/api\/profile\/[a-f0-9-]{36}$/.test(url.pathname)&&request.method==='GET'){const profileId=url.pathname.split('/').pop();let result=await rpc(env,'tg_market_identity',{p_user:profileId});const user=await verifyInitData(request.headers.get('x-telegram-init-data'),env.TELEGRAM_BOT_TOKEN),listingId=url.searchParams.get('listing');if(user&&/^[a-f0-9-]{36}$/.test(listingId||'')){const ad=await rpc(env,'tg_market_listing',{p_id:listingId});if(ad?.owner_id===profileId){const rows=await listingIdentities(env,[ad],(name,data)=>action(env,user,name,data));result=rows[0].author}}return response({data:result})}
  if(/^\/api\/listings\/[a-f0-9-]{36}$/.test(url.pathname)&&request.method==='GET'){const listing=await rpc(env,'tg_market_listing',{p_id:url.pathname.split('/').pop()});if(!listing)throw new SafeError('not_found',404);const user=await verifyInitData(request.headers.get('x-telegram-init-data'),env.TELEGRAM_BOT_TOKEN);let result=listing;if(user){try{result=(await listingIdentities(env,[listing],(name,data)=>action(env,user,name,data)))[0]}catch{}}return response({data:result})}
  if(/^\/media\/[a-f0-9-]{36}$/.test(url.pathname)&&request.method==='GET'){
   const user=await verifyInitData(request.headers.get('x-telegram-init-data'),env.TELEGRAM_BOT_TOKEN);
   const image=await rpc(env,'tg_market_media',{p_image:url.pathname.split('/')[2],p_actor:user?.id||0});if(!image)throw new SafeError('not_found',404);
   const res=await fetch(supabase(env)+'/storage/v1/object/authenticated/waseet-telegram-images/'+image.path,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY},signal:AbortSignal.timeout(8000)});
   if(!res.ok)throw new SafeError('not_found',404);
   return new Response(res.body,{headers:{'content-type':image.mime,'cache-control':'no-store','x-content-type-options':'nosniff'}});
  }
  if(url.pathname.startsWith('/api/')&&request.method==='POST'){
   const user=await identity(request,env);
   if(url.pathname==='/api/images'){
    const mime=request.headers.get('content-type');if(!['image/jpeg','image/png','image/webp'].includes(mime))throw new SafeError('invalid_image');
    // Stream limit is enforced even for chunked bodies without Content-Length.
    const reader=request.body?.getReader();if(!reader)throw new SafeError('invalid_image');const parts=[];let size=0;try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>5242880)throw new SafeError('image_too_large',413);parts.push(r.value)}}finally{await reader.cancel().catch(()=>{})}
    const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length}
    const valid=(mime==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)||(mime==='image/png'&&[137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x))||(mime==='image/webp'&&new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP');
    if(!valid)throw new SafeError('invalid_image');const image=await action(env,user,'image_intent',{mime});
    const uploaded=await fetch(supabase(env)+'/storage/v1/object/waseet-telegram-images/'+image.path,{method:'POST',headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'content-type':mime,'x-upsert':'false'},body:bytes,signal:AbortSignal.timeout(12000)});
    if(!uploaded.ok)throw new SafeError('upload_failed',503);await action(env,user,'image_ready',{id:image.id});return response({id:image.id});
   }
   const data=await boundedJSON(request);
   if(url.pathname==='/api/notifications'){if(data.operation==='reject_listing'){const raw=(name,values)=>action(env,user,name,values);await requireOwner(env,user,raw);await notificationAction(env,user,data.operation,data.data||{},admin(env,user.id));return response({data:{saved:true,listing:await listingSnapshot(env,data.data?.id,raw)}})}return response({data:await notificationAction(env,user,data.operation,data.data||{},admin(env,user.id))})}
   if(url.pathname==='/api/channel/settings'){
    if(!admin(env,user.id))throw new SafeError('owner_required',403);
    if(data.pause){await action(env,user,'channel_pause');return response({ok:true})}
    const verified=await validateChannel(env,String(data.channel||'').trim());await action(env,user,'channel_save',{...verified,auto:data.auto===true});return response({ok:true,title:verified.title,channel:verified.channel,auto_publish:data.auto===true});
   }
   if(url.pathname==='/api/channel'){
    if(!admin(env,user.id))throw new SafeError('owner_required',403);
    const act=(name,values)=>action(env,user,name,values);
    const pub=data.publication?{id:data.publication}:await act('publication_queue',{id:data.id,key:data.key,repost:data.repost===true});
    return response({ok:true,...await dispatchPublication(env,act,pub.id)});
   }
   if(url.pathname==='/api/invoice'){
    const order=data.order?await action(env,user,'order_resume',{id:data.order}):await action(env,user,'order',{id:data.id,package:data.package,test:data.test===true});if(order.status!=='pending')return response({order});
    const invoice=await telegram(env,'createInvoiceLink',{title:clipText(order.snapshot_name,32),description:clipText((order.is_test?'اختبار مدير مغلق؛ ':'')+order.snapshot_description+' · '+order.duration_days+' يوم. الدعم: /paysupport',255),payload:order.id,provider_token:'',currency:'XTR',prices:[{label:clipText(order.snapshot_name,64),amount:order.stars}]});
    return response({invoice,order:order.id,snapshot:{name:order.snapshot_name,days:order.duration_days,stars:order.stars,is_test:order.is_test}});
   }
   if(url.pathname==='/api/refund'){
    await action(env,user,'me');const claim=await rpc(env,'tg_market_refund',{p_actor:user.id,p_order:data.id,p_stage:'claim'});
    try{await telegram(env,'refundStarPayment',{user_id:claim.telegram_id,telegram_payment_charge_id:claim.charge});await rpc(env,'tg_market_refund',{p_actor:user.id,p_order:data.id,p_stage:'done'})}
    catch{await rpc(env,'tg_market_refund',{p_actor:user.id,p_order:data.id,p_stage:'uncertain'});throw new SafeError('refund_needs_review',409)}
    return response({ok:true});
   }
   if(url.pathname==='/api/action'&&allowed.has(data.action)){
    const raw=(name,values)=>action(env,user,name,values),name=data.action,values=data.data||{};
    if(name==='publication_preview')return response({data:await publicationPreview(env,user,values.id,raw)});
    if(name==='admin')return response({data:await adminSnapshot(env,user,values,raw)});
    if(name==='admin_user_state')return response({data:await userSnapshot(env,user,values.id,raw)});
    if(name==='admin_user')return response({data:await updateUser(env,user,values,raw)});
    if(name==='conversation')return response({data:await conversationInfo(env,user,values.id,raw)});
    if(name==='admin_listing_state'){await requireOwner(env,user,raw);return response({data:await listingSnapshot(env,values.id,raw)})}
    if(name==='admin_listing_approve'){
     await requireOwner(env,user,raw);const before=await listingSnapshot(env,values.id,raw);if(before.review_state==='published')return response({data:{approved:true,already_approved:true,listing:before,publication:before.channel}});
     const result=await raw(name,values);let publication;if(result.state==='queued'){try{publication=await dispatchPublication(env,raw,result.id)}catch{publication={state:'pending_or_review'}}}
     const listing=await listingSnapshot(env,values.id,raw);return response({data:{approved:listing.review_state==='published',listing,publication:publication||listing.channel}});
    }
    if(name==='admin_listing'){await requireOwner(env,user,raw);await raw(name,values);return response({data:{saved:true,listing:await listingSnapshot(env,values.id,raw)}})}
    let result=name==='save'?await rpc(env,'tg_market_notifications',{p_actor:user.id,p_operation:'save_listing',p_data:values,p_admin:admin(env,user.id),p_name:user.name||'مستخدم'}):await raw(name,values);
    if(name==='rep_requests')result=await representativeIdentities(env,user,result,raw);
    if(name==='mine'||name==='favorites')result=await listingIdentities(env,result,raw);
    if(name==='inbox')result=await enrichThreads(env,user,result,raw);
    if(name==='thread')result=await conversationInfo(env,user,result.id,raw);
    return response({data:result});
   }
   throw new SafeError('not_found',404);
  }
  if(request.method==='GET'&&env.ASSETS){
   const path=url.pathname==='/'||url.pathname==='/miniapp/'?'/index.html':url.pathname;
   const res=await env.ASSETS.fetch(new Request(new URL(path,url.origin),request));
   const h=new Headers(res.headers);h.set('x-content-type-options','nosniff');h.set('referrer-policy','no-referrer');h.set('content-security-policy',"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org");return new Response(res.body,{status:res.status,headers:h});
  }
  return response({error:'not_found'},404);
 }catch(error){return response({error:error instanceof SafeError?error.message:'service_unavailable'},error instanceof SafeError?error.status:503)}
}};
