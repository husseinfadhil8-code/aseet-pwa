import {rpc,telegram,admin,SafeError} from './services.js';
import {MARKET_LINK} from '../miniapp/links.js';
import {SUBSCRIPTION_PROMPT,SUBSCRIPTION_SUCCESS,SUBSCRIPTION_GOVERNORATES as GOVERNORATES,SUBSCRIPTION_CATEGORIES as CATEGORIES} from '../miniapp/subscription-copy.js';
export {SUBSCRIPTION_PROMPT,SUBSCRIPTION_SUCCESS};
const work=(env,user,operation,data={})=>rpc(env,'tg_market_notifications',{p_actor:user.id,p_operation:operation,p_data:data,p_admin:admin(env,user.id),p_name:user.name||'مستخدم'});
const url=route=>MARKET_LINK+'?startapp='+route;
export const subscriptionPromptKeyboard=()=>({inline_keyboard:[[{text:'🔔 فعّل الإشعارات',callback_data:'ns:enable'}],[{text:'مو هسه',callback_data:'ns:later'}]]});
export function provinceKeyboard(){const rows=[];for(let i=0;i<GOVERNORATES.length;i+=3)rows.push(GOVERNORATES.slice(i,i+3).map((g,k)=>({text:g,callback_data:'ns:gov:'+(i+k)})));rows.push([{text:'🔔 إشعاراتي',callback_data:'ns:settings'}]);return {inline_keyboard:rows}}
export function categoryKeyboard(p){const selected=new Set(p.categories||[]),rows=CATEGORIES.map((c,i)=>[{text:(selected.has(c)?'✅ ':'')+c,callback_data:'ns:cat:'+i}]);rows.push([{text:'كل الأقسام',callback_data:'ns:allcats'}],[{text:selected.size?'✅ احفظ وفعّل':'✅ فعّل لكل الأقسام',callback_data:'ns:done'}],[{text:'تغيير المحافظة',callback_data:'ns:province'},{text:'مو هسه',callback_data:'ns:later'}]);return {inline_keyboard:rows}}
function settingsKeyboard(p){return {inline_keyboard:[[{text:p.enabled?'إيقاف إشعارات العروض':'🔔 تفعيل العروض حسب اهتماماتي',callback_data:'ns:offers'}],[{text:'المحافظة والأقسام',callback_data:'ns:province'},{text:'🎯 كلمات راداري',url:url('radars')}],[{text:p.operational&&p.operational_consent_at?'إيقاف تنبيهات الرسائل والحساب':'تشغيل تنبيهات الرسائل والحساب',callback_data:'ns:operational'}],[{text:'إيقاف 24 ساعة',callback_data:'ns:pause'},{text:'إيقاف كل الاختياري',callback_data:'ns:alloff'}],[{text:'فتح 🔔 إشعاراتي بالتطبيق',web_app:{url:'https://waseet-telegram-bot.husseinfadhil8.workers.dev/miniapp/?tgWebAppStartParam=notifications'}}]]}}
async function render(env,user,callback,text,markup){const payload={chat_id:user.id,text,reply_markup:markup};if(callback?.message?.message_id){try{return await telegram(env,'editMessageText',{...payload,message_id:callback.message.message_id})}catch(e){if(e instanceof SafeError&&e.message==='telegram_rate_limited')throw e;return null}}return telegram(env,'sendMessage',payload)}
async function settings(env,user,callback=null){const p=await work(env,user,'get'),text='🔔 إشعاراتي\n\nإعلانات العروض: '+(p.enabled?'شغّالة ✅':'متوقفة')+'\nالمحافظة: '+(p.scope==='all'?'جميع المحافظات':p.governorate||'لم تختَر بعد')+'\nالأقسام: '+(p.categories?.length?p.categories.join('، '):'كل الأقسام')+'\nتنبيهات الرسائل والحساب: '+(p.operational&&p.operational_consent_at?'شغّالة':'متوقفة')+'\n\nنفس الاختيارات محفوظة بالبـوت والتطبيق. تگدر تغيّرها بأي وقت.';await render(env,user,callback,text,settingsKeyboard(p));return p}
export async function maybePromptSubscription(env,user,surface='bot'){
 const p=await work(env,user,'onboarding_claim',{surface});if(!p.show)return {shown:false};
 const message=await telegram(env,'sendMessage',{chat_id:user.id,text:SUBSCRIPTION_PROMPT,reply_markup:subscriptionPromptKeyboard()});return {shown:true,message_id:message.message_id};
}
function privateActor(update){const cb=update.callback_query,msg=cb?.message||update.message,from=cb?.from||update.message?.from;if(!from||from.is_bot||msg?.chat?.type!=='private'||msg.chat.id!==from.id)return null;return {id:from.id,name:from.first_name||'مستخدم'}}
export async function handleSubscriptionUpdate(env,update){
 const user=privateActor(update);if(!user)return false;
 const cb=update.callback_query,input=String(update.message?.text||'').trim(),data=cb?.data||'';
 if(!cb){if(!/^\/notifications(?:@WaseetIraqMarketBot)?(?:\s|$)/i.test(input)&&input!=='🔔 إشعاراتي')return false;await settings(env,user);return true}
 if(!data.startsWith('ns:')&&!['notify:enable','notify:stop'].includes(data))return false;
 // Callback identity is the private chat's authenticated sender, never URL data.
 let toast='حفظنا اختيارك.';try{
  if(data==='ns:enable'||data==='notify:enable'){await work(env,user,'onboarding_enable',{confirmed:true});await render(env,user,cb,'تمام! اختار محافظتك حتى نجيب لك العروض القريبة 👇',provinceKeyboard())}
  else if(data==='ns:later'){await work(env,user,'onboarding_defer');await render(env,user,cb,'على راحتك 🌹 حفظنا «مو هسه». تگدر تفعّلها بعدين من «🔔 إشعاراتي».',{inline_keyboard:[[{text:'🔔 إشعاراتي',callback_data:'ns:settings'}]]})}
  else if(data==='ns:settings')await settings(env,user,cb);
  else if(data==='ns:province')await render(env,user,cb,'اختار محافظتك 👇',provinceKeyboard());
  else if(/^ns:gov:\d+$/.test(data)){const value=GOVERNORATES[Number(data.slice(7))];if(!value)throw new SafeError('invalid_governorate');const p=await work(env,user,'onboarding_filter',{governorate:value,update:update.update_id});await render(env,user,cb,'محافظتك: '+value+'\nاختار الأشياء اللي تدور عليها، وبعدها احفظ وفعّل 👇',categoryKeyboard(p))}
  else if(/^ns:cat:\d+$/.test(data)||data==='ns:allcats'){const category=CATEGORIES[Number(data.slice(7))];if(data!=='ns:allcats'&&!category)throw new SafeError('invalid_category');const p=await work(env,user,'onboarding_filter',data==='ns:allcats'?{all_categories:true,update:update.update_id}:{category,update:update.update_id});await render(env,user,cb,'محافظتك: '+(p.governorate||'اختارها أولاً')+'\nالأقسام: '+(p.categories?.length?p.categories.join('، '):'كل الأقسام')+'\nاضغط «احفظ وفعّل» حتى يبدأ الاشتراك.',categoryKeyboard(p))}
  else if(data==='ns:done'){const p=await work(env,user,'get');if(!p.governorate){await render(env,user,cb,'اختار محافظتك أولاً 👇',provinceKeyboard());toast='اختار محافظتك أولاً.'}else{await work(env,user,'save',{enabled:true,confirmed:true,scope:'governorate',governorate:p.governorate,categories:p.categories||[],operational:!!(p.operational&&p.operational_consent_at),rep_goods:p.rep_goods!==false});await render(env,user,cb,SUBSCRIPTION_SUCCESS,{inline_keyboard:[[{text:'🔔 إشعاراتي',callback_data:'ns:settings'},{text:'🛍️ افتح السوق',url:url('home')}]]});toast='تم تفعيل الإعلانات المناسبة ✅'}}
  else if(data==='ns:offers'||data==='ns:operational'){const p=await work(env,user,'get');if(data==='ns:offers'&&!p.enabled){await work(env,user,'onboarding_enable',{confirmed:true});await render(env,user,cb,'اختار محافظتك 👇',provinceKeyboard())}else{await work(env,user,'save',{enabled:data==='ns:offers'?false:!!p.enabled,confirmed:true,scope:p.scope||'all',governorate:p.governorate,categories:p.categories||[],operational:data==='ns:operational'?!(p.operational&&p.operational_consent_at):!!(p.operational&&p.operational_consent_at),rep_goods:p.rep_goods!==false});await settings(env,user,cb)}}
  else if(data==='ns:alloff'||data==='notify:stop'){await work(env,user,'unsubscribe');await settings(env,user,cb);toast='توقفت الإشعارات الاختيارية.'}
  else if(data==='ns:pause'){await work(env,user,'pause');await settings(env,user,cb);toast='توقفت الإشعارات 24 ساعة.'}
  else throw new SafeError('invalid_subscription_action');
 }finally{await telegram(env,'answerCallbackQuery',{callback_query_id:cb.id,text:toast}).catch(()=>{})}
 return true;
}
