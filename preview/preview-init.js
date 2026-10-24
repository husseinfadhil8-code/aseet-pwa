/* UI entry to the isolated in-memory preview, never a real login. */
(() => {
  const notice='هذه معاينة تصميم فقط. لا توجد حسابات حقيقية أو اتصال بقاعدة البيانات؛ التغييرات مؤقتة وتزول عند إعادة تحميل الصفحة.';
  window.enterDesignPreview=async role=>{
    document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
    resetMarketSession();if(typeof resetChatPages==='function')resetChatPages();
    const demo=WaseetPreview.enter(role);currentUser=demo.user;profile=demo.profile;
    goods=[];sales=[];reps=[];notifications=[];inquiries=[];
    showApp();await refreshData();
  };
  window.showPreviewEntry=()=>{
    document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
    if(typeof chatPollTimer!=='undefined'){clearInterval(chatPollTimer);chatPollTimer=null;}
    WaseetPreview.reset();resetMarketSession();if(typeof resetChatPages==='function')resetChatPages();
    currentUser=null;profile=null;
    $('appView').classList.add('hidden');$('authView').classList.add('hidden');
    $('welcomeView').classList.remove('hidden');$('welcomeView').style.display='flex';
  };
  window.handleLogout=async()=>showPreviewEntry();
  window.handleLogin=window.handleSignup=window.handlePasswordReset=window.handlePasswordUpdate=()=>alert('لا تدخل بيانات حسابك الحقيقي هنا. اختر تجربة المدير أو المندوب؛ تسجيل الدخول الحقيقي غير مفعّل في هذه المعاينة.');
  window.initPushNotifications=async()=>{};
  window.togglePushNotifications=window.testPushNotification=()=>alert('Push غير متاح في معاينة التصميم، ولم نختبر تسليمه على جهاز iPhone فعلي.');
  window.testRepPushNotification=window.announceAppUpdate=window.togglePushNotifications;
  window.sendPushEvent=async()=>({ok:true,preview:true});
  window.open=()=>{alert('المشاركة وفتح الروابط الخارجية معطلان في المعاينة. لم يُرسل شيء.');return null;};
  document.addEventListener('click',event=>{
    const link=event.target.closest('a[href]');if(!link)return;
    const url=new URL(link.href,location.href);
    if(url.origin!==location.origin || !url.pathname.startsWith(new URL('./',location.href).pathname)){
      event.preventDefault();alert('الروابط الخارجية والحسابات الحقيقية غير متاحة في هذه المعاينة.');
    }
  },true);
  const banner=document.createElement('aside');banner.className='preview-banner';banner.setAttribute('aria-label','تنبيه المعاينة');
  const label=document.createElement('span');label.textContent='معاينة تجريبية · بيانات غير حقيقية';
  const change=document.createElement('button');change.type='button';change.textContent='تبديل الدور';change.addEventListener('click',showPreviewEntry);
  banner.append(label,change);document.body.prepend(banner);
  const entry=`<img class="preview-brand" src="./assets/waseet-icon.svg" alt="وسيط"><h1>جرّب وسيط بشكله الجديد</h1><p>${notice}</p><button type="button" class="btn-navy" id="previewRepButton">تجربة المندوب</button><button type="button" class="btn-navy preview-admin" id="previewAdminButton">تجربة المدير</button><p class="preview-caption">لا تدخل كلمة مرورك. هذه النسخة لا تسجّل الدخول إلى Supabase.</p>`;
  $('welcomeView').innerHTML=entry;
  $('authView').replaceChildren();
  $('previewRepButton').addEventListener('click',()=>enterDesignPreview('rep'));
  $('previewAdminButton').addEventListener('click',()=>enterDesignPreview('admin'));
  $('welcomeView').classList.remove('hidden');
})();
function fitPreviewViewport(){
  const height=window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--preview-height',height+'px');
  const typing=['INPUT','TEXTAREA'].includes(document.activeElement?.tagName);
  document.body.classList.toggle('preview-keyboard',typing && height<600);
}
window.visualViewport?.addEventListener('resize',fitPreviewViewport);
window.addEventListener('resize',fitPreviewViewport);
document.addEventListener('focusin',fitPreviewViewport);
document.addEventListener('focusout',()=>requestAnimationFrame(fitPreviewViewport));
fitPreviewViewport();
// Programmatic navigation should highlight one destination, even though the
// marketplace shortcut and home both open the home view in the source app.
const previewSwitchTab=window.switchTab;
window.switchTab=function(tab){
  previewSwitchTab(tab);
  const active={home:0,chat:2,account:4}[tab];
  document.querySelectorAll('.bottom-nav .nav-item').forEach((button,index)=>button.classList.toggle('active',index===active));
};
