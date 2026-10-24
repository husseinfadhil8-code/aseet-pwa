/* Presentation helpers use DOM nodes/listeners; no untrusted inline JavaScript. */
function uiIcon(name) {
  const paths={home:'M3 10 12 3l9 7v11h-6v-7H9v7H3z',goods:'M4 7h16v14H4z M8 7V4h8v3 M4 11h16',chat:'M4 4h16v13H9l-5 4z M8 8h8 M8 12h5',bell:'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5z M10 21h4',user:'M7 21v-3a5 5 0 0 1 10 0v3 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8',brand:'M3 8l5-4 4 3 4-3 5 4-3 8-6 5-6-5z M8 10l4 4 5-5'};
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('class','ui-icon');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[name]||paths.goods);svg.append(path);return svg;
}
const navigation=[['home','الرئيسية',()=>switchTab('home')],['goods','الأغراض',()=>{switchTab('home');$('goodsSearch')?.focus();}],['chat','الدردشات',()=>switchTab('chat')],['bell','الإشعارات',()=>showNotificationsDialog()],['user','حسابي',()=>openAccountView()]];
document.querySelectorAll('.bottom-nav .nav-item').forEach((button,index)=>{
  const [icon,label,action]=navigation[index];button.dataset.tab=['home','home','chat','notifications','account'][index];button.removeAttribute('onclick');button.replaceChildren(uiIcon(icon),document.createTextNode(label));
  button.addEventListener('click',()=>{action();document.querySelectorAll('.bottom-nav .nav-item').forEach(b=>b.classList.toggle('active',b===button));});
});
document.querySelectorAll('.brand-mark,.splash-logo,#welcomeView>div:first-child').forEach(node=>node.replaceChildren(uiIcon('brand')));
const connection=document.createElement('div');connection.className='connection-status hidden';connection.setAttribute('role','status');connection.textContent='أنت غير متصل. ستُستأنف الطلبات عند عودة الإنترنت.';document.body.append(connection);
function updateConnection(){connection.classList.toggle('hidden',navigator.onLine);}
window.addEventListener('online',updateConnection);window.addEventListener('offline',updateConnection);updateConnection();
const viewer=document.createElement('dialog');viewer.id='photoViewer';viewer.setAttribute('aria-label','معرض الصور المكبّر');
viewer.innerHTML='<div class="viewer-toolbar"><button type="button" data-viewer-close>إغلاق</button><button type="button" data-viewer-zoom>تكبير / تصغير</button><a target="_blank" rel="noopener noreferrer">فتح الأصل</a></div><div class="viewer-scroll"><img alt=""></div>';
document.body.append(viewer);
viewer.querySelector('[data-viewer-close]').addEventListener('click',()=>viewer.close());viewer.querySelector('[data-viewer-zoom]').addEventListener('click',()=>viewer.classList.toggle('zoomed'));
function openPhotoViewer(url,alt){const safe=getSafeImageUrl(url);if(!safe)return;viewer.classList.remove('zoomed');viewer.querySelector('img').src=safe;viewer.querySelector('img').alt=alt;viewer.querySelector('a').href=safe;viewer.showModal();}
// Add zoom without replacing the existing safe original-image click action.
document.addEventListener('click',event=>{if(event.target.matches('[data-zoom-image]'))openPhotoViewer(event.target.dataset.zoomImage,'صورة الغرض');});
// Keep notification administration available without displacing the marketplace.
const moreTools=document.createElement('section');moreTools.className='more-tools';
const toolsTitle=document.createElement('h3');toolsTitle.textContent='الإشعارات والمشاركة';moreTools.append(toolsTitle);
['pushNotificationsButton','testPushButton','announceAppUpdateButton','shareGoodsWhatsAppButton'].forEach(id=>{const button=$(id);if(button)moreTools.append(button);});
$('moreView')?.append(moreTools);
document.querySelectorAll('.header-icon-btn').forEach(button=>{
 const icon=(button.getAttribute('onclick')||'').includes('Notifications')?'bell':'user';
 // Keep notification counters attached when replacing only the icon text.
 [...button.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).forEach(node=>node.remove());button.prepend(uiIcon(icon));
});

function prepareUnifiedDialog(dialog) {
  if (dialog.dataset.unified) return;
  dialog.dataset.unified='1';dialog.classList.add('waseet-dialog');
  const heading=dialog.querySelector('.dialog-header,h2,h3');
  if(heading && !dialog.hasAttribute('aria-labelledby') && !dialog.hasAttribute('aria-label')) {
    if(!heading.id)heading.id=(dialog.id || 'waseet-dialog')+'-title';
    dialog.setAttribute('aria-labelledby',heading.id);
  } else if(!heading && !dialog.hasAttribute('aria-label'))dialog.setAttribute('aria-label','نافذة وسيط');
  if(['photoViewer','notificationGateDialog','onboardingTourDialog'].includes(dialog.id))return;
  if(dialog.querySelector('[data-unified-close]'))return;
  const close=document.createElement('button');close.type='button';close.className='dialog-close-button';
  close.dataset.unifiedClose='1';close.setAttribute('aria-label','إغلاق النافذة');close.textContent='×';
  close.addEventListener('click',()=>dialog.close());dialog.prepend(close);
}
function prepareDialogs(root=document) {
  if(root.matches?.('dialog'))prepareUnifiedDialog(root);
  root.querySelectorAll?.('dialog').forEach(prepareUnifiedDialog);
}
document.addEventListener('DOMContentLoaded',()=>prepareDialogs());
new MutationObserver(records=>{
  for(const record of records)for(const node of record.addedNodes)if(node.nodeType===Node.ELEMENT_NODE)prepareDialogs(node);
}).observe(document.body,{childList:true,subtree:true});

// A programmatic tab change selects one destination, including the two home shortcuts.
const marketplaceSwitchTab = window.switchTab;
window.switchTab = function(tab) {
  marketplaceSwitchTab(tab);
  let selected = false;
  document.querySelectorAll('.bottom-nav .nav-item').forEach(button => {
    const active = !selected && button.dataset.tab === tab;
    button.classList.toggle('active',active);
    if(active)selected=true;
  });
};
