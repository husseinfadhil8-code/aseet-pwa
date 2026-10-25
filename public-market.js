/* Public market phase 1. Public views and data are separate from staff inventory and commissions. */
(function(){
'use strict';
const root=document.createElement('section');
root.id='publicMarket';
root.hidden=true;
root.setAttribute('aria-label','وسيط السوق العام');
root.innerHTML='<header class="pm-head"><div class="pm-top"><span class="pm-muted" style="color:#dce8f3">بغداد 🇮🇶</span><strong class="pm-brand">وسيط</strong><button class="pm-icon" type="button" data-pm="account">حسابي</button></div><input id="pmSearch" class="pm-search" placeholder="ابحث عن غرض، صنف أو منطقة..." aria-label="بحث السوق"></header><div class="pm-scroll" id="pmScroll"><section class="pm-banner"><h2>أهلاً بك في وسيط 🛍️</h2><p>انشر أغراضك مجاناً وتواصل مع المهتمين</p></section><div class="pm-cats" id="pmCats"></div><div class="pm-section"><h2>أحدث الإعلانات</h2><small id="pmCount"></small></div><div class="pm-grid" id="pmGrid"></div><p class="pm-muted" id="pmStatus" role="status"></p><button id="pmLoad" class="pm-secondary" type="button" hidden>تحميل المزيد</button></div><nav class="pm-nav" aria-label="تنقل السوق"><button type="button" data-pm="home"><b>⌂</b>الرئيسية</button><button type="button" data-pm="mine"><b>▤</b>إعلاناتي</button><button type="button" data-pm="inbox"><b>♧</b>الرسائل</button><button type="button" data-pm="add"><b>＋</b>أضف إعلان</button><button type="button" data-pm="account"><b>◉</b>حسابي</button></nav><section id="pmSheet" class="pm-sheet" hidden><header class="pm-sheet-head"><button class="pm-icon" type="button" data-pm="close">رجوع</button><strong id="pmSheetTitle"></strong></header><div class="pm-sheet-body" id="pmSheetBody"></div></section>';
document.querySelector('.app-container')?.appendChild(root);
// Never cover authenticated staff UI. Tests and legacy screens may reveal appView
// directly, so keep route surfaces mutually exclusive even on DOM-only navigation.
const staffView=document.getElementById('appView');
if(staffView)new MutationObserver(()=>{
 if(!staffView.classList.contains('hidden'))root.hidden=true;
}).observe(staffView,{attributes:true,attributeFilter:['class']});
const el=id=>document.getElementById(id);
const categories=['الكل','أثاث','إلكترونيات','عقارات','سيارات','أجهزة منزلية','ملابس','أخرى'];
let category='الكل',rows=[],next=0,hasMore=false,myOnly=false,identity=null,loading=false,requestEpoch=0;
const fmt=x=>Number(x||0).toLocaleString('ar-IQ')+' د.ع';
const txt=(tag,content,className='')=>{const x=document.createElement(tag);x.textContent=String(content??'');if(className)x.className=className;return x};
const safeUrl=x=>{try{const u=new URL(String(x));return u.protocol==='https:'?u.href:null}catch(_){return null}};
function show(){
 const admin=typeof isAdmin==='function' && isAdmin();
 let reportsButton=el('pmAdminReports');
 if(admin&&!reportsButton){
  reportsButton=txt('button','بلاغات السوق','pm-icon');reportsButton.id='pmAdminReports';reportsButton.type='button';reportsButton.addEventListener('click',adminReports);
  root.querySelector('.pm-top')?.prepend(reportsButton);
 }
 if(reportsButton)reportsButton.hidden=!admin;
 let backButton=el('pmBackToStaff');
 if(admin&&!backButton){
  backButton=txt('button','لوحة الإدارة','pm-icon');backButton.id='pmBackToStaff';backButton.type='button';
  backButton.addEventListener('click',staff);
  root.querySelector('.pm-top')?.prepend(backButton);
 }
 if(backButton)backButton.hidden=!admin;
 root.hidden=false;el('welcomeView')?.classList.add('hidden');el('appView')?.classList.add('hidden');el('authView')?.classList.add('hidden');}
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
 if(!rows.length && !loading && !el('pmStatus').textContent)status('ماكو إعلانات تطابق البحث حالياً.');
 el('pmLoad').hidden=!hasMore;
}
async function load(reset){
 if(!db)return;
 // Each reset supersedes earlier requests. Old responses must never overwrite newer filters.
 if(!reset && loading)return;
 const epoch=reset?++requestEpoch:requestEpoch;
 if(reset){next=0;hasMore=false;rows=[];status('جارٍ تحميل الإعلانات…');cards()}
 loading=true;
 const offset=next;
 try{
  let query=db.from('market_listings').select('id,title,description,category,area,price,condition,negotiable,image_urls,status,seller_id,created_at')
     .order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+19);
  if(myOnly){
   const user=await getIdentity();
   if(epoch!==requestEpoch)return;
   if(!user){account();return}
   query=query.eq('seller_id',user.id);
  }else query=query.eq('status','active');
  if(category!=='الكل')query=query.eq('category',category);
  const search=el('pmSearch').value.trim().replace(/[%_,()\\]/g,' ').slice(0,60);
  if(search)query=query.or('title.ilike.%'+search+'%,area.ilike.%'+search+'%');
  const {data,error}=await query;
  if(epoch!==requestEpoch)return;
  if(error)throw Error('إعلانات السوق العام غير متاحة حالياً. يلزم تفعيل مخطط السوق بعد فحصه على Waseet-Test.');
  rows=reset?(data||[]):rows.concat(data||[]);next=rows.length;hasMore=(data||[]).length===20;
  status('');
 }catch(e){if(epoch===requestEpoch)status(e.message)}
 finally{if(epoch===requestEpoch){loading=false;cards()}}
}
function details(item){
 const body=sheet(item.title);
 const gallery=document.createElement('div');
 const sources=Array.isArray(item.image_urls)?item.image_urls.filter(safeUrl):[];
 let photoIndex=0;
 const viewport=document.createElement('div');viewport.className='pm-detail-image';
 const updatePhoto=()=>{viewport.replaceChildren();const display=photo(sources[photoIndex],item.title);display.style.cssText='width:100%;height:100%';viewport.append(display)};
 updatePhoto();gallery.append(viewport);
 if(sources.length>1){
  const controls=document.createElement('div');controls.style.cssText='display:flex;justify-content:space-between;align-items:center;margin-bottom:12px';
  const back=button('‹ السابق',()=>{photoIndex=(photoIndex-1+sources.length)%sources.length;updatePhoto();count.textContent=(photoIndex+1)+' / '+sources.length});
  const nextButton=button('التالي ›',()=>{photoIndex=(photoIndex+1)%sources.length;updatePhoto();count.textContent=(photoIndex+1)+' / '+sources.length});
  const count=txt('span','1 / '+sources.length,'pm-muted');controls.append(back,count,nextButton);gallery.append(controls);
 }
 body.append(gallery);
 body.append(txt('h2',item.title),txt('h2',fmt(item.price),'pm-price'),txt('p','📍 '+item.area,'pm-muted'),txt('p','الصنف: '+item.category),txt('p','الحالة: '+(item.condition==='new'?'جديد':'مستعمل')),txt('p',item.negotiable?'السعر قابل للتفاوض':'السعر نهائي'),txt('p',item.description||'لا يوجد وصف'));
 const nav=document.createElement('div');nav.style.cssText='display:flex;gap:8px;flex-wrap:wrap';
 if(identity?.id!==item.seller_id)nav.append(button('راسل المعلن',()=>startThread(item)));
 nav.append(button('♡ المفضلة',()=>toggleFavorite(item.id)));
 nav.append(button('الإبلاغ عن إعلان',()=>reportListing(item.id)));
 nav.append(button('مشاركة',()=>navigator.share?navigator.share({title:item.title,url:location.href}).catch(()=>{}):navigator.clipboard?.writeText(location.href)));
 if(identity?.id===item.seller_id || (typeof isAdmin==='function' && isAdmin())){
  nav.append(button('تعديل',()=>editor(item)));
  nav.append(button(item.status==='active'?'تم البيع':'إرجاع للنشر',async()=>{
   const nextStatus=item.status==='active'?'sold':'active';
   const {error}=await db.from('market_listings').update({status:nextStatus}).eq('id',item.id);
   if(error){alert('تعذّر تحديث الإعلان');return}closeSheet();load(true);
  }));
  nav.append(button('إخفاء الإعلان',async()=>{
   const {error}=await db.from('market_listings').update({status:'hidden'}).eq('id',item.id);
   if(error){alert('تعذّر إخفاء الإعلان');return}closeSheet();load(true);
  }));
  nav.append(button('حذف الإعلان',async()=>{
   if(!confirm('تأكيد حذف الإعلان نهائياً؟ لا يمكن استرجاعه.'))return;
   const {error}=await db.from('market_listings').delete().eq('id',item.id);
   if(error){alert('تعذّر حذف الإعلان');return}
   if(identity?.id===item.seller_id){
    const prefix=db.storage.from('market-listing-images').getPublicUrl(identity.id+'/').data.publicUrl;
    const ownedPaths=(item.image_urls||[]).filter(url=>typeof url==='string'&&url.startsWith(prefix))
      .map(url=>decodeURIComponent(url.slice(prefix.length)))
      .filter(name=>/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(name)).map(name=>identity.id+'/'+name);
    if(ownedPaths.length)await db.storage.from('market-listing-images').remove(ownedPaths).catch(()=>{});
   }
   closeSheet();await load(true);
  }));
 }
 body.append(nav);
}
async function editor(item){
 if(!identity){account();return}
 const body=sheet(item?'تعديل إعلان':'إضافة إعلان مجاني'),form=document.createElement('form');body.append(form);
 const title=field(form,'عنوان الإعلان','title'),price=field(form,'السعر بالدينار','price','number'),area=field(form,'المنطقة','area'),description=field(form,'الوصف','description','textarea',false);
 const image=field(form,'إضافة رابط صورة HTTPS (اختياري)','image','url',false);
 let retainedImages=Array.isArray(item?.image_urls)?item.image_urls.slice():[];
 const retainedList=document.createElement('div');retainedList.style.cssText='display:flex;gap:8px;flex-wrap:wrap;margin:9px 0';
 const drawRetained=()=>{
  retainedList.replaceChildren();
  retainedImages.forEach((url,i)=>{
   const wrap=document.createElement('div');wrap.style.cssText='width:80px;display:grid;gap:4px';
   const thumb=photo(url,'صورة الإعلان');thumb.style.height='67px';thumb.style.fontSize='22px';
   wrap.append(thumb,button('إزالة',()=>{retainedImages.splice(i,1);drawRetained()}));retainedList.append(wrap);
  });
 };
 drawRetained();form.append(retainedList);
 const filesLabel=txt('label','صور الغرض من الهاتف (حتى 5 صور، كل صورة بحد أقصى 5MB)','pm-field');
 const files=document.createElement('input');files.type='file';files.accept='image/jpeg,image/png,image/webp';files.multiple=true;files.required=false;
 filesLabel.append(files);form.append(filesLabel);
 const categoryField=txt('label','الصنف','pm-field'),select=document.createElement('select');select.name='category';
 categories.slice(1).forEach(c=>{const option=document.createElement('option');option.value=c;option.textContent=c;select.append(option)});categoryField.append(select);form.insertBefore(categoryField,area.parentElement);
 const condition=txt('label','الحالة','pm-field'),conditionSelect=document.createElement('select');conditionSelect.innerHTML='<option value="used">مستعمل</option><option value="new">جديد</option>';condition.append(conditionSelect);form.append(condition);
 const negotiate=txt('label',' قابل للتفاوض','pm-field'),check=document.createElement('input');check.type='checkbox';check.style.width='auto';negotiate.prepend(check);form.append(negotiate);
 if(item){title.value=item.title;price.value=item.price;area.value=item.area;description.value=item.description||'';select.value=item.category;conditionSelect.value=item.condition;check.checked=item.negotiable}
 const submit=txt('button','حفظ الإعلان','pm-primary');submit.type='submit';form.append(submit);
 form.addEventListener('submit',async e=>{
  e.preventDefault();submit.disabled=true;
  try{
   const user=await ensureMember();
   const link=image.value.trim();if(link&&!safeUrl(link))throw Error('الصورة لازم تبدأ برابط HTTPS صحيح');
   const selected=[...files.files];
   if(selected.length>5)throw Error('تقدر تضيف حتى 5 صور فقط');
   const imageUrls=retainedImages.slice();
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
   const op=item?db.from('market_listings').update(payload).eq('id',item.id):db.from('market_listings').insert({...payload,seller_id:user.id,status:'active'});
   const {error}=await op;if(error)throw Error('تعذّر حفظ الإعلان. تأكد من تفعيل السوق وصلاحيات الحساب.');
   closeSheet();myOnly=false;category='الكل';renderCategories();await load(true);
  }catch(err){alert(err.message)}
  finally{submit.disabled=false}
 });
}

