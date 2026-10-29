/* Shared presentation and viewport state. No authentication or database writes. */
(function(){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.waseetIcon=name=>`<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="./assets/ui-icons.svg#${/^[a-z-]+$/.test(name)?name:'box'}"></use></svg>`;
  window.waseetAvatar=(person,size=36)=>{
    size=Math.max(20,Math.min(96,Number(size)||36));
    const name=String(person?.full_name||'مستخدم').trim();
    const initials=name.split(/\s+/).slice(0,2).map(part=>Array.from(part)[0]||'').join('')||'م';
    const url=typeof getSafeImageUrl==='function'?getSafeImageUrl(person?.avatar_url):null;
    return `<span class="waseet-avatar" data-avatar-id="${escape(person?.id||'')}" data-avatar-fallback="${escape(initials)}" style="--avatar-size:${size}px" role="img" aria-label="صورة ${escape(name)}">${url?`<img data-avatar-image src="${escape(url)}" alt="" loading="lazy" decoding="async">`:escape(initials)}</span>`;
  };
  document.addEventListener('error',event=>{
    const img=event.target;
    if(img?.matches?.('img[data-avatar-image]')){
      const avatar=img.parentElement;
      avatar.textContent=avatar.dataset.avatarFallback||'م';
      return;
    }
    if(img?.matches?.('.waseet-swipe-slide img,#goodDetailsContent .waseet-details-gallery img') && !img.dataset.failureShown){
      img.dataset.failureShown='1';img.style.display='none';
      const fallback=document.createElement('div');fallback.className='image-failure';fallback.innerHTML=waseetIcon('box')+'<span>الصورة غير متاحة</span>';img.after(fallback);
    }
  },true);
  window.syncWaseetAvatar=person=>{
    for(const node of document.querySelectorAll('[data-avatar-id]')){
      if(node.dataset.avatarId!==String(person.id))continue;
      const size=parseFloat(node.style.getPropertyValue('--avatar-size'))||36;
      node.outerHTML=waseetAvatar(person,size);
    }
  };
  function viewport(){
    const vv=window.visualViewport;
    // Keep pinch zoom available; do not turn magnification into a layout resize.
    if(vv && Math.abs(vv.scale-1)>.05)return;
    const height=vv?.height||window.innerHeight,top=vv?.offsetTop||0;
    const typing=document.activeElement?.matches?.('input,textarea,select');
    document.documentElement.classList.toggle('keyboard-open',Boolean(typing && height<520));
    document.documentElement.style.setProperty('--viewport-height',Math.round(height)+'px');
    document.documentElement.style.setProperty('--viewport-top',Math.round(top)+'px');
  }
  document.addEventListener('focusin',viewport);document.addEventListener('focusout',()=>requestAnimationFrame(viewport));
  viewport();window.addEventListener('resize',viewport,{passive:true});
  window.visualViewport?.addEventListener('resize',viewport,{passive:true});
  window.visualViewport?.addEventListener('scroll',viewport,{passive:true});
  document.addEventListener('DOMContentLoaded',()=>{
    const icons=['home','inquiry','chat','user','more'];
    document.querySelectorAll('.bottom-nav .nav-item').forEach((button,index)=>{
      const span=button.querySelector('span');
      if(span && span.id!=='bottomAccountAvatar')span.innerHTML=waseetIcon(icons[index]);
    });
    const moreIcons=['plus','receipt','users','chart','wallet','box','help'];
    document.querySelectorAll('.more-row-icon').forEach((node,index)=>node.innerHTML=waseetIcon(moreIcons[index]||'box'));
    const photos=document.querySelector('#profilePhotoInput');
    if(photos){
      photos.className='profile-file';
      photos.insertAdjacentHTML('beforebegin','<label for="profilePhotoInput" class="form-action">اختيار صورة جديدة</label>');
      photos.insertAdjacentHTML('afterend','<p id="profilePhotoStatus" class="profile-photo-status" role="status" aria-live="polite">صورة واضحة، حتى 8 ميغابايت.</p>');
    }
    // Subscription settings belong to the account, leaving a single bell in the header.
    const push=document.querySelector('#pushNotificationsButton');
    if(push)document.querySelector('#pushSettings')?.append(push);
    const connection=document.createElement('div');connection.id='connectionStatus';connection.className='connection-status hidden';connection.setAttribute('role','status');
    connection.innerHTML='<span></span><button type="button">تحديث</button>';
    document.querySelector('#appView .header')?.after(connection);
    const showConnection=()=>{connection.classList.remove('hidden');connection.querySelector('span').textContent=navigator.onLine?'عاد الاتصال. حدّث البيانات للحصول على آخر حالة.':'أنت دون اتصال. قد تكون البيانات المعروضة غير محدثة.';connection.querySelector('button').disabled=!navigator.onLine;};
    connection.querySelector('button').onclick=async()=>{await refreshData();if(navigator.onLine && !document.querySelector('#dataStatus')?.textContent)connection.classList.add('hidden');};
    window.addEventListener('offline',showConnection);window.addEventListener('online',showConnection);if(!navigator.onLine)showConnection();
    document.querySelector('.bottom-nav')?.setAttribute('aria-label' ,'التنقل الرئيسي');
    document.querySelector('.bottom-nav')?.setAttribute('role','navigation');
  });
})();
// Explicit update action: an existing client is never reloaded over an unsaved form.
document.addEventListener('DOMContentLoaded',async()=>{
  if(!('serviceWorker' in navigator))return;
  try{
    const registration=await navigator.serviceWorker.register('./sw.js',{scope:'./'});
    let requested=false;
    const offer=()=>{
      if(!registration.waiting || document.getElementById('versionUpdateNotice'))return;
      const notice=document.createElement('div');notice.id='versionUpdateNotice';notice.className='connection-status';notice.setAttribute('role','status');
      const text=document.createElement('span');text.textContent='إصدار أحدث من وسيط جاهز.';
      const button=document.createElement('button');button.type='button';button.textContent='تحديث التطبيق';
      button.onclick=()=>{if(!confirm('سيعاد تحميل التطبيق. احفظ أي إدخال لم ترسله قبل المتابعة.'))return;requested=true;registration.waiting?.postMessage({type:'SKIP_WAITING'});};
      notice.append(text,button);document.querySelector('.app-container')?.prepend(notice);
    };
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(requested)location.reload();});
    registration.addEventListener('updatefound',()=>registration.installing?.addEventListener('statechange',offer));offer();
  }catch(_){/* Offline/auth flows remain usable when registration is unavailable. */}
});

