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


const releasedSwitchTab=window.switchTab;
window.switchTab=function(tab){
 releasedSwitchTab(tab);
 document.querySelectorAll('.bottom-nav .nav-item').forEach(button=>{
  const action=button.getAttribute('onclick')||'';
  button.classList.toggle('active',action.includes("'"+tab+"'")||(tab==='account'&&action.includes('openAccountView')));
 });
};
