/* Market administration complements the existing staff dashboard. */
(function(){
'use strict';
function node(tag,value){const e=document.createElement(tag);e.textContent=value;return e}
function button(title,run){const b=node('button',title);b.type='button';b.className='pm-secondary';b.onclick=async()=>{b.disabled=true;try{await run()}catch(_){alert('تعذّر تنفيذ الإجراء')}finally{b.disabled=false}};return b}
async function admin(){
 if(typeof isAdmin!=='function'||!isAdmin())return;
 document.getElementById('pmSheetTitle').textContent='إدارة السوق والمستخدمين';document.getElementById('pmSheet').hidden=false;
 const body=document.createElement('div');document.getElementById('pmSheetBody').replaceChildren(body);
 body.append(node('p','المبيعات والعمولات والمندوبون ضمن لوحة الإدارة الأصلية؛ إعلانات السوق ومدفوعاتها مستقلة عنها.'));
 try{
  const [members,listings]=await Promise.all([db.from('market_members').select('user_id,display_name,suspended,created_at').order('created_at',{ascending:false}).limit(100),db.from('market_listings').select('id,title,status,seller_id,created_at').neq('status','deleted').order('created_at',{ascending:false}).limit(100)]);
  if(members.error||listings.error)throw Error();
  body.append(node('h3','آخر '+members.data.length+' حساب · آخر '+listings.data.length+' إعلان'),node('p','إعلانات نشطة ضمن القائمة: '+listings.data.filter(x=>x.status==='active').length+' · مخفية: '+listings.data.filter(x=>x.status==='hidden').length));
  for(const m of members.data){const c=node('section','');c.className='pm-admin-card';c.append(node('strong',m.display_name),node('small',m.user_id),node('p',m.suspended?'حساب مقيّد':'حساب نشط'),button(m.suspended?'رفع تقييد السوق':'تقييد السوق وإخفاء إعلاناته',async()=>{if(!confirm('تأكيد تغيير صلاحية هذا المستخدم في السوق فقط؟'))return;const r=await db.rpc('market_suspend_member',{p_user:m.user_id,p_suspended:!m.suspended});if(r.error)throw Error();if(body.isConnected)await admin()}));body.append(c)}
  body.append(node('h3','الإعلانات'));
  for(const l of listings.data){const c=node('section','');c.className='pm-admin-card';c.append(node('strong',l.title),node('p',({active:'نشط',sold:'مباع',hidden:'مخفي'})[l.status]));
   c.append(button(l.status==='hidden'?'استعادة الإعلان بعد المراجعة':'إخفاء الإعلان',async()=>{if(!confirm('تأكيد قرار مراجعة الإعلان؟'))return;const r=await db.from('market_listings').update({status:l.status==='hidden'?'active':'hidden'}).eq('id',l.id);if(r.error)throw Error();if(body.isConnected)await admin()}));body.append(c)}
 }catch(_){body.append(node('p','إدارة السوق غير متاحة حتى اكتمال فحص قاعدة البيانات.'))}
}
window.WaseetMarketAdmin={show:admin};
})();
