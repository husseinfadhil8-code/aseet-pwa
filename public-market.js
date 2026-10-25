/* Public market phase 1. Public views and data are separate from staff inventory and commissions. */
(function(){
'use strict';
const root=document.createElement('section');
root.id='publicMarket';
root.hidden=true;
root.setAttribute('aria-label','وسيط السوق العام');
root.innerHTML='<header class="pm-head"><div class="pm-top"><button class="pm-icon" type="button" data-pm="staff">دخول الفريق</button><strong class="pm-brand">وسيط</strong><button class="pm-icon" type="button" data-pm="account">حسابي</button></div><input id="pmSearch" class="pm-search" placeholder="ابحث عن غرض، صنف أو منطقة..." aria-label="بحث السوق"></header><div class="pm-scroll" id="pmScroll"><section class="pm-banner"><h2>أهلاً بك في وسيط 🛍️</h2><p>انشر أغراضك مجاناً وتواصل مع المهتمين</p></section><div class="pm-cats" id="pmCats"></div><div class="pm-section"><h2>أحدث الإعلانات</h2><small id="pmCount"></small></div><div class="pm-grid" id="pmGrid"></div><p class="pm-muted" id="pmStatus" role="status"></p><button id="pmLoad" class="pm-secondary" type="button" hidden>تحميل المزيد</button></div><nav class="pm-nav" aria-label="تنقل السوق"><button type="button" data-pm="home"><b>⌂</b>الرئيسية</button><button type="button" data-pm="mine"><b>▤</b>إعلاناتي</button><button type="button" data-pm="add"><b>＋</b>أضف إعلان</button><button type="button" data-pm="account"><b>◉</b>حسابي</button></nav><section id="pmSheet" class="pm-sheet" hidden><header class="pm-sheet-head"><button class="pm-icon" type="button" data-pm="close">رجوع</button><strong id="pmSheetTitle"></strong></header><div class="pm-sheet-body" id="pmSheetBody"></div></section>';
document.querySelector('.app-container')?.appendChild(root);
const el=id=>document.getElementById(id);
const categories=['الكل','أثاث','إلكترونيات','عقارات','سيارات','أجهزة منزلية','ملابس','أخرى'];
let category='الكل',rows=[],next=0,hasMore=false,myOnly=false,identity=null,loading=false;
const fmt=x=>Number(x||0).toLocaleString('ar-IQ')+' د.ع';
const txt=(tag,content,className='')=>{const x=document.createElement(tag);x.textContent=String(content??'');if(className)x.className=className;return x};
const safeUrl=x=>{try{const u=new URL(String(x));return u.protocol==='https:'?u.href:null}catch(_){return null}};
function show(){root.hidden=false;el('welcomeView')?.classList.add('hidden');el('appView')?.classList.add('hidden');el('authView')?.classList.add('hidden');}
function hide(){root.hidden=true;closeSheet();}
function closeSheet(){el('pmSheet').hidden=true;el('pmSheetBody').replaceChildren()}
function sheet(title){el('pmSheetTitle').textContent=title;el('pmSheet').hidden=false;el('pmSheetBody').replaceChildren();return el('pmSheetBody')}
function status(s){el('pmStatus').textContent=s}
function photo(url,alt){const node=txt('div','📦','pm-photo');const src=safeUrl(url);if(src){node.textContent='';const im=document.createElement('img');im.src=src;im.alt=alt||'صورة الإعلان';im.loading='lazy';im.onerror=()=>{node.textContent='📦'};node.append(im)}return node}
function field(form,label,name,type='text',required=true){
 const wrap=txt('label',label,'pm-field'),input=document.createElement(type==='textarea'?'textarea':'input');
 if(type!=='textarea')input.type=type;input.name=name;input.required=required;
 if(name==='price') {input.min='0';input.max='1000000000000'}
 if(name==='title')input.maxLength=120;
 if(name==='description')input.maxLength=3000;
 wrap.append(input);form.append(wrap);return input;
}
function button(label,action){const b=txt('button',label,'pm-secondary');b.type='button';b.addEventListener('click',action);return b}
async function getIdentity(){
 const {data}=await db.auth.getUser();identity=data?.user||null;return identity;
}
async function ensureMember(){
 const user=await getIdentity();if(!user)throw Error('سجّل الدخول أولاً');
 const name=String(user.user_metadata?.full_name||user.email?.split('@')[0]||'مستخدم وسيط').slice(0,80);
 const {data:member,error:readErr}=await db.from('market_members').select('user_id').eq('user_id',user.id).maybeSingle();
 if(readErr)throw Error('السوق العام غير مفعّل بعد في قاعدة البيانات');
 if(!member){
  const {error}=await db.from('market_members').insert({user_id:user.id,display_name:name.length>=2?name:'مستخدم وسيط'});
  if(error)throw Error('تعذّر تفعيل حساب السوق. تحقق من إعدادات الصلاحيات.');
 }
 return user;
}
function renderCategories(){
 const host=el('pmCats');host.replaceChildren();
 categories.forEach(c=>{const b=txt('button',c,'pm-cat');b.type='button';b.setAttribute('aria-pressed',String(c===category));b.onclick=()=>{category=c;myOnly=false;renderCategories();load(true)};host.append(b)});
}
function cards(){
 const host=el('pmGrid');host.replaceChildren();
 for(const item of rows){
  const card=document.createElement('button');card.type='button';card.className='pm-card';
  card.append(photo(item.image_urls?.[0],item.title));
  const info=document.createElement('div');info.className='pm-info';info.append(txt('strong',item.title),txt('span',fmt(item.price),'pm-price'),txt('span','📍 '+item.area,'pm-location'));
  card.append(info);card.addEventListener('click',()=>details(item));host.append(card);
 }
 el('pmCount').textContent=rows.length+' إعلان';
 if(!rows.length && !loading)status('ماكو إعلانات تطابق البحث حالياً.');
 el('pmLoad').hidden=!hasMore;
}
async function load(reset){
 if(loading || !db)return;
 if(reset){next=0;hasMore=false;rows=[];status('جارٍ تحميل الإعلانات…');cards()}
 loading=true;
 try{
  let query=db.from('market_listings').select('id,title,description,category,area,price,condition,negotiable,image_urls,status,seller_id,created_at')
     .order('created_at',{ascending:false}).order('id',{ascending:false}).range(next,next+19);
  if(myOnly){
   const user=await getIdentity();if(!user){account();return}query=query.eq('seller_id',user.id);
  }else query=query.eq('status','active');
  if(category!=='الكل')query=query.eq('category',category);
  const search=el('pmSearch').value.trim().replace(/[%_,()\\]/g,' ').slice(0,60);
  if(search)query=query.or('title.ilike.%'+search+'%,area.ilike.%'+search+'%');
  const {data,error}=await query;
  if(error)throw Error('إعلانات السوق العام غير متاحة حالياً. يلزم تفعيل مخطط السوق بعد فحصه على Waseet-Test.');
  rows=reset?(data||[]):rows.concat(data||[]);next=rows.length;hasMore=(data||[]).length===20;
  status('');
 }catch(e){status(e.message)}
 finally{loading=false;cards()}
}
function details(item){
 const body=sheet(item.title);body.append(photo(item.image_urls?.[0],item.title));
 body.append(txt('h2',item.title),txt('h2',fmt(item.price),'pm-price'),txt('p','📍 '+item.area,'pm-muted'),txt('p','الصنف: '+item.category),txt('p','الحالة: '+(item.condition==='new'?'جديد':'مستعمل')),txt('p',item.negotiable?'السعر قابل للتفاوض':'السعر نهائي'),txt('p',item.description||'لا يوجد وصف'));
 const nav=document.createElement('div');nav.style.cssText='display:flex;gap:8px;flex-wrap:wrap';
 nav.append(button('مشاركة',()=>navigator.share?navigator.share({title:item.title,url:location.href}).catch(()=>{}):navigator.clipboard?.writeText(location.href)));
 if(identity?.id===item.seller_id){
  nav.append(button('تعديل',()=>editor(item)));
  nav.append(button(item.status==='sold'?'إرجاع للنشر':'تم البيع',async()=>{
   const nextStatus=item.status==='sold'?'active':'sold';
   const {error}=await db.from('market_listings').update({status:nextStatus}).eq('id',item.id).eq('seller_id',identity.id);
   if(error){alert('تعذّر تحديث الإعلان');return}closeSheet();load(true);
  }));
 }
 body.append(nav);
}
async function editor(item){
 if(!identity){account();return}
 const body=sheet(item?'تعديل إعلان':'إضافة إعلان مجاني'),form=document.createElement('form');body.append(form);
 const title=field(form,'عنوان الإعلان','title'),price=field(form,'السعر بالدينار','price','number'),area=field(form,'المنطقة','area'),description=field(form,'الوصف','description','textarea',false);
 const image=field(form,'رابط صورة HTTPS (اختياري)','image','url',false);
 const filesLabel=txt('label','صور الغرض من الهاتف (حتى 5 صور، كل صورة بحد أقصى 5MB)','pm-field');
 const files=document.createElement('input');files.type='file';files.accept='image/jpeg,image/png,image/webp';files.multiple=true;files.required=false;
 filesLabel.append(files);form.append(filesLabel);
 const categoryField=txt('label','الصنف','pm-field'),select=document.createElement('select');select.name='category';
 categories.slice(1).forEach(c=>{const option=document.createElement('option');option.value=c;option.textContent=c;select.append(option)});categoryField.append(select);form.insertBefore(categoryField,area.parentElement);
 const condition=txt('label','الحالة','pm-field'),conditionSelect=document.createElement('select');conditionSelect.innerHTML='<option value="used">مستعمل</option><option value="new">جديد</option>';condition.append(conditionSelect);form.append(condition);
 const negotiate=txt('label',' قابل للتفاوض','pm-field'),check=document.createElement('input');check.type='checkbox';check.style.width='auto';negotiate.prepend(check);form.append(negotiate);
 if(item){title.value=item.title;price.value=item.price;area.value=item.area;description.value=item.description||'';image.value=item.image_urls?.[0]||'';select.value=item.category;conditionSelect.value=item.condition;check.checked=item.negotiable}
 const submit=txt('button','حفظ الإعلان','pm-primary');submit.type='submit';form.append(submit);
 form.addEventListener('submit',async e=>{
  e.preventDefault();submit.disabled=true;
  try{
   const user=await ensureMember();
   const link=image.value.trim();if(link&&!safeUrl(link))throw Error('الصورة لازم تبدأ برابط HTTPS صحيح');
   const selected=[...files.files];
   if(selected.length>5)throw Error('تقدر تضيف حتى 5 صور فقط');
   const imageUrls=item?item.image_urls?.slice()||[]:[];
   for(const file of selected){
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5242880||file.size===0)throw Error('الصور لازم تكون JPG أو PNG أو WebP، وكل صورة أقل من 5MB');
    if(imageUrls.length>=5)throw Error('الحد الأعلى 5 صور');
    const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[file.type];
    const path=user.id+'/'+crypto.randomUUID()+'.'+ext;
    const {error:upErr}=await db.storage.from('market-listing-images').upload(path,file,{contentType:file.type,upsert:false});
    if(upErr)throw Error('تعذّر رفع الصور. تأكد من تفعيل مساحة صور السوق العام.');
    const {data:publicData}=db.storage.from('market-listing-images').getPublicUrl(path);
    if(!safeUrl(publicData?.publicUrl))throw Error('تعذّر قراءة رابط الصورة');
    imageUrls.push(publicData.publicUrl);
   }
   if(link){if(imageUrls.length>=5)throw Error('الحد الأعلى 5 صور');imageUrls.push(link)}
   const payload={title:title.value.trim(),price:Number(price.value),area:area.value.trim(),description:description.value.trim(),category:select.value,condition:conditionSelect.value,negotiable:check.checked,image_urls:imageUrls};
   if(!Number.isSafeInteger(payload.price)||payload.price<0)throw Error('السعر غير صحيح');
   if(payload.title.length<5||payload.area.length<2)throw Error('اكتب عنواناً ومنطقة صحيحين');
   const op=item?db.from('market_listings').update(payload).eq('id',item.id).eq('seller_id',user.id):db.from('market_listings').insert({...payload,seller_id:user.id,status:'active'});
   const {error}=await op;if(error)throw Error('تعذّر حفظ الإعلان. تأكد من تفعيل السوق وصلاحيات الحساب.');
   closeSheet();myOnly=false;category='الكل';renderCategories();await load(true);
  }catch(err){alert(err.message)}
  finally{submit.disabled=false}
 });
}
function account(){
 const body=sheet('حساب السوق العام');
 if(identity){
  body.append(txt('p','مسجّل باسم: '+(identity.email||'مستخدم'),'pm-muted'));
  body.append(button('إعلاناتي',()=>{closeSheet();myOnly=true;category='الكل';renderCategories();load(true)}));
  body.append(button('خروج',async()=>{await db.auth.signOut();identity=null;closeSheet();show();load(true)}));
 }else{
  body.append(txt('p','أنشئ حساباً مجانياً حتى تنشر إعلاناتك.','pm-muted'));
  const form=document.createElement('form');body.append(form);
  const full=field(form,'الاسم','name'),email=field(form,'البريد الإلكتروني','email','email'),password=field(form,'كلمة المرور (8 أحرف على الأقل)','password','password');
  const submit=txt('button','إنشاء حساب سوق مجاني','pm-primary');submit.type='submit';form.append(submit);
  form.onsubmit=async e=>{
   e.preventDefault();submit.disabled=true;
   try{
    if(password.value.length<8||full.value.trim().length<2)throw Error('تأكد من الاسم وكلمة المرور');
    const {data,error}=await db.auth.signUp({email:email.value.trim(),password:password.value,options:{data:{account_kind:'market',full_name:full.value.trim()}}});
    if(error)throw error;
    if(data.session){identity=data.user;await ensureMember();closeSheet();await load(true)}
    else {body.replaceChildren(txt('p','راجع بريدك الإلكتروني لتأكيد الحساب، ثم سجّل دخولك.'))}
   }catch(e){alert('تعذّر إنشاء الحساب: '+e.message)}
   finally{submit.disabled=false}
  };
  body.append(button('عندي حساب — تسجيل الدخول',()=>{hide();el('welcomeView')?.classList.add('hidden');el('authView')?.classList.remove('hidden');window.switchAuthMode?.('login')}));
 }
}
function staff(){hide();el('welcomeView')?.classList.remove('hidden');el('welcomeView')?.style.setProperty('display','flex')}
root.addEventListener('click',e=>{
 const action=e.target.closest('[data-pm]')?.dataset.pm;
 if(!action)return;
 if(action==='home'){myOnly=false;category='الكل';renderCategories();closeSheet();load(true)}
 if(action==='mine'){if(!identity){account();return}myOnly=true;category='الكل';renderCategories();closeSheet();load(true)}
 if(action==='add'){if(!identity){account();return}editor()}
 if(action==='account')account();
 if(action==='close')closeSheet();
 if(action==='staff')staff();
});
let searchTimer;el('pmSearch').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(true),350)});
el('pmLoad').addEventListener('click',()=>load(false));
window.WaseetPublicMarket={show:async function(user){identity=user||await getIdentity();show();renderCategories();await load(true)},hide,ensureMember};
renderCategories();
if(!location.hash.includes('type=recovery')){
 db.auth.getSession().then(({data})=>{
  const user=data.session?.user;
  if(!user){show();load(true)}
 }).catch(()=>{show();status('تحقق من اتصال الإنترنت')});
}
})();