import test from 'node:test';import assert from 'node:assert/strict';
import {wantedAction,wantedPublic} from '../src/wanted.js';
import worker from '../worker.js';
import {notificationContent} from '../src/notifications.js';
test('wanted endpoints reject unsigned actors, including forged owner flags',async()=>{for(const operation of ['save','review','offer','radar_save','admin']){const r=await worker.fetch(new Request('https://example.test/api/wanted',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation,data:{p_admin:true}})}),{TELEGRAM_BOT_TOKEN:'synthetic'},{});assert.equal(r.status,401)}});
test('wanted feature fails closed until gated Test schema is enabled',async()=>{const r=await worker.fetch(new Request('https://example.test/api/wanted'),{},{});assert.equal(r.status,503)});
test('wanted admin checks trusted server owner configuration',async()=>{for(const op of ['review','admin','report_close','admin_offers'])await assert.rejects(()=>wantedAction({OWNER_TELEGRAM_ID:'3'},{id:2},op),e=>e.status===403)});
test('wanted unknown operations never reach RPC',async()=>{await assert.rejects(()=>wantedAction({},{id:2},'sql'),e=>e.status===404)});
test('radar message identifies matching search and uses exact registered app listing link',()=>{const result=notificationContent({kind:'radar',listing:'00000000-0000-0000-0000-000000000123',title:'كرسي خشب',price:1000,area:'بغداد',description:'وصف'});assert.match(result.text,/رادار وسيط/);assert.equal(result.reply_markup.inline_keyboard[0][0].url,'https://t.me/WaseetIraqMarketBot/market?startapp=ad_00000000-0000-0000-0000-000000000123')});
