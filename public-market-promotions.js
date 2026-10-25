/* Manual merchant payment UI. Authority and idempotency live in PostgreSQL RPCs. */
(function(){
'use strict';
let orderPage=0;
const labels={awaiting_payment:'بانتظار الدفع',awaiting_verification:'بانتظار التحقق',paid:'مدفوع',active:'مفعّل',expired:'منتهي',rejected:'مرفوض'};
const text=(tag,value)=>{const e=document.createElement(tag);e.textContent=value;return e};
const action=(title,run)=>{const e=text('button',title);e.type='button';e.className='pm-secondary';e.onclick=async()=>{e.disabled=true;try{await run()}catch(_){alert('تعذّر إكمال الطلب. تحقق من الصلاحية وحالة الطلب وحاول مجدداً.')}finally{e.disabled=false}};return e};
async function checked(query){const r=await query;if(r.error)throw Error('unavailable');return r.data}
function panel(title){document.getElementById('pmSheetTitle').textContent=title;document.getElementById('pmSheet').hidden=false;const b=document.createElement('div');document.getElementById('pmSheetBody').replaceChildren(b);return b}
async function order(item){
 const body=panel('ترويج إعلانك');
 body.append(text('h2',item.title),text('p','٥٬٠٠٠ دينار عراقي لمدة ٧ أيام'),text('p','زر «دفعت» يرسل طلب مراجعة فقط. لا يتفعّل الإعلان إلا بعد تحقق الإدارة من استلام المبلغ في حساب التاجر.'));
 try{
  const settings=await checked(db.from('market_payment_settings').select('enabled,merchant_name,qr_url,instructions').eq('id',true).maybeSingle());
  if(!body.isConnected)return;
  if(!settings?.enabled||!settings.qr_url||!settings.merchant_name){body.append(text('p','الدفع غير متاح حالياً حتى تعتمد الإدارة رمز التاجر.'));return}
  const user=(await db.auth.getUser()).data?.user;if(!user)throw Error();
  let orders=await checked(db.from('market_promotions').select('id,status,ends_at,created_at').eq('listing_id',item.id).eq('buyer_id',user.id).order('created_at',{ascending:false}).limit(10));
  for(const previous of orders||[]){const state=previous.status==='active'&&Date.parse(previous.ends_at)<=Date.now()?'expired':previous.status;if(['expired','rejected'].includes(state))body.append(text('p','طلب سابق '+previous.id+' · '+labels[state]))}
  const current=orders?.find(x=>!['rejected','expired'].includes(x.status)&&!(x.status==='active'&&Date.parse(x.ends_at)<=Date.now()));
  if(!current){body.append(action('إنشاء طلب ترويج',async()=>{await checked(db.rpc('market_request_promotion',{p_listing:item.id}));if(body.isConnected)await order(item)}));return}
  body.append(text('p','رقم الطلب: '+current.id),text('p','الحالة: '+(labels[current.status]||current.status)));
  if(current.status==='awaiting_payment'){
   body.append(text('strong','التاجر: '+settings.merchant_name),text('p','امسح الرمز وادفع ٥٬٠٠٠ د.ع. احتفظ برقم الطلب ورقم حركة الدفع للتواصل مع الإدارة.'));
   const url=new URL(settings.qr_url);if(url.protocol!=='https:')throw Error();
   const qr=document.createElement('img');qr.src=url.href;qr.alt='رمز دفع التاجر المعتمد';qr.className='pm-payment-qr';qr.referrerPolicy='no-referrer';body.append(qr,text('p',settings.instructions||''));
   body.append(action('دفعت — إرسال للتحقق',async()=>{await checked(db.rpc('market_submit_payment',{p_order:current.id}));if(body.isConnected)await order(item)}));
  }
  if(current.status==='awaiting_verification')body.append(text('p','تنتظر الإدارة مطابقة الحركة مع المبلغ المستلم فعلياً. صورة الإيصال وحدها ليست إثباتاً نهائياً.'));
  if(current.ends_at)body.append(text('p','نهاية الترويج: '+new Date(current.ends_at).toLocaleString('ar-IQ')));
 }catch(_){body.append(text('p','طلبات الترويج غير متاحة حالياً. لم يتم تحصيل أي مبلغ من التطبيق.'))}
}
async function admin(){
 if(typeof isAdmin!=='function'||!isAdmin())return;
 const body=panel('طلبات الترويج والمدفوعات');
 body.append(text('p','قبل تأكيد الدفع: افتح حساب التاجر وتأكد من المبلغ والحركة فعلياً؛ لا تعتمد صورة الإيصال وحدها.'));
 try{
  const rows=await checked(db.from('market_promotions').select('id,listing_id,status,amount_iqd,ends_at,created_at').order('created_at',{ascending:false}).order('id',{ascending:false}).range(orderPage*50,orderPage*50+49));
  const stats=await checked(db.rpc('market_admin_statistics'));
  body.append(text('p','طلبات مدفوعة: '+stats.paid_orders+' · بانتظار التحقق: '+stats.payment_review+' · حملات نشطة: '+stats.active_promotions),text('p','إجمالي المقبوضات المؤكدة: '+Number(stats.confirmed_gross_iqd).toLocaleString('ar-IQ')+' د.ع — قبل أي استرداد أو تسوية خارجية'));
  body.append(text('p','صفحة الطلبات '+(orderPage+1)));
  if(orderPage>0)body.append(action('الطلبات السابقة',()=>{orderPage--;return admin()}));
  if(rows.length===50)body.append(action('مزيد من الطلبات',()=>{orderPage++;return admin()}));
  for(const r of rows){
   const card=document.createElement('section');card.className='pm-admin-card';
   const effective=r.status==='active'&&Date.parse(r.ends_at)<=Date.now()?'expired':r.status;
   card.append(text('strong',labels[effective]),text('p','رقم الطلب: '+r.id),text('p','الإعلان: '+r.listing_id));
   if(r.status==='awaiting_verification'){
    const ref=document.createElement('input');ref.placeholder='رقم الحركة المؤكدة من حساب التاجر';ref.setAttribute('aria-label',ref.placeholder);ref.maxLength=120;card.append(ref);
    card.append(action('تأكيد استلام ٥٬٠٠٠ د.ع',async()=>{if(ref.value.trim().length<3)throw Error();if(!confirm('هل طابقت هذه الحركة مع استلام ٥٬٠٠٠ د.ع فعلياً في حساب التاجر؟'))return;await checked(db.rpc('market_review_promotion',{p_order:r.id,p_action:'confirm',p_reference:ref.value.trim()}));if(body.isConnected)await admin()}));
   }
   if(r.status==='paid')card.append(action('تفعيل لمدة ٧ أيام',async()=>{await checked(db.rpc('market_review_promotion',{p_order:r.id,p_action:'activate'}));if(body.isConnected)await admin()}));
   if(['awaiting_payment','awaiting_verification'].includes(r.status))card.append(action('رفض الطلب',async()=>{if(!confirm('رفض الطلب غير المدفوع؟'))return;await checked(db.rpc('market_review_promotion',{p_order:r.id,p_action:'reject'}));if(body.isConnected)await admin()}));
   body.append(card);
  }
  const s=await checked(db.from('market_payment_settings').select('*').eq('id',true).maybeSingle());
  const form=document.createElement('form');form.className='pm-admin-card';form.append(text('h3','إعداد رمز التاجر'));
  const inputs={};
  for(const [key,label] of [['merchant_name','اسم التاجر المعتمد'],['qr_url','رابط HTTPS لصورة رمز التاجر'],['instructions','تعليمات الدفع']]){const l=text('label',label);l.className='pm-field';const i=document.createElement('input');i.value=s?.[key]||'';i.type=key==='qr_url'?'url':'text';i.maxLength=key==='instructions'?1000:key==='merchant_name'?120:2048;l.append(i);form.append(l);inputs[key]=i}
  const enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=!!s?.enabled;const l=text('label','إتاحة الدفع اليدوي بعد التحقق من رمز حساب التاجر');l.prepend(enabled);form.append(l);
  const save=text('button','حفظ الإعدادات');save.type='submit';save.className='pm-primary';form.append(save);
  form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{const payload={enabled:enabled.checked,...Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value.trim()]))};if(payload.enabled&&(!payload.merchant_name||!payload.qr_url.startsWith('https://')))throw Error();await checked(db.from('market_payment_settings').update(payload).eq('id',true));alert('تم الحفظ')}catch(_){alert('تعذّر حفظ إعدادات التاجر')}finally{save.disabled=false}};
  body.append(form);
 }catch(_){body.append(text('p','لوحة الدفع غير متاحة حتى اكتمال فحص المخطط والصلاحيات.'))}
}
window.WaseetMarketPayments={order,admin};
})();
