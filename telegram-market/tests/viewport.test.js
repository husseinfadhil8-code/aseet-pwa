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
