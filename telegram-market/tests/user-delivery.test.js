import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationContent,notificationAction} from '../src/notifications.js';
const id='11111111-1111-4111-8111-111111111111';
test('user delivery test is visibly a test and offers no implicit marketing opt-in',()=>{
 const content=notificationContent({kind:'test_user'});
 assert.match(content.text,/اختبار/);
 assert.equal(content.reply_markup.inline_keyboard.flat().filter(b=>b.callback_data).length,0);
 assert.match(content.reply_markup.inline_keyboard[0][0].url,/startapp=account$/);
});
test('test recipient ad preview retains approved ad metadata and opens exact listing',()=>{
 const content=notificationContent({kind:'test_user',listing:id,title:'كرسي اختبار القراءة',price:7500,area:'بغداد · الكرادة',description:'غرض معتمد للمعاينة'});
 assert.match(content.text,/اختبار/);assert.ok(content.text.includes('كرسي اختبار القراءة'));
 assert.ok(content.text.includes(Number(7500).toLocaleString('ar-IQ')+' د.ع'));
 assert.ok(content.text.includes('بغداد · الكرادة'));
 assert.match(content.reply_markup.inline_keyboard[0][0].url,new RegExp('startapp=ad_'+id+'$'));
 assert.equal(content.reply_markup.inline_keyboard.flat().filter(b=>b.callback_data).length,0);
});
test('ordinary listing and radar deliveries still contain no user private message text',()=>{
 for(const kind of ['listing','radar']){
  const content=notificationContent({kind,listing:id,title:'خزانة',price:99000,area:'بابل · الحلة',description:'وصف الإعلان',body:'private thread body must not appear'});
  assert.ok(!content.text.includes('private thread body'));
  assert.match(content.reply_markup.inline_keyboard[0][0].url,new RegExp('startapp=ad_'+id+'$'));
 }
});
