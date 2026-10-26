// Forms are handled by JavaScript only; a late module must never submit/reload.
document.addEventListener('submit',event=>{event.preventDefault();if(typeof event.target.onsubmit!=='function')document.getElementById('bootError').hidden=false},true);
document.getElementById('reloadApp').onclick=()=>location.reload();
const bootTimer=setTimeout(()=>{if(!document.documentElement.dataset.appReady)document.getElementById('bootError').hidden=false},15000);
window.addEventListener('waseet:ready',()=>{clearTimeout(bootTimer);document.getElementById('bootError').hidden=true});
window.addEventListener('error',event=>{if(event.target?.id!=='telegramSdk'&&!document.documentElement.dataset.appReady)document.getElementById('bootError').hidden=false},true);

const sdk=document.getElementById('telegramSdk');function sdkReady(){sdk.dataset.state=window.Telegram?.WebApp?'loaded':'failed';window.dispatchEvent(new Event('waseet:telegram'))}if(window.Telegram?.WebApp)sdkReady();else{sdk.addEventListener('load',sdkReady);sdk.addEventListener('error',sdkReady)}
