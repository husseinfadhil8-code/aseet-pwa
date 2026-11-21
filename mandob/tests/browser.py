"""Local actual Worker/SQLite flow; identities, messages and provider adapters are synthetic."""
from playwright.sync_api import sync_playwright, expect
from pathlib import Path
import json
out=Path('/workspace/mandob-baghdad-artifacts');out.mkdir(exist_ok=True)
errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width,height in [(320,568),(390,844),(430,932),(768,1024)]:
  page=browser.new_page(viewport={'width':width,'height':height});page.on('pageerror',lambda e:errors.append(str(e)))
  auth={'Authorization':'Bearer '+'admin-test-'*5}
  current=page.request.get('http://127.0.0.1:4389/api/items',headers=auth).json()
  for item in current['items']: page.request.patch('http://127.0.0.1:4389/api/items/'+item['id'],headers=auth,data={'status':'unknown'})
  page.request.patch('http://127.0.0.1:4389/api/settings',headers=auth,data={'alerts':False})
  page.goto('http://127.0.0.1:4389');assert page.locator('#panel').is_hidden()
  page.locator('#token').fill('admin-test-'*5);page.locator('#login button').click();page.locator('#results article').first.wait_for();assert page.locator('#results article').count()==2
  assert page.locator('#token').input_value()==''
  assert page.evaluate('Object.keys(localStorage).length')==0
  assert page.get_by_text('التوفر غير مؤكد',exact=True).count()==2
  page.locator('#q').fill('ثلاجة');page.locator('#search button').first.click();expect(page.locator('#results article')).to_have_count(1)
  card=page.locator('#results article').first;assert '٣٠٠' in card.inner_text();assert 'المنصور' in card.inner_text()
  reject=page.get_by_role('button',name='صورة شخصية — استبعاد',exact=True)
  if reject.count(): reject.click();page.get_by_text('مرفق مستبعد؛ لا يُخزّن أو يُفهرس كصورة غرض.',exact=True).wait_for()
  card.locator('select').select_option('available');card.locator('form button').click();page.get_by_text('يلزم تأكيد أنك تحققت من التوفر.',exact=True).wait_for()
  card.locator('input[type=checkbox]').check();card.locator('form button').click();page.get_by_text('متوفر حسب آخر تأكيد',exact=True).wait_for()
  page.locator('#command').fill('منو صاحب الثلاجة مال 300 ألف بالمنصور؟');page.locator('#assistant button').click();expect(page.locator('#results article')).to_have_count(1);page.get_by_text('هاي السجلات المطابقة المحفوظة',exact=False).wait_for()
  page.locator('#semantic').click();page.get_by_text('الذكاء الاصطناعي غير مفعّل أو غير مربوط. البحث النصي متاح.',exact=True).wait_for()
  page.get_by_role('button',name='البائعون',exact=True).click();page.locator('#seller-list article').first.wait_for();assert page.locator('#seller-list article').count()==2
  page.get_by_role('button',name='الاهتمام',exact=True).click();page.locator('#interest-list article').first.wait_for();assert page.get_by_text('رابط المحادثة غير متوفر؛ لم ننشئ رابطاً تخمينياً.',exact=True).count()>=1
  page.get_by_role('button',name='التحكم',exact=True).click();page.locator('#switches input').first.wait_for();page.locator('#switches input').nth(1).check();expect(page.locator('#switches input').nth(1)).to_be_checked()
  page.reload();page.locator('#token').fill('admin-test-'*5);page.locator('#login button').click();page.locator('#results article').first.wait_for();page.get_by_role('button',name='التحكم',exact=True).click();page.locator('#switches input').first.wait_for();assert page.locator('#switches input').nth(1).is_checked()
  for tab in ['الأغراض','البائعون','الاهتمام','التحكم']:
   page.get_by_role('button',name=tab,exact=True).click();page.wait_for_timeout(70);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,tab)
  if width==390:
   page.get_by_role('button',name='الأغراض',exact=True).click();page.wait_for_timeout(100);page.screenshot(path=str(out/'iphone13-memory.png'),full_page=True)
   page.get_by_role('button',name='الاهتمام',exact=True).click();page.wait_for_timeout(100);page.screenshot(path=str(out/'iphone13-interest.png'),full_page=True)
  page.close()
 assert not errors,errors
 browser.close()
report={'widths':[320,390,430,768],'api':'actual local Worker and SQLite D1 adapter','data':'synthetic, not real Messenger users','js_errors':errors,'actual_iPhone':False,'production_tested':False}
(out/'browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False))
