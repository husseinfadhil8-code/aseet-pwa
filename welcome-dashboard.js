
(function(){
  'use strict';
  const $ = id => document.getElementById(id);
  const welcome=$('welcomeView'), home=$('homeView');
  if(!welcome || !home || document.getElementById('waseetDashboard'))return;
  function auth(mode){
    welcome.classList.add('hidden');
    $('authView')?.classList.remove('hidden');
    if(typeof window.switchAuthMode==='function')window.switchAuthMode(mode);
  }
  welcome.classList.add('waseet-landing');
  welcome.innerHTML=`
    <div class="wl-brand"><div><div class="wl-logo">وسي<b>ط</b></div><div class="wl-tagline">بيع أسهل · فرص أكثر</div></div><img src="./assets/waseet-icon.svg" alt="شعار وسيط" width="48" height="48"></div>
    <section class="wl-hero"><img src="./assets/waseet-market-hero.svg" alt="منتجات وتجارة عبر وسيط"><div class="wl-intro"><h2>أهلاً بك في وسيط</h2><p>منصة لعرض الأغراض وتنظيم البيع بالعمولة بكل سهولة وأمان.</p></div></section>
    <section class="wl-grid" aria-label="خدمات وسيط">
      <div class="wl-feature"><span class="wl-icon">${waseetIcon('box')}</span><strong>عرض الأغراض</strong><small>اكتشف المنتجات والتفاصيل بسهولة</small></div>
      <div class="wl-feature"><span class="wl-icon">${waseetIcon('chart')}</span><strong>بيع بالعمولة</strong><small>فرص للبيع وإدارة المستحقات</small></div>
      <div class="wl-feature"><span class="wl-icon">${waseetIcon('chat')}</span><strong>محادثات فورية</strong><small>تواصل مع الفريق والمندوبين</small></div>
      <div class="wl-feature"><span class="wl-icon">${waseetIcon('users')}</span><strong>إدارة الفريق</strong><small>تنظيم المندوبين والمبيعات</small></div>
    </section>
    <div class="wl-actions"><button type="button" class="wl-login" data-entry="login">الدخول ←</button><button type="button" class="wl-signup" data-entry="signup">إنشاء حساب</button><button type="button" class="wl-guest" data-entry="explore">استكشف الأغراض</button></div>
    <p class="wl-footer">مع وسيط · سوق واضح وتجربة مريحة</p>`;
  welcome.addEventListener('click',event=>{
    const action=event.target.closest('[data-entry]')?.dataset.entry;
    if(!action)return;
    auth(action==='signup'?'signup':'login');
    if(action==='explore'){
      const title=$('authTitle');
      if(title)title.textContent='سجّل الدخول لتصفح الأغراض';
    }
  });
  const legacy=document.createElement('section');legacy.className='tab-view hidden waseet-market-panel';legacy.id='browseView';
  while(home.firstChild)legacy.appendChild(home.firstChild);
  const dashboard=document.createElement('section');dashboard.className='waseet-dashboard';dashboard.id='waseetDashboard';
  dashboard.innerHTML=`
    <section class="wd-banner"><img src="./assets/waseet-market-hero.svg" alt=""><div class="wd-banner-copy"><h2>اكتشف فرصتك الجاية</h2><p>تصفح الأغراض المعروضة، شوف التفاصيل وتواصل بكل سهولة.</p><button type="button" class="wd-banner-cta" data-wd="browse">تصفح السوق ←</button></div></section>
    <form class="wd-search" role="search"><label for="dashboardSearch" class="sr-only">ابحث في السوق</label><span aria-hidden="true">${waseetIcon('search')}</span><input id="dashboardSearch" type="search" placeholder="شنو تدور؟ ابحث عن غرض…" enterkeyhint="search" autocomplete="off"><button type="submit">بحث</button></form>
    <div class="wd-shortcuts">
      <button type="button" class="wd-shortcut" data-wd="browse"><span class="wd-emoji">${waseetIcon('box')}</span><strong>تصفح الأغراض</strong><small>شاهد أحدث المنتجات</small></button>
      <button type="button" class="wd-shortcut" data-wd="team"><span class="wd-emoji">${waseetIcon('wallet')}</span><strong>عمولات المندوبين</strong></button>
      <button type="button" class="wd-shortcut" data-wd="chat"><span class="wd-emoji">${waseetIcon('chat')}</span><strong>الدردشة</strong><small>محادثاتك ورسائلك</small></button>
      <button type="button" class="wd-shortcut" data-wd="sales"><span class="wd-emoji">${waseetIcon('chart')}</span><strong>مبيعاتي</strong><small>المبيعات والمستحقات</small></button>
    </div>
    <h2 class="wd-heading">الأقسام الرئيسية</h2>
    <div class="wd-categories">
      <button class="wd-category" type="button" data-category="أثاث"><span>${waseetIcon('sofa')}</span>الأثاث</button>
      <button class="wd-category" type="button" data-category="إلكترونيات"><span>${waseetIcon('phone')}</span>إلكترونيات</button>
      <button class="wd-category" type="button" data-category="سيارات"><span>${waseetIcon('car')}</span>المركبات</button>
      <button class="wd-category" type="button" data-category="ملابس"><span>${waseetIcon('shirt')}</span>الملابس</button>
      <button class="wd-category" type="button" data-category="عقار"><span>${waseetIcon('building')}</span>العقار</button>
    </div>
    <section class="wd-latest" aria-label="آخر الأغراض المضافة">
      <div class="wd-latest-title"><h2 class="wd-heading">آخر الأغراض المضافة</h2><button type="button" data-wd="browse">عرض الكل ‹</button></div>
      <div id="waseetLatestGoods" class="wd-latest-grid" aria-live="polite"><p class="wd-latest-empty">جارٍ تحميل أحدث الأغراض…</p></div>
    </section>
`;
  const back=document.createElement('div');back.className='wd-market-head';
  back.remove();
  legacy.prepend(back);home.append(dashboard);home.insertAdjacentElement('afterend',legacy);
  function browse(category,{resetScroll=false}={}){
    window.switchTab?.('browse');
    // The market is a sibling of home, never a hidden child of the dashboard.
    home.classList.add('hidden');
    legacy.classList.remove('hidden');
    const input=$('goodsCategoryFilter'); if(input && category){
      const option=[...input.options].find(x=>x.value===category || x.textContent.includes(category));
      if(option){input.value=option.value;window.scheduleGoodsSearch?.()}
    }
    if(resetScroll){const content=home.closest('.content');if(content)content.scrollTop=0;}
  }
  function backHome(){window.switchTab?.('home');}
  home.addEventListener('click',e=>{
    const el=e.target.closest('[data-wd],[data-category]');if(!el)return;
    if(el.dataset.category){browse(el.dataset.category,{resetScroll:true});return;}
    const action=el.dataset.wd;
    if(action==='browse')browse();
    else if(action==='back')backHome();
    else if(action==='chat')window.switchTab?.('chat');
    else if(action==='team')window.switchTab?.('teamActivity');
    else if(action==='sales'){
      const adminButton=home.querySelector('.admin-only:not(.hidden)');
      const admin=typeof window.isAdmin==='function' ? window.isAdmin() : (adminButton&&getComputedStyle(adminButton).display!=='none');
      window.switchTab?.(admin?'sales':'myCommissions');
    }
  });
  legacy.addEventListener('click',e=>{if(e.target.closest('[data-wd="back"]'))backHome()});
  // Preserve independent scroll positions; rejected role navigation never changes state.
  const positions=new Map();
  const oldSwitch=window.switchTab;
  if(typeof oldSwitch==='function')window.switchTab=function(tab){
    const content=home.closest('.content');
    const previous=document.querySelector('.tab-view:not(.hidden)')?.id;
    if(previous)positions.set(previous,content?.scrollTop||0);
    const result=oldSwitch.apply(this,arguments);
    if(result===false)return result;
    if(content)content.scrollTop=positions.get(tab+'View')||0;
    document.querySelectorAll('.bottom-nav .nav-item').forEach(button=>{
      if(button.classList.contains('active'))button.setAttribute('aria-current','page');
      else button.removeAttribute('aria-current');
    });
    return result;
  };
  home.querySelector('.wd-search').addEventListener('submit',event=>{
    event.preventDefault();
    const query=$('dashboardSearch').value.trim();
    browse(undefined,{resetScroll:true});
    $('goodsSearch').value=query;
    window.scheduleGoodsSearch?.();
    $('dashboardSearch').blur();
  });


  // The dashboard shows only a small, recent preview, not the full marketplace feed.
  // Reuse the already-fetched goods state and the app's existing image sanitization.
  const latestList=$('waseetLatestGoods');
  function renderLatestGoods(){
    if(!latestList)return;
    const rows=(typeof goods!=='undefined' && Array.isArray(goods)?goods:[])
      .filter(item=>item && item.status==='available')
      .sort((a,b)=>(Date.parse(b.created_at||'')||0)-(Date.parse(a.created_at||'')||0))
      .slice(0,6);
    latestList.replaceChildren();
    if(!rows.length){
      const empty=document.createElement('p');
      empty.className='wd-latest-empty';
      empty.textContent='ماكو أغراض متاحة حالياً.';
      latestList.append(empty);
      return;
    }
    rows.forEach(item=>{
      const card=document.createElement('button');
      card.type='button';
      card.className='wd-latest-card';
      card.setAttribute('aria-label','عرض تفاصيل '+String(item.title||'الغرض'));
      const figure=document.createElement('span');
      figure.className='wd-latest-photo';
      const photos=typeof getGoodImageUrls==='function'?getGoodImageUrls(item):[];
      if(photos.length){
        const img=document.createElement('img');
        img.src=photos[0];img.alt='صورة '+String(item.title||'الغرض');
        img.loading='lazy';img.decoding='async';
        img.onerror=()=>{img.remove();figure.textContent='📦';};
        figure.append(img);
      }else figure.textContent='📦';
      const info=document.createElement('span');info.className='wd-latest-info';
      const title=document.createElement('strong');title.textContent=String(item.title||'غرض بدون عنوان');
      const amount=document.createElement('span');amount.className='wd-latest-price';
      amount.textContent=typeof money==='function'?money(item.asking_price):String(item.asking_price||0)+' د.ع';
      const area=document.createElement('span');area.className='wd-latest-area';
      area.textContent='📍 '+String(item.area||'العنوان غير محدد');
      info.append(title,amount,area);card.append(figure,info);
      card.addEventListener('click',()=>window.openGoodDetails?.(item.id));
      latestList.append(card);
    });
  }
  renderLatestGoods();
  // The product list is re-rendered when goods are fetched, edited or sold.
  // Observing that existing view keeps the preview in sync without extra requests.
  const originalGoodsList=$('goodsList');
  if(originalGoodsList){
    let latestRefreshQueued=false;
    const observer=new MutationObserver(()=>{
      if(latestRefreshQueued)return;
      latestRefreshQueued=true;
      queueMicrotask(()=>{latestRefreshQueued=false;renderLatestGoods();});
    });
    observer.observe(originalGoodsList,{childList:true});
  }

})();
