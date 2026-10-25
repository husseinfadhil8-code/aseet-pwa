
(function(){
  'use strict';
  const $ = id => document.getElementById(id);
  const welcome=$('welcomeView'), home=$('homeView');
  if(!welcome || !home)return;
  function auth(mode){
    welcome.classList.add('hidden');
    $('authView')?.classList.remove('hidden');
    if(typeof window.switchAuthMode==='function')window.switchAuthMode(mode);
  }
  welcome.classList.add('waseet-landing');
  welcome.innerHTML=`
    <div class="wl-brand"><div><div class="wl-logo">وسي<b>ط</b> 🛍️</div><div class="wl-tagline">بيع أسهل · فرص أكثر</div></div><img src="./assets/waseet-icon.svg" alt="شعار وسيط" width="48" height="48"></div>
    <section class="wl-hero"><img src="./assets/waseet-market-hero.svg" alt="منتجات وتجارة عبر وسيط"><div class="wl-intro"><h2>مرحباً بك في وسيط 👋</h2><p>منصة لعرض الأغراض وتنظيم البيع بالعمولة بكل سهولة وأمان.</p></div></section>
    <section class="wl-grid" aria-label="خدمات وسيط">
      <div class="wl-feature"><span class="wl-icon">🛍️</span><strong>عرض الأغراض</strong><small>اكتشف المنتجات والتفاصيل بسهولة</small></div>
      <div class="wl-feature"><span class="wl-icon">📈</span><strong>بيع بالعمولة</strong><small>فرص للبيع وإدارة المستحقات</small></div>
      <div class="wl-feature"><span class="wl-icon">💬</span><strong>محادثات فورية</strong><small>تواصل مع الفريق والمندوبين</small></div>
      <div class="wl-feature"><span class="wl-icon">👥</span><strong>إدارة الفريق</strong><small>تنظيم المندوبين والمبيعات</small></div>
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
    <section class="wd-banner"><img src="./assets/waseet-market-hero.svg" alt=""><div class="wd-banner-copy"><h2>مرحباً بك في وسيط 👋</h2><p>كل ما تحتاجه للعرض والتواصل وإدارة فرص البيع في مكان واحد.</p></div></section>
    <div class="wd-shortcuts">
      <button type="button" class="wd-shortcut" data-wd="browse"><span class="wd-emoji">🛍️</span><strong>تصفح الأغراض</strong><small>شاهد أحدث المنتجات</small></button>
      <button type="button" class="wd-shortcut" data-wd="team"><span class="wd-emoji">💰</span><strong>عمولات المندوبين</strong></button>
      <button type="button" class="wd-shortcut" data-wd="chat"><span class="wd-emoji">💬</span><strong>الدردشة</strong><small>محادثاتك ورسائلك</small></button>
      <button type="button" class="wd-shortcut" data-wd="sales"><span class="wd-emoji">📊</span><strong>مبيعاتي</strong><small>المبيعات والمستحقات</small></button>
    </div>
    <h2 class="wd-heading">الأقسام الرئيسية</h2>
    <div class="wd-categories">
      <button class="wd-category" type="button" data-category="أثاث"><span>🛋️</span>الأثاث</button>
      <button class="wd-category" type="button" data-category="إلكترونيات"><span>📱</span>إلكترونيات</button>
      <button class="wd-category" type="button" data-category="سيارات"><span>🚙</span>المركبات</button>
      <button class="wd-category" type="button" data-category="ملابس"><span>👕</span>الملابس</button>
      <button class="wd-category" type="button" data-category="عقار"><span>🏠</span>العقار</button>
    </div>
`;
  const back=document.createElement('div');back.className='wd-market-head';
  back.innerHTML='<button type="button" class="wd-back" data-wd="back">← الرئيسية</button><strong>تصفح الأغراض</strong>';
  legacy.prepend(back);home.append(dashboard);home.insertAdjacentElement('afterend',legacy);
  function browse(category){
    window.switchTab?.('browse');
    // The market is a sibling of home, never a hidden child of the dashboard.
    home.classList.add('hidden');
    legacy.classList.remove('hidden');
    const input=$('goodsCategoryFilter'); if(input && category){
      const option=[...input.options].find(x=>x.value===category || x.textContent.includes(category));
      if(option){input.value=option.value;window.scheduleGoodsSearch?.()}
    }
    legacy.closest('.content')?.scrollTo({top:0,behavior:'instant'});
  }
  function backHome(){window.switchTab?.('home');home.closest('.content')?.scrollTo({top:0,behavior:'instant'});}
  home.addEventListener('click',e=>{
    const el=e.target.closest('[data-wd],[data-category]');if(!el)return;
    if(el.dataset.category){browse(el.dataset.category);return;}
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
  const oldSwitch=window.switchTab;
  if(typeof oldSwitch==='function')window.switchTab=function(tab){
    const result=oldSwitch.apply(this,arguments);
    if(tab==='home')home.closest('.content')?.scrollTo({top:0,behavior:'instant'});
    return result;
  };

  // Keep one compact fixed-position push control, not the legacy full-width button in the market section.
  const pushButton=$('pushNotificationsButton');
  const headerActions=document.querySelector('#appView .header-actions');
  if(pushButton && headerActions){
    pushButton.removeAttribute('style');
    pushButton.className='wd-push-switch is-off';
    pushButton.setAttribute('aria-label','تفعيل إشعارات وسيط');
    headerActions.prepend(pushButton);
    const refreshPushIndicator=()=>{
      const active=typeof pushSubscription!=='undefined' && Boolean(pushSubscription) &&
        typeof Notification!=='undefined' && Notification.permission==='granted';
      pushButton.classList.toggle('is-on',active);
      pushButton.classList.toggle('is-off',!active);
      pushButton.textContent=active?'🔔 مفعّلة':'🔕 مغلقة';
      pushButton.setAttribute('aria-label',active?'الإشعارات مفعّلة، اضغط لإيقافها':'الإشعارات متوقفة، اضغط لتفعيلها');
      pushButton.setAttribute('aria-pressed',String(active));
      pushButton.title=active?'الإشعارات مفعّلة':'اضغط لتفعيل الإشعارات';
    };
    refreshPushIndicator();
    pushButton.addEventListener('click',()=>{setTimeout(refreshPushIndicator,250);setTimeout(refreshPushIndicator,1600)});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshPushIndicator()});
    window.addEventListener('focus',refreshPushIndicator);
    setInterval(()=>{if(!document.hidden)refreshPushIndicator()},4000);
  }
})();
