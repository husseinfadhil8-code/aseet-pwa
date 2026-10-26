import test from 'node:test';
import assert from 'node:assert/strict';
import {setupViewport} from '../miniapp/viewport.js';
function root(){return {dataset:{},values:{},style:{setProperty(k,v){this.values[k]=v},values:{}}};}
test('mobile Telegram requests supported fullscreen and updates safe areas',()=>{
 const calls=[],events={},r=root();const tg={initData:'fixture',platform:'ios',isVersionAtLeast:()=>true,safeAreaInset:{top:44},contentSafeAreaInset:{top:32},ready(){calls.push('ready')},expand(){calls.push('expand')},disableVerticalSwipes(){calls.push('swipes')},requestFullscreen(){calls.push('fullscreen')},onEvent(n,f){events[n]=f}};
 setupViewport(tg,r);assert.deepEqual(calls,['ready','expand','swipes','fullscreen']);assert.equal(r.style.values['--tg-safe-top'],'44px');assert.equal(r.style.values['--tg-content-top'],'32px');tg.isFullscreen=true;tg.safeAreaInset.top=0;events.fullscreenChanged();assert.equal(r.dataset.fullscreen,'true');assert.equal(r.style.values['--tg-safe-top'],'0px');
});
test('unsupported, desktop, and ordinary browser clients retain fallback without native requests',()=>{
 for(const tg of [undefined,{platform:'ios',initData:'',isVersionAtLeast:()=>true},{platform:'tdesktop',initData:'fixture',isVersionAtLeast:()=>true},{platform:'android',initData:'fixture',isVersionAtLeast:()=>false}]){const r=root();let requests=0;if(tg)tg.requestFullscreen=()=>requests++;setupViewport(tg,r);assert.equal(requests,0);assert.equal(r.dataset.fullscreen,'false');}
});
test('fullscreen denial does not stop initialization or allow invalid safe areas',()=>{
 const r=root();setupViewport({platform:'android',initData:'fixture',isVersionAtLeast:()=>true,requestFullscreen(){throw Error('denied')},safeAreaInset:{top:-1,bottom:Infinity,left:900},onEvent(){throw Error('unsupported')}},r);assert.equal(r.style.values['--tg-safe-top'],'0px');assert.equal(r.style.values['--tg-safe-bottom'],'0px');assert.equal(r.style.values['--tg-safe-left'],'500px');
});
test('iOS and Android fullscreen requests are one-time and failure preserves expanded fallback',()=>{
 for(const platform of ['ios','android']){
  const events={},calls=[],tg={platform,initData:'fixture',isVersionAtLeast:()=>true,expand(){calls.push('expand')},requestFullscreen(){calls.push('fullscreen');events.fullscreenFailed({error:'UNSUPPORTED'})},onEvent(n,f){events[n]=f}};
  const r=root();setupViewport(tg,r);assert.deepEqual(calls,['expand','fullscreen']);assert.equal(r.dataset.fullscreen,'false');tg.isFullscreen=true;events.fullscreenChanged();assert.equal(r.dataset.fullscreen,'true');tg.isFullscreen=false;events.fullscreenChanged();assert.equal(r.dataset.fullscreen,'false');assert.equal(calls.length,2);
 }
});
test('already-fullscreen mobile clients are not expanded or re-requested',()=>{
 setupViewport({platform:'ios',initData:'fixture',isFullscreen:true,isVersionAtLeast:()=>true,expand(){assert.fail('no expansion')},requestFullscreen(){assert.fail('no repeated request')}},root());
});

test('native chrome colors match both themes and tolerate independent API failures',async()=>{
 const {syncChrome}=await import('../miniapp/viewport.js');
 for(const colorScheme of ['light','dark']){
  const calls=[],r=root(),tg={colorScheme,isVersionAtLeast:()=>true,setHeaderColor(c){calls.push(['header',c])},setBackgroundColor(c){calls.push(['body',c])},setBottomBarColor(c){calls.push(['bottom',c])}};
  syncChrome(tg,r);assert.equal(r.dataset.theme,colorScheme);assert.equal(calls[0][1],colorScheme==='dark'?'#192823':'#ffffff');assert.equal(calls[2][1],calls[0][1]);
 }
 let background;syncChrome({setHeaderColor(){throw Error('unsupported')},setBackgroundColor(c){background=c},setBottomBarColor(){assert.fail('old client')}},root());assert.equal(background,'#f5f6f8');
 let legacy;syncChrome({setHeaderColor(c){legacy=c}},root());assert.equal(legacy,'bg_color');
});