async function startThread(item){
 try{
  const user=await ensureMember();
  if(user.id===item.seller_id)throw Error('هذا إعلانك');
  let {data:thread,error}=await db.from('market_threads').select('id').eq('listing_id',item.id).eq('buyer_id',user.id).maybeSingle();
  if(error)throw Error('مراسلات السوق غير مفعّلة بعد');
  if(!thread){
   const created=await db.from('market_threads').insert({listing_id:item.id,buyer_id:user.id,seller_id:item.seller_id}).select('id').single();
   if(created.error){
    const existing=await db.from('market_threads').select('id').eq('listing_id',item.id).eq('buyer_id',user.id).maybeSingle();
    if(existing.error||!existing.data)throw Error('تعذّر بدء المحادثة مع المعلن');
    thread=existing.data;
   }else thread=created.data;
  }
  await conversation(thread.id,item.title);
 }catch(err){alert(err.message)}
}
async function inbox(){
 const body=sheet('رسائل السوق');
 try{
  const user=await ensureMember();
  const {data,error}=await db.from('market_threads').select('id,listing_id,buyer_id,seller_id,created_at').or('buyer_id.eq.'+user.id+',seller_id.eq.'+user.id).order('created_at',{ascending:false}).limit(40);
  if(error)throw Error('تعذّر تحميل رسائل السوق');
  if(!data?.length){body.append(txt('p','لا توجد محادثات بعد. افتح إعلاناً وراسل صاحبه.','pm-muted'));return}
  for(const thread of data){
   const b=button('محادثة إعلان — '+thread.listing_id.slice(0,8),()=>conversation(thread.id,'محادثة السوق'));b.style.cssText='display:block;width:100%;margin-bottom:8px;text-align:right';body.append(b);
  }
 }catch(e){body.append(txt('p',e.message,'pm-error'))}
}
async function conversation(id,title){
 const body=sheet(title);
 const log=document.createElement('div');log.style.cssText='display:grid;gap:8px;margin:12px 0 20px';
 const form=document.createElement('form'),input=document.createElement('textarea');input.placeholder='اكتب رسالة للبائع أو المشتري…';input.maxLength=2000;input.required=true;input.rows=3;input.style.cssText='width:100%;border:1px solid #ccd5e0;border-radius:10px;padding:12px';
 const send=txt('button','إرسال','pm-primary');send.type='submit';form.append(input,send);
 const refresh=button('تحديث الرسائل',()=>loadMessages());
 body.append(refresh,log,form);
 async function loadMessages(){
  const {data,error}=await db.from('market_messages').select('id,body,sender_id,created_at').eq('thread_id',id).order('created_at',{ascending:true}).limit(100);
  log.replaceChildren();
  if(error){log.append(txt('p','تعذّر تحميل الرسائل','pm-error'));return}
  if(!data?.length){log.append(txt('p','ابدأ المحادثة برسالتك الأولى.','pm-muted'));return}
  for(const msg of data){const bubble=txt('div',msg.body);bubble.style.cssText='max-width:88%;padding:12px;border-radius:13px;white-space:pre-wrap;overflow-wrap:anywhere;background:'+(msg.sender_id===identity?.id?'#dbeafe':'#fff')+';margin-'+(msg.sender_id===identity?.id?'right':'left')+':auto';log.append(bubble)}
 }
 form.onsubmit=async event=>{
  event.preventDefault();send.disabled=true;
  try{
   const user=await ensureMember();
   const bodyText=input.value.trim();if(!bodyText)return;
   const {error}=await db.from('market_messages').insert({thread_id:id,sender_id:user.id,body:bodyText});
   if(error)throw Error('تعذّر إرسال الرسالة');
   input.value='';await loadMessages();
  }catch(e){alert(e.message)}
  finally{send.disabled=false}
 };
 await loadMessages();
}

