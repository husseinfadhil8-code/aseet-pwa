"""Synthetic browser journeys, no hosted users, approvals, messages or notifications."""
import unittest,json
from browser import BrowserTests
class WantedBrowser(BrowserTests):
 def setUp(self):
  super().setUp();self.wanted_rows=[];self.radars=[];self.wanted_status='pending';self.requests=[]
 def sample(self):return {'id':'00000000-0000-0000-0000-000000000005','title':'مطلوب كرسي خشب','description':'كرسي نظيف للبيت','category':'أثاث','governorate':'بغداد','area':'الكرادة','budget':10000,'images':[],'status':self.wanted_status,'expires_at':'2026-12-01T00:00:00Z'}
 def route(self,r):
  if '/api/wanted' not in r.request.url:return super().route(r)
  if r.request.method=='GET':r.fulfill(json={'data':self.wanted_rows});return
  p=json.loads(r.request.post_data);self.requests.append(p);op=p['operation'];d=p.get('data',{});result={}
  if op=='save':self.wanted_rows=[{**self.sample(),**d,'status':'pending'}];result=self.wanted_rows[0]
  elif op=='mine':result=self.wanted_rows
  elif op=='radars':result=self.radars
  elif op=='radar_save':self.radars=[{**d}];result=d
  elif op=='matches':result=[]
  elif op=='close':self.wanted_rows[0]['status']='closed'
  elif op=='admin':result={'requests':self.wanted_rows,'reports':[],'offers':0,'radars':len(self.radars)}
  elif op=='offers':result=[]
  r.fulfill(json={'data':result})
 def test_wanted_mobile_browse_filters_no_floating_controls(self):
  self.wanted_status='approved';self.wanted_rows=[self.sample()];self.open();self.page.locator('#wantedEntry').click();self.page.get_by_role('heading',name='مطلوب كرسي خشب').wait_for();self.assertIn('عندي هذا الغرض',self.page.locator('#sheetBody').inner_text())
  for width in [320,390,430,768]:self.page.set_viewport_size({'width':width,'height':844});self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
 def test_wanted_create_server_saved_pending_and_offers(self):
  self.open();self.page.locator('#wantedEntry').click();self.page.get_by_role('button',name='＋ أضف طلب شراء').click();self.page.get_by_label('اسم الغرض المطلوب',exact=True).fill('مطلوب كرسي خشب');self.page.get_by_label('المنطقة',exact=True).fill('الكرادة');self.page.get_by_label('الميزانية القصوى بالدينار').fill('10000');self.page.get_by_label('المواصفات المطلوبة',exact=False).fill('كرسي نظيف للبيت');self.page.get_by_role('button',name='إرسال للمراجعة').click();self.page.get_by_role('button',name='العروض المقدمة').wait_for();self.assertIn('بانتظار المراجعة',self.page.locator('#sheetBody').inner_text());self.assertEqual(sum(x['operation']=='save' for x in self.requests),1)
 def test_radar_private_and_explicit_notification_consent(self):
  self.open();self.page.locator('#account').click();self.page.get_by_role('button',name='راداري',exact=True).click();self.page.get_by_role('button',name='＋ رادار بحث جديد').click();self.page.get_by_label('اسم الرادار',exact=True).fill('كرسي للبيت');self.page.get_by_label('كلمات مطلوبة').fill('كرسي خشب');self.page.get_by_label('أعلى سعر بالدينار').fill('5000');self.assertFalse(self.page.get_by_label('أوافق على تنبيهات').is_checked());self.page.get_by_role('button',name='حفظ وفحص الإعلانات').click();self.page.get_by_role('button',name='النتائج المطابقة').wait_for();saved=next(x['data'] for x in self.requests if x['operation']=='radar_save');self.assertFalse(saved['notifications']);self.assertIsNone(saved['request_id']);self.assertFalse(any(x['operation']=='save' for x in self.requests))
 def test_wanted_admin_only_entry_and_saved_review(self):
  self.role='admin';self.wanted_rows=[self.sample()];self.open();self.page.locator('#account').click();self.page.get_by_role('button',name='إدارة مطلوب والرادار').click();self.page.get_by_role('button',name='اعتماد الطلب').wait_for();self.assertIn('بانتظار المراجعة',self.page.locator('#sheetBody').inner_text())
if __name__=='__main__':
 suite=unittest.TestSuite(WantedBrowser(n) for n in unittest.defaultTestLoader.getTestCaseNames(WantedBrowser) if n.startswith(('test_wanted_','test_radar_')))
 raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
