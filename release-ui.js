function prepareUnifiedDialog(dialog) {
  if (dialog.dataset.unified) return;
  dialog.dataset.unified='1';dialog.classList.add('waseet-dialog');
  const heading=dialog.querySelector('.dialog-header,h2,h3');
  if(heading && !dialog.hasAttribute('aria-labelledby') && !dialog.hasAttribute('aria-label')) {
    if(!heading.id)heading.id=(dialog.id || 'waseet-dialog')+'-title';
    dialog.setAttribute('aria-labelledby',heading.id);
  } else if(!heading && !dialog.hasAttribute('aria-label') && !dialog.hasAttribute('aria-labelledby'))dialog.setAttribute('aria-label','نافذة وسيط');
  if(['photoViewer','notificationGateDialog','onboardingTourDialog','notificationsDialog'].includes(dialog.id))return;
  if(dialog.querySelector('[data-unified-close],button[aria-label="إغلاق"]'))return;
  const close=document.createElement('button');close.type='button';close.className='dialog-close-button';
  close.dataset.unifiedClose='1';close.setAttribute('aria-label','إغلاق النافذة');close.textContent='×';
  close.addEventListener('click',()=>dialog.close());dialog.prepend(close);
}
function prepareDialogs(root=document) {
  root.querySelectorAll?.('.form-group').forEach((group,index)=>{const label=group.querySelector('label'),field=group.querySelector('input,select,textarea');if(label && field && !label.htmlFor){if(!field.id)field.id='waseet-field-'+document.querySelectorAll('input,select,textarea').length+'-'+index;label.htmlFor=field.id;}});
  if(root.matches?.('dialog'))prepareUnifiedDialog(root);
  root.querySelectorAll?.('dialog').forEach(prepareUnifiedDialog);
}
document.addEventListener('DOMContentLoaded',()=>prepareDialogs());
new MutationObserver(records=>{
  for(const record of records)for(const node of record.addedNodes)if(node.nodeType===Node.ELEMENT_NODE)prepareDialogs(node);
}).observe(document.body,{childList:true,subtree:true});


const releasedSwitchTab=window.switchTab;
const viewScrollPositions=new Map();let currentInterfaceTab='home';
window.resetInterfaceSession=()=>{viewScrollPositions.clear();currentInterfaceTab='home';document.documentElement.classList.remove('chat-layout-open','keyboard-open');document.querySelector('#appView .content')?.classList.remove('chat-layout');};
window.switchTab=function(tab){
 const scroller=document.querySelector('#appView .content');
 const previousScroll=scroller?.scrollTop||0;
 if(currentInterfaceTab==='chat' && tab!=='chat' && typeof saveChatContext==='function')saveChatContext();
 const result=releasedSwitchTab(tab);if(result===false)return false;
 if(tab!==currentInterfaceTab){viewScrollPositions.set(currentInterfaceTab,previousScroll);if(scroller)scroller.scrollTop=viewScrollPositions.get(tab)||0;currentInterfaceTab=tab;}
 scroller?.classList.toggle('chat-layout',tab==='chat');document.documentElement.classList.toggle('chat-layout-open',tab==='chat');
 const navTab=tab==='browse'?'home':['sales','reps','teamActivity','requests','myCommissions'].includes(tab)?'more':tab;
 document.querySelectorAll('.bottom-nav .nav-item').forEach(button=>{
  const action=button.getAttribute('onclick')||'';
  const active=action.includes("'"+navTab+"'")||(navTab==='account'&&action.includes('openAccountView'));
  button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
 });
 window.updateChatPushPresence?.();
 return result;
};