async function adminReports(){
 if(!(typeof isAdmin==='function' && isAdmin()))return;
 const body=sheet('بلاغات السوق — الإدارة');
 try{
  const {data,error}=await db.from('market_reports').select('id,listing_id,reason,notes,status,created_at').eq('status','open').order('created_at',{ascending:false}).limit(50);
  if(error)throw Error('تعذّر تحميل البلاغات');
  if(!data?.length){body.append(txt('p','ماكو بلاغات جديدة.','pm-muted'));return}
  for(const item of data){
   const card=document.createElement('section');card.style.cssText='border:1px solid #dce3eb;background:white;border-radius:12px;padding:13px;margin-bottom:10px';
   card.append(txt('strong','بلاغ: '+item.reason),txt('p','إعلان '+item.listing_id.slice(0,8),'pm-muted'),txt('p',item.notes||'بدون تفاصيل إضافية','pm-muted'));
   card.append(button('تمت المراجعة',async()=>{
    const {error:updateError}=await db.from('market_reports').update({status:'reviewed'}).eq('id',item.id);
    if(updateError){alert('تعذّر إكمال المراجعة');return}await adminReports();
   }));
   const hideButton=button('إخفاء الإعلان',async()=>{
    if(!confirm('تأكيد إخفاء الإعلان المخالف عن الجمهور؟'))return;
    const {error:hideError}=await db.from('market_listings').update({status:'hidden'}).eq('id',item.listing_id);
    if(hideError){alert('تعذّر إخفاء الإعلان');return}
    const {error:reviewError}=await db.from('market_reports').update({status:'reviewed'}).eq('id',item.id);
    if(reviewError){alert('تم إخفاء الإعلان، لكن تعذّر تحديث حالة البلاغ');return}
    await adminReports();
   });
   hideButton.style.marginTop='7px';card.append(hideButton);body.append(card);
  }
 }catch(e){body.append(txt('p',e.message,'pm-error'))}
}