// Replace only known presentation glyphs; user-written names and messages remain text.
(function(){
  const icons={'👤':'user','👥':'users','✉️':'mail','📞':'phone','💳':'receipt','📦':'box','🔔':'bell','🗑️':'trash','🔄':'refresh','✏️':'inquiry','💬':'chat','📣':'bell','🟢':'share','📍':'pin'};
  const selector='.product-img,.account-row-icon,.chat-page-title,.product-code,button[onclick],button[data-card-action],button[data-sale-delete]';
  function hydrate(){
    for(const node of document.querySelectorAll(selector)){
      if(node.querySelector('.ui-icon'))continue;
      const text=node.firstChild;if(text?.nodeType!==Node.TEXT_NODE)continue;
      const value=text.textContent.trimStart();
      for(const [glyph,name] of Object.entries(icons)){
        if(!value.startsWith(glyph))continue;
        if(node.matches('.product-code') && glyph!=='📍')break;
        // A product/avatar placeholder is replaced only when it is entirely a glyph.
        if(node.matches('.product-img,.account-row-icon') && value.trim()!==glyph)break;
        text.textContent=value.slice(glyph.length).trimStart();
        node.insertAdjacentHTML('afterbegin',waseetIcon(name));break;
      }
    }
  }
  let pending=false;
  const schedule=()=>{if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;hydrate()})};
  document.addEventListener('DOMContentLoaded',hydrate);
  new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true});
})();

// Native modal keeps product photos inside the app, with focus restored on close.
window.openWaseetPhotos=function(urls,index=0,title='الغرض'){
  const safe=urls.map(getSafeImageUrl).filter(Boolean);
  if(!safe.length)return;
  let dialog=document.getElementById('photoViewer');
  if(!dialog){
    dialog=document.createElement('dialog');dialog.id='photoViewer';dialog.setAttribute('aria-label','صور الغرض');
    dialog.innerHTML='<header><button type="button" aria-label="إغلاق الصور">×</button><span role="status" aria-live="polite"></span></header><div class="photo-viewer-track" tabindex="0" role="region" aria-label="صور، اسحب للتقليب"></div>';
    document.body.append(dialog);
    dialog.querySelector('button').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>dialog.querySelector('.photo-viewer-track').replaceChildren());
  }
  const track=dialog.querySelector('.photo-viewer-track');track.replaceChildren();
  safe.forEach((url,i)=>{const figure=document.createElement('figure');const img=new Image();img.src=url;img.alt=String(title)+' — '+(i+1);img.loading=i===index?'eager':'lazy';img.decoding='async';img.onerror=()=>{figure.textContent='الصورة غير متاحة';};figure.append(img);track.append(figure);});
  const update=()=>{dialog.querySelector('[role=status]').textContent=(Math.min(safe.length-1,Math.round(Math.abs(track.scrollLeft)/Math.max(1,track.clientWidth)))+1)+' / '+safe.length;};
  track.onscroll=update;
  dialog.showModal();
  track.scrollLeft=-Math.max(0,Math.min(safe.length-1,index))*track.clientWidth;update();
};
