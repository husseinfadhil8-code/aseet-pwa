import {testDeliveryMessage,WELCOME_MESSAGE,SUBSCRIPTION_PROMPT,SUBSCRIPTION_SUCCESS,SUBSCRIPTION_GOVERNORATES} from './subscription-copy.js';
import {confirmAction} from './ui-runtime.js';
export async function requestNotificationPermission(tg,{timeoutMs=20000}={}){
 let supported=false;try{supported=tg?.isVersionAtLeast?.('6.9')===true&&typeof tg.requestWriteAccess==='function'}catch{}
 if(!supported)return 'unsupported';
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('لم يصل تأكيد إذن المراسلة. ابدأ محادثة البوت ثم حاول مجدداً.')),timeoutMs);try{tg.requestWriteAccess(granted=>{clearTimeout(timer);resolve(granted===true)})}catch{clearTimeout(timer);reject(Error('تعذر طلب إذن المراسلة. ابدأ البوت من الرابط أدناه.'))}});
}
export const GOVERNORATES=SUBSCRIPTION_GOVERNORATES;
export {testDeliveryMessage} from './subscription-copy.js';
export function notificationUI({sheet,text,button,api,tg,cats,notice,openRadar,openOperational,close}){
 const call=async(operation,data={})=>(await api('/api/notifications',{operation,data})).data;
 function botLink(label='فتح محادثة البوت'){const a=text('a',label,'primary');a.href='https://t.me/WaseetIraqMarketBot?start=notifications';return a}
 function select(form,label,name,values,value){const l=text('label',label,'field'),s=document.createElement('select');s.name=name;for(const [key,title]of values)s.append(new Option(title,key));s.value=value||values[0][0];l.append(s);form.append(l);return s}
 function check(form,label,name,value){const l=text('label',label,'field'),i=document.createElement('input');i.type='checkbox';i.name=name;i.checked=!!value;l.prepend(i);form.append(l);return i}
 async function testOwnNotifications(){
  const p=await call('get');
  if(!p.bot_started||p.blocked){const b=sheet('ابدأ البوت أولاً');b.append(text('p',p.blocked?'ألغِ حظر البوت واضغط Start بمحادثته، حتى نكدر نرسل لك اختباراً خاصاً.':'اضغط Start بمحادثة بوت وسيط، وبعدها ارجع واضغط «اختبار إشعاراتي». هذا ما يفعّل اشتراك الإعلانات.'),botLink('ابدأ @WaseetIraqMarketBot'),button('رجوع إلى إشعاراتي',()=>settings()));return}
  if(!await confirmAction('أوافق على رسالة اختبار واحدة إلى حسابي من بوت وسيط. هذا الاختبار لا يفعّل اشتراك الإعلانات.'))return;
  const request=crypto.randomUUID(),body=sheet('🔔 اختبار إشعاراتي'),status=text('p','جارٍ تسجيل اختبارك…','record');body.append(status,botLink());
  let refreshTimer=null,polls=0;body.onDiscard=()=>clearTimeout(refreshTimer);
  const show=result=>{status.textContent=testDeliveryMessage(result);if(['sent','failed','cancelled','review'].includes(result?.state)){clearTimeout(refreshTimer);return}if(body.isConnected&&++polls<=10)refreshTimer=setTimeout(()=>refresh().catch(()=>{}),2000)};
  async function refresh(){if(!body.isConnected)return;const result=await call('user_test_status',{request});if(body.isConnected)show(result);return result}
  async function submit(){try{const result=await call('user_test',{confirmed:true,request});if(body.isConnected)show(result)}catch(e){if(!body.isConnected)return;status.textContent='لم يصل تأكيد تسجيل الطلب. راجع الحالة أولاً؛ لن نرسل اختباراً جديداً تلقائياً.';notice(e.message)}}
  body.append(button('تحديث حالة الاختبار',async()=>{clearTimeout(refreshTimer);polls=10;await refresh()}),button('إعادة نفس طلب الاختبار',async()=>{clearTimeout(refreshTimer);const result=await refresh();if(result?.state==='not_found')await submit()}));await submit();
 }
 async function settings({onboarding=false}={}){
  const body=sheet(onboarding?'اختار محافظتك واهتماماتك':'🔔 إشعاراتي',{retry:()=>settings({onboarding})}),p=await call('get');if(!body.isConnected)return;
  const form=document.createElement('form');body.append(text('p',onboarding?'خطوة سريعة ونخلّي العروض المناسبة تجيك. ما نفعّل إرسال الإعلانات إلا بعد حفظ اختياراتك.':'إعداداتك محفوظة لحسابك ومتزامنة بين البوت والتطبيق. التنبيهات توصل بمحادثة البوت حتى والسوق مغلق.','muted'));
  const enabled=check(form,'🔔 إشعارات الإعلانات والعروض المناسبة','enabled',onboarding||p.enabled),scope=select(form,'المنطقة','scope',[['governorate','محافظتي فقط'],['all','جميع المحافظات']],onboarding?'governorate':p.scope),gov=select(form,'محافظتك','governorate',[['','اختار محافظتك'],...GOVERNORATES.map(x=>[x,x])],p.governorate);
  scope.onchange=()=>{gov.required=enabled.checked&&scope.value==='governorate';gov.disabled=scope.value!=='governorate'};enabled.onchange=scope.onchange;scope.onchange();
  const categories=text('fieldset','');categories.append(text('legend','الأشياء اللي تدور عليها'),text('p','اختار قسم أو أكثر. إذا تركتها فارغة، توصلك كل أقسام المنطقة اللي تختارها.','muted'));const boxes=cats.filter(c=>c!=='الكل').map(c=>[c,check(categories,c,'category',p.categories?.includes(c))]);form.append(categories);
  const operational=check(form,'تنبيهات الرسائل والحساب وقرارات طلباتي','operational',p.operational&&p.operational_consent_at),goods=check(form,'أغراض المندوبين عند اعتمادي كمندوب','rep_goods',p.rep_goods);
  if(p.blocked)body.append(text('p','البوت ما يگدر يراسلك حالياً. ألغِ حظره وابدأ محادثته، وبعدها ارجع فعّل إشعاراتك.','record'));
  if(!p.bot_started)body.append(text('p','تگدر تحفظ اختياراتك الآن. الإرسال يبدأ بعد ما تضغط Start بمحادثة البوت.','muted'),botLink('ابدأ البوت حتى يگدر يراسلك'));
  if(p.paused_until)body.append(text('p','الإيقاف المؤقت حتى '+new Date(p.paused_until).toLocaleString('ar-IQ'),'record'));
  const save=text('button',onboarding?'✅ احفظ وفعّل إشعاراتي':'حفظ إعدادات إشعاراتي','primary');save.type='submit';form.append(save);
  form.onsubmit=async e=>{e.preventDefault();if(save.disabled)return;save.disabled=true;try{await call('save',{enabled:enabled.checked,confirmed:true,scope:scope.value,governorate:gov.value||null,categories:boxes.filter(([,i])=>i.checked).map(([c])=>c),operational:operational.checked,rep_goods:goods.checked});if(!body.isConnected)return;const done=sheet('حُفظت إشعاراتك');done.append(text('p',enabled.checked?(p.bot_started?SUBSCRIPTION_SUCCESS:'✅ حُفظت موافقتك واختياراتك. ابدأ محادثة البوت حتى توصل لك العروض المناسبة.'):operational.checked?'✅ حُفظت إعداداتك. إعلانات العروض متوقفة، وتنبيهات الرسائل والحساب حسب اختيارك.':'حُفظ اختيارك بإيقاف الإشعارات الاختيارية.'),button('🔔 اختبار إشعاراتي',testOwnNotifications),button('🔔 إشعاراتي',()=>settings()),button('رجوع للسوق',()=>close?.()));if(!p.bot_started)done.append(botLink('ابدأ البوت لإكمال الاستقبال'))}catch(e){if(e.code!=='view_changed')notice(e.message)}finally{save.disabled=false}};
  body.append(form,button('🔔 اختبار إشعاراتي',testOwnNotifications));
  if(openRadar)body.append(button('🎯 إدارة كلمات راداري',openRadar));if(openOperational)body.append(button('التحكم بأنواع تنبيهات الرسائل والحساب',openOperational));
  body.append(button('إيقاف الإشعارات لمدة 24 ساعة',async()=>{await call('pause');return settings()}),button('إيقاف جميع الإشعارات الاختيارية',async()=>{if(!await confirmAction('توقف الإعلانات والتنبيهات الاختيارية كلها؟ تگدر ترجع تفعّلها من هنا.'))return;await call('unsubscribe');return settings()}));
 }
 async function onboarding({host=null}={}){
  const welcome=await call('welcome_claim',{surface:'miniapp'}),state=await call('onboarding_claim',{surface:'miniapp'});if(!welcome.show&&!state.show||host&&!host.isConnected)return false;
  const inline=host?.isConnected===true,body=inline?text('section','','record subscription-prompt'):sheet(welcome.show?'هلا بيك بوسيط 🌹':'🔔 عروض على ذوقك');if(inline)host.prepend(body);
  const dismiss=()=>inline?body.remove():close?.();
  if(welcome.show)body.append(text('p',WELCOME_MESSAGE));
  if(state.show)body.append(text('p',SUBSCRIPTION_PROMPT,'subscription-prompt'),button('فعّل الإشعارات',async()=>{await call('onboarding_enable',{confirmed:true});if(inline)body.remove();return settings({onboarding:true})}),button('مو هسه',async()=>{await call('onboarding_defer');notice('حفظنا اختيارك. تگدر تفعّلها بعدين من «🔔 إشعاراتي».');dismiss()}));
  else body.append(button('تمام، خل أكتشف السوق',dismiss));
  return true;
 }
 async function stats(){const b=sheet('سجل وإحصائيات الإشعارات',{retry:()=>stats()}),r=await call('stats');if(!b.isConnected)return;b.append(text('p','النظام: '+(r.enabled?'يعمل':'موقوف حتى اختبار الإرسال')+' · المشتركون: '+r.subscribers));const labels={pending:'بانتظار الإرسال',sending:'جارٍ الإرسال',sent:'أُرسلت',failed:'فشل مؤكد',review:'نتيجة غير مؤكدة',cancelled:'أُلغيت'};for(const [key,n]of Object.entries(r.states||{}))b.append(text('p',(labels[key]||key)+': '+n));if(r.last_cron_at)b.append(text('p','آخر معالجة دورية: '+new Date(r.last_cron_at).toLocaleString('ar-IQ')));b.append(text('p','النتيجة غير المؤكدة لا تعاد تلقائياً لمنع التكرار. سجلات الإرسال تظهر دون محتوى رسائل أو معرفات تلغرام.','muted'));b.append(button('إرسال اختبار خاص إلى حسابي',async()=>{if(!await confirmAction('أوافق على استقبال رسالة اختبار خاصة على حسابي، دون تفعيل اشتراك الإعلانات.'))return;await call('test',{confirmed:true,request:crypto.randomUUID()});notice('وُضع اختبارك في الطابور؛ راجع محادثة البوت.')}));for(const q of r.recent||[])b.append(text('p',q.kind+' · '+(labels[q.state]||q.state)+' · محاولات '+q.attempts+(q.error_code?' · '+q.error_code:''),'record'))}
 async function goods(id=null){const b=sheet('أغراض المندوبين',{retry:()=>goods(id)}),rows=await call('goods',id?{id}:{});if(!b.isConnected)return;for(const g of rows)b.append(text('h2',g.title),text('p',Number(g.price).toLocaleString('ar-IQ')+' د.ع · '+g.area),text('p',g.description,'record'));if(!rows.length)b.append(text('p','لا توجد أغراض مخصصة للمندوبين حالياً.'))}
 return {settings,onboarding,testOwnNotifications,stats,goods,call};
}