async function toggleFavorite(listingId){
 try{
  const user=await ensureMember();
  const {data,error}=await db.from('market_favorites').select('listing_id').eq('user_id',user.id).eq('listing_id',listingId).maybeSingle();
  if(error)throw Error('المفضلة غير مفعّلة بعد');
  const result=data?await db.from('market_favorites').delete().eq('user_id',user.id).eq('listing_id',listingId):
    await db.from('market_favorites').insert({user_id:user.id,listing_id:listingId});
  if(result.error)throw Error('تعذّر تحديث المفضلة');
  alert(data?'تمت إزالة الإعلان من المفضلة':'تم حفظ الإعلان في المفضلة');
 }catch(err){alert(err.message)}
}
async function favorites(){
 const body=sheet('إعلاناتي المفضلة');
 try{
  const user=await ensureMember();
  const {data,error}=await db.from('market_favorites').select('listing_id,market_listings(id,title,price,status,area)').eq('user_id',user.id).order('created_at',{ascending:false}).limit(100);
  if(error)throw Error('تعذّر تحميل المفضلة');
  if(!data?.length){body.append(txt('p','ما حفظت أي إعلان بالمفضلة بعد.','pm-muted'));return}
  for(const fav of data){
   const row=fav.market_listings;
   if(!row||row.status!=='active')continue;
   const b=button(row.title+' — '+fmt(row.price),()=>{closeSheet();el('pmSearch').value=row.title;load(true)});
   b.style.cssText='display:block;width:100%;text-align:right;margin-bottom:8px';body.append(b);
  }
 }catch(err){body.append(txt('p',err.message,'pm-error'))}
}
async function reportListing(listingId){
 if(!identity){account();return}
 const body=sheet('الإبلاغ عن إعلان مخالف');
 body.append(txt('p','نراجع البلاغات لحماية مستخدمي السوق. لا تضع بيانات حساسة في الوصف.','pm-muted'));
 const form=document.createElement('form'),label=txt('label','سبب البلاغ','pm-field'),choice=document.createElement('select');
 [['scam','احتيال أو طلب تحويل مالي'],['wrong_info','معلومات مضللة'],['prohibited','غرض مخالف'],['duplicate','إعلان مكرر'],['other','سبب آخر']].forEach(([value,title])=>{const o=document.createElement('option');o.value=value;o.textContent=title;choice.append(o)});
 label.append(choice);form.append(label);
 const notes=field(form,'تفاصيل إضافية (اختياري)','notes','textarea',false);notes.maxLength=500;
 const send=txt('button','إرسال البلاغ','pm-primary');send.type='submit';form.append(send);body.append(form);
 form.onsubmit=async e=>{
  e.preventDefault();send.disabled=true;
  try{
   const user=await ensureMember();const {error}=await db.from('market_reports').insert({listing_id:listingId,reporter_id:user.id,reason:choice.value,notes:notes.value.trim()});
   if(error)throw Error('تعذّر إرسال البلاغ، أو سبق أن أبلغت عن هذا الإعلان');
   const result=sheet('تم استلام البلاغ');result.append(txt('p','شكراً إلك. البلاغ محفوظ للمراجعة.','pm-muted'));
  }catch(e){alert(e.message)}
  finally{send.disabled=false}
 };
}

