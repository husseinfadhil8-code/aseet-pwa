// Shared webview behavior: no implicit page navigation, no mutation auto-retry.
export class UIError extends Error{constructor(message,code){super(message);this.code=code}}
const messages={campaign_full:'اكتملت حجوزات الحملة؛ لا نقبل اشتراكات نقدية جديدة حالياً.',campaign_full_or_changed:'اكتمل السقف أو تغيرت الحملة. حدّث الصفحة؛ لم يُحجز مبلغ جديد.',campaign_not_activated:'الحملة ليست متاحة للاشتراك النقدي حالياً.',membership_permission_unverified:'يتعذر التحقق من عضوية القناة حالياً؛ لم نحتسب استحقاقاً جديداً.',start_bot_required:'ابدأ بوت وسيط أولاً من حسابك، ثم ارجع للاشتراك بالحملة.',not_eligible:'لم تكتمل 30 دعوة مؤهلة بعد التحقق الحالي. تحقق من مدة الأهلية وعضوية القناة.',eligibility_check_retry_required:'استغرق التحقق وقتاً أطول؛ لم ننشئ طلب سحب جديداً. حدّث الحالة وأعد المحاولة.',reward_enrollment_required:'اشترك واحجز مكافأتك قبل بدء الدعوات النقدية.',reward_enrollment_rejected:'هذا الاشتراك مرفوض بعد المراجعة؛ راجع سبب القرار.',payment_evidence_required:'يلزم اعتماد الطلب أولاً وتأكيد دفع منفذ فعلياً مع مرجعه.',budget_below_commitments:'لا يمكن تخفيض السقف تحت الالتزامات القائمة أو تغيير عدد الحجوزات بصورة غير متوافقة.',invalid_private_iqd_budget:'راجع سقف الدينار ومقابل المكافأة؛ الميزانية للمدير فقط.',existing_reward_terms_locked:'لا يمكن تغيير مقابل المكافأة أو مدة الأهلية بعد وجود التزامات.',save_needs_review:'نتيجة الحفظ غير مؤكدة. افتح إعلاناتي وتحقق قبل بدء مسودة جديدة؛ لن نكرر الحفظ تلقائياً.',save_in_progress:'الحفظ جارٍ؛ انتظر وتحقق من إعلاناتي.',save_payload_changed_review_existing_ads:'تغيرت المسودة بعد طلب حفظ سابق. راجع إعلاناتي قبل إنشاء مسودة جديدة.',rewards_not_activated:'برنامج المكافآت غير مفعّل مالياً.',broadcast_delivery_not_activated:'الإرسال الجماعي مقفول حتى الموافقة على الحملة.',services_schema_not_ready:'نشر الخدمات ينتظر تهيئة قاعدة البيانات بصلاحية مخوّلة.',platform_not_ready:'الميزات الإضافية غير مهيأة على الخادم بعد.',channel_pin_permission_required:'يحتاج البوت صلاحية تعديل رسائل القناة لتثبيت التعريف.',intro_uncertain_review_required:'نتيجة نشر التعريف غير مؤكدة. راجع القناة قبل أي إعادة نشر.',owner_protected:'حساب المدير الرئيسي محمي ولا يمكن تغيير صلاحياته.',user_version_conflict:'تغيرت صلاحية الحساب على الخادم. حدّث البطاقة قبل المحاولة مجدداً.',user_save_not_verified:'تعذر التحقق من الحفظ. حدّث حالة الحساب قبل إعادة المحاولة.',conversation_unavailable:'هذه المحادثة غير متاحة لهذا الحساب.',not_found:'العنصر غير متاح حالياً أو أُزيل من السوق.',telegram_session_required:'انتهت جلسة تلغرام. أغلق السوق ثم افتحه مجدداً من زر التطبيق؛ تبقى بيانات هذه الصفحة حتى تختار العودة.',action_denied:'تعذر تنفيذ الطلب بهذه الصلاحية أو بهذه البيانات. راجع الحقول وحالة حسابك.',owner_required:'هذه العملية متاحة للمدير الرئيسي فقط.',channel_type_required:'هذا المعرف لمجموعة نقاش. استخدم معرف قناة الإعلانات نفسها.',channel_unreachable:'تعذر العثور على القناة. تأكد من المعرف وإضافة البوت إلى القناة نفسها، وليس مجموعة النقاش.',channel_bot_not_member:'أضف بوت وسيط مشرفاً داخل القناة ثم أعد التحقق.',channel_permission_required:'البوت يحتاج صلاحية نشر الرسائل داخل القناة.',invalid_channel:'أدخل @اسم_القناة أو معرفاً يبدأ بـ -100. تقبل الأرقام العربية أيضاً.',channel_not_configured:'اربط قناة الإعلانات أولاً.',listing_approval_required:'راجع الإعلان واعتمده قبل نشره في القناة.',channel_publication_needs_review:'نتيجة النشر غير مؤكدة. راجع القناة وسجل الإرسال قبل إعادة المحاولة.',repost_cooldown:'انتظر خمس دقائق بين عمليتي إعادة نشر.',payments_not_enabled:'الترويج المدفوع غير متاح حالياً.',payment_test_required:'الشراء العام مقفل حتى إكمال اختبار الدفع والاسترداد.',package_version_conflict:'تغيرت الباقة على الخادم؛ أعد فتحها قبل الحفظ.',existing_campaign_differs:'لديك طلب ترويج قائم لهذا الإعلان؛ راجعه قبل اختيار باقة أخرى.',database_unavailable:'الخادم غير متاح مؤقتاً. حاول بعد قليل.',telegram_unavailable:'تعذر الاتصال بتلغرام حالياً. راجع الحالة قبل تكرار العملية.',database_schema_not_ready:'هذه الوظيفة غير جاهزة على الخادم. لم نغيّر صلاحيات حسابك.',publication_image_unavailable:'تعذر تجهيز صورة الإعلان. راجع سجل النشر قبل المحاولة مجدداً.'};
export function createAPI({getInitData=()=>'',onError=()=>{},fetcher=(...a)=>fetch(...a),timeoutMs=20000}={}){
 return async function api(path,body,options={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeoutMs|| ((path==='/api/channel'||path==='/api/action'&&body?.action==='admin_listing_approve')?65000:['/api/channel/settings','/api/images'].includes(path)?35000:timeoutMs));
  const binary=typeof Blob!=='undefined'&&body instanceof Blob;
  try{
   const r=await fetcher(path,{method:body===undefined?'GET':'POST',headers:{'content-type':binary?body.type:'application/json','x-telegram-init-data':getInitData()||''},...(body===undefined?{}:{body:binary?body:JSON.stringify(body)}),signal:controller.signal});
   let data;try{data=await r.json()}catch{throw new UIError('وصل رد غير مكتمل من الخادم. تحقق من الحالة قبل تكرار الحفظ.','invalid_response')}
   if(!r.ok){const code=data?.error||'service_unavailable';throw new UIError(messages[code]||(r.status===429?'طلبات كثيرة حالياً. انتظر قليلاً قبل المحاولة.':'تعذر إكمال الطلب. حاول لاحقاً أو راجع الصلاحية والبيانات.'),code)}
   return data;
  }catch(e){const error=e instanceof UIError?e:new UIError(controller.signal.aborted?'استغرق الطلب وقتاً أطول من المتوقع. تحقق من الحالة قبل إعادة الحفظ أو الإرسال.':'تعذر الاتصال. بيانات النموذج محفوظة في هذه الصفحة؛ تحقق من الشبكة ثم حاول مجدداً.',controller.signal.aborted?'request_timeout':'network_error');onError(error);throw error}finally{clearTimeout(timer)}
 };
}
let pendingConfirmation=null;
export function cancelConfirmation(){if(!pendingConfirmation)return false;pendingConfirmation(false);return true}
export function confirmAction(message){
 if(pendingConfirmation)return Promise.resolve(false);
 return new Promise(resolve=>{
  document.activeElement?.blur();const d=document.createElement('dialog');d.className='confirmation';d.setAttribute('aria-label','تأكيد العملية');
  const title=document.createElement('h2');title.textContent='تأكيد العملية';const p=document.createElement('p');p.textContent=message;
  const actions=document.createElement('div');actions.className='actions';const yes=document.createElement('button'),no=document.createElement('button');yes.type=no.type='button';yes.textContent='تأكيد';yes.className='primary';no.textContent='إلغاء';actions.append(no,yes);d.append(title,p,actions);document.body.append(d);
  const finish=value=>{if(pendingConfirmation!==finish)return;pendingConfirmation=null;d.close?.();d.remove();resolve(value)};pendingConfirmation=finish;yes.onclick=()=>finish(true);no.onclick=()=>finish(false);d.addEventListener('cancel',e=>{e.preventDefault();finish(false)});d.addEventListener('close',()=>finish(false));
  if(d.showModal)d.showModal();else d.setAttribute('open','');no.focus();
 });
}
export function createNotice(element){let timer;
 const home=element.parentElement;
 const rehome=()=>{const dialogs=[...document.querySelectorAll('dialog[open]')];(dialogs.at(-1)||home).append(element)};
 document.addEventListener('close',rehome,true);
 return function notice(message){clearTimeout(timer);rehome();element.textContent=message;element.hidden=false;timer=setTimeout(()=>element.hidden=true,8000)};
}
export function createViews({dialog,title,host,backButton,dismissButton,tg,onLeave=()=>{},onError=()=>{}}){
 const frames=[];let baseScroll=0,oldOverflow='',oldPosition='',oldTop='',oldWidth='',opener=null;
 const native=(name)=>{try{tg?.BackButton?.[name]?.()}catch{}};
 function discard(frame){frame?.body._stopLoading?.();try{frame?.body.onDiscard?.()}catch{}}
 function restorePage(){document.body.style.overflow=oldOverflow;document.body.style.position=oldPosition;document.body.style.top=oldTop;document.body.style.width=oldWidth;window.scrollTo(0,baseScroll)}
 function focus(element){try{element?.focus?.({preventScroll:true})}catch{}}
 function show(frame,resume=false){title.tabIndex=-1;title.textContent=frame.title;host.replaceChildren(frame.body);dialog.scrollTop=frame.scroll||0;backButton.textContent=frames.length>1?'رجوع':'السوق';native('show');focus(resume&&frame.focused?.isConnected?frame.focused:title);if(resume){const action=frame.body.onResume||(frame.body.querySelector('.view-loading')?frame.retry:null);Promise.resolve(action?.()).catch(onError)}}
 function closeAll(){if(cancelConfirmation())return;if(!frames.length){native('hide');return}onLeave();for(const f of frames)discard(f);frames.length=0;if(dialog.open)dialog.close();host.replaceChildren();native('hide');restorePage();focus(opener)}
 function back(){if(cancelConfirmation())return;if(frames.length<2)return closeAll();onLeave();discard(frames.pop());show(frames.at(-1),true)}
 function open(viewTitle,{key=viewTitle,retry=null}={}){
  onLeave();if(!frames.length){opener=document.activeElement;baseScroll=window.scrollY;oldOverflow=document.body.style.overflow;oldPosition=document.body.style.position;oldTop=document.body.style.top;oldWidth=document.body.style.width;document.body.style.overflow='hidden';document.body.style.position='fixed';document.body.style.top=-baseScroll+'px';document.body.style.width='100%'}
  else{frames.at(-1).scroll=dialog.scrollTop;frames.at(-1).focused=document.activeElement}
  const previous=frames.findIndex(f=>f.key===key);if(previous>=0){for(const f of frames.splice(previous))discard(f)}
  if(frames.length>=12)discard(frames.shift());
  const body=document.createElement('section'),placeholder=document.createElement('p');placeholder.className='view-loading';placeholder.setAttribute('role','status');placeholder.textContent='جارٍ التحميل…';body.append(placeholder);body.setAttribute('aria-busy','true');
  const observer=new MutationObserver(()=>{if(body.children.length>1){placeholder.remove();body.removeAttribute('aria-busy');observer.disconnect()}});observer.observe(body,{childList:true});body._stopLoading=()=>{observer.disconnect();placeholder.remove();body.removeAttribute('aria-busy')};
  const frame={key,title:viewTitle,body,retry,scroll:0};frames.push(frame);show(frame);if(!dialog.open){if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');focus(title)};return body;
 }
 function failIfEmpty(error){const f=frames.at(-1);if(!f||!f.body.querySelector('.view-loading'))return;f.body._stopLoading();const p=document.createElement('p');p.className='record error-state';p.setAttribute('role','alert');p.textContent=error.message;f.body.append(p);if(f.retry){const b=document.createElement('button');b.type='button';b.textContent='إعادة المحاولة';b.onclick=()=>Promise.resolve(f.retry()).catch(onError);f.body.append(b)}}
 let boundBack=null;function bindTelegram(){const b=tg?.BackButton;if(!b||b===boundBack)return;boundBack=b;try{b.onClick(back)}catch{}if(frames.length)native('show');else native('hide')}
 backButton.onclick=back;dismissButton.onclick=closeAll;dialog.addEventListener('cancel',e=>{e.preventDefault();back()});dialog.addEventListener('close',()=>{if(frames.length)closeAll()});bindTelegram();native('hide');
 return {open,back,closeAll,failIfEmpty,bindTelegram,get currentKey(){return frames.at(-1)?.key||null},get currentBody(){return frames.at(-1)?.body||null},get depth(){return frames.length},get scroll(){return frames.length?baseScroll:window.scrollY}};
}
export async function prepareImage(file){
 if(file.size>20971520||!file.type.startsWith('image/'))throw new UIError('اختر صورة أصغر من20MB.','invalid_image');
 let source,url,bitmap;
 try{
  if(typeof createImageBitmap==='function'){try{bitmap=await createImageBitmap(file);source=bitmap}catch{}}
  if(!source){url=URL.createObjectURL(file);source=await new Promise((resolve,reject)=>{const im=new Image(),timer=setTimeout(()=>reject(new UIError('تعذر تجهيز الصورة. جرّب نسخة JPEG أو PNG.','invalid_image')),15000);im.onload=()=>{clearTimeout(timer);resolve(im)};im.onerror=()=>{clearTimeout(timer);reject(new UIError('تعذر قراءة الصورة. جرّب JPEG أو PNG.','invalid_image'))};im.src=url})}
  const width=source.width||source.naturalWidth,height=source.height||source.naturalHeight,scale=Math.min(1,1600/Math.max(width,height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));canvas.getContext('2d').drawImage(source,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.86));if(!blob||blob.size>5242880)throw new UIError('تعذر ضغط الصورة؛ اختر صورة أصغر.','invalid_image');return blob;
 }finally{bitmap?.close();if(url)URL.revokeObjectURL(url)}
}
export function readLaunchData(locationObject=typeof window!=='undefined'?window.location:null){if(!locationObject)return '';const data=new URLSearchParams(locationObject.hash?.replace(/^#/,'')||'').get('tgWebAppData')||new URLSearchParams(locationObject.search||'').get('tgWebAppData')||'';return data.length<=8192?data:''}
export function telegramHandle(get=()=>window.Telegram?.WebApp,raw=()=>readLaunchData()){return new Proxy({},{get(_target,key){const sdk=get();if(key==='initData')return sdk?.initData||raw();const value=sdk?.[key];return typeof value==='function'?value.bind(sdk):value}})}
export async function waitForTelegram(timeoutMs=5000){if(window.Telegram?.WebApp||document.getElementById('telegramSdk')?.dataset.state==='failed')return;await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);window.removeEventListener('waseet:telegram',finish);resolve()};const timer=setTimeout(finish,timeoutMs);window.addEventListener('waseet:telegram',finish)})}

export function installVisualViewport(){const sync=()=>{const height=window.visualViewport?.height||window.innerHeight;if(Number.isFinite(height)&&height>0)document.documentElement.style.setProperty('--visible-height',height+'px')};window.visualViewport?.addEventListener('resize',sync);window.addEventListener('resize',sync);sync()}