async function marketLogin(){
 const body=sheet('الدخول إلى السوق');
 const form=document.createElement('form');body.append(form);
 const email=field(form,'البريد الإلكتروني','email','email'),password=field(form,'كلمة المرور','password','password');
 const submit=txt('button','دخول','pm-primary');submit.type='submit';form.append(submit);
 form.onsubmit=async event=>{
  event.preventDefault();submit.disabled=true;
  try{
   const {data,error}=await db.auth.signInWithPassword({email:email.value.trim(),password:password.value});
   if(error)throw Error('البريد أو كلمة المرور غير صحيحة');
   identity=data.user;
   // Run staff/market authority checks through the existing account router.
   closeSheet();
   if(typeof startApp==='function') await startApp(data.user);
   else await window.WaseetPublicMarket.show(data.user);
  }catch(e){alert(e.message)}
  finally{submit.disabled=false}
 };
 body.append(button('ما عندي حساب',()=>account()));
}

function account(){
 const body=sheet('حساب السوق العام');
 if(identity){
  body.append(txt('p','مسجّل باسم: '+(identity.email||'مستخدم'),'pm-muted'));
  body.append(button('إعلاناتي',()=>{closeSheet();myOnly=true;category='الكل';renderCategories();load(true)}));
  body.append(button('♡ المفضلة',()=>favorites()));
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
  body.append(button('عندي حساب — تسجيل الدخول',()=>marketLogin()));

 }
}
function staff(){hide();if(typeof isAdmin==='function' && isAdmin()){showApp();return}el('welcomeView')?.classList.remove('hidden');el('welcomeView')?.style.setProperty('display','flex')}
root.addEventListener('click',e=>{
 const action=e.target.closest('[data-pm]')?.dataset.pm;
 if(!action)return;
 if(action==='home'){myOnly=false;category='الكل';renderCategories();closeSheet();load(true)}
 if(action==='mine'){if(!identity){account();return}myOnly=true;category='الكل';renderCategories();closeSheet();load(true)}
 if(action==='add'){if(!identity){account();return}editor()}
 if(action==='account')account();
 if(action==='inbox'){if(!identity){account();return}inbox()}
 if(action==='favorites'){if(!identity){account();return}favorites()}
 if(action==='close')closeSheet();
 if(action==='staff')staff();
});
let searchTimer;el('pmSearch').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(true),350)});
el('pmLoad').addEventListener('click',()=>load(false));
window.WaseetPublicMarket={show:async function(user){identity=user||await getIdentity();show();renderCategories();await load(true)},hide,ensureMember};
renderCategories();
if(!location.hash.includes('type=recovery') && new URLSearchParams(location.search).get('staff')!=='1'){
 db.auth.getSession().then(({data})=>{
  const user=data.session?.user;
  if(!user){show();load(true)}
 }).catch(()=>{show();status('تحقق من اتصال الإنترنت')});
}
})();