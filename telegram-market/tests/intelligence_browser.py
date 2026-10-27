"""Browser simulations, never actual Telegram device, AI provider or educational send."""
import unittest,json
from wanted_browser import WantedBrowser
from browser import ROOT
class IntelligenceBrowser(WantedBrowser):
 def setUp(self):
  super().setUp();self.intel_calls=[];self.learning=False;self.ai_consent=False
  self.intel_cfg={'channel_enabled':False,'tips_enabled':False,'assistant_enabled':False,'provider':'basic','style':'مختصر ومحترم','interval_hours':10,'last_channel_success':None,'next_channel_at':None,'daily_budget_micros':0,'monthly_budget_micros':0,'free_neurons_day':0,'version':1}
  self.topics=[{'id':'00000000-0000-0000-0000-000000000010','slug':'radar','title':'رادار وسيط','body':'منشور تعليمي حقيقي عن خدمات الرادار في وسيط.','tip':'نصيحة خاصة مختصرة مختلفة عن منشور القناة.','route':'radars','enabled':True,'approved':False,'image_id':None,'version':1}]
 def route(self,r):
  if '/api/intelligence' not in r.request.url:return super().route(r)
  p=json.loads(r.request.post_data);self.intel_calls.append(p);op=p['operation'];d=p.get('data',{});out={}
  if op in ['admin','settings_save','topic_save','manual_publish','preview','kill','knowledge_approve','resolve','topic_delete'] and self.role!='admin':r.fulfill(status=403,json={'error':'owner_required'});return
  if op=='admin':out={'settings':self.intel_cfg,'topics':self.topics,'recent':[],'metrics':{'tips_subscribers':0,'sent':0,'failed':0},'usage':[],'support':[],'provider_available':{'cloudflare':False,'openai':False},'knowledge_preview':'معرفة الإصدار الحالي عن السوق ومطلوب والرادار.','knowledge_version':'synthetic.v1'}
  elif op=='preferences':out={'tips_enabled':self.learning,'ai_consent':self.ai_consent,'assistant_enabled':False}
  elif op=='tips_enable':self.learning=True
  elif op=='tips_stop':self.learning=False
  elif op=='ai_consent':self.ai_consent=True
  elif op=='forget':self.ai_consent=False
  elif op=='kill':self.intel_cfg.update(channel_enabled=False,tips_enabled=False,assistant_enabled=False)
  elif op=='settings_save':self.intel_cfg.update(d)
  elif op=='topic_save':self.topics=[{**self.topics[0],**d,'version':2}]
  elif op=='preview':out={'text':'مساعدة وسيط الأساسية: لا توجد نتائج مطابقة حالياً. جرّب مطلوب أو الرادار.','reply_markup':{'inline_keyboard':[]},'ai':False}
  r.fulfill(json={'data':out})
 def test_intel_owner_panel_disabled_defaults_and_mobile_layout(self):
  self.role='admin';self.open();self.page.locator('#account').click();self.page.get_by_role('button',name='المرشد والمساعد الذكي',exact=True).click();self.page.get_by_role('button',name='إيقاف فوري',exact=False).wait_for();self.assertFalse(self.page.locator('input[name=channel_enabled]').is_checked());self.assertFalse(self.page.locator('input[name=tips_enabled]').is_checked());self.assertFalse(self.page.locator('input[name=assistant_enabled]').is_checked());self.assertFalse(any(p['operation']!='admin' for p in self.intel_calls))
  for w in [320,390,430,768]:self.page.set_viewport_size({'width':w,'height':844});self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
 def test_intel_non_owner_no_admin_entry(self):
  self.open();self.page.locator('#account').click();self.page.get_by_role('button',name='النصائح وخصوصية المساعد').wait_for();self.assertEqual(self.page.get_by_role('button',name='المرشد والمساعد الذكي',exact=True).count(),0)
 def test_intel_topic_preview_does_not_send_or_save_before_confirmation(self):
  self.role='admin';self.open();self.page.locator('#account').click();self.page.get_by_role('button',name='المرشد والمساعد الذكي',exact=True).click();self.page.get_by_role('button',name='تعديل ومعاينة واعتماد').click();self.page.get_by_label('منشور القناة',exact=False).fill('محتوى تعليمي معدل للمراجعة قبل الحفظ والإرسال.');self.page.get_by_role('button',name='معاينة قبل الحفظ',exact=True).click();self.assertFalse(any(p['operation']=='topic_save' for p in self.intel_calls));self.page.get_by_role('button',name='تأكيد حفظ المحتوى',exact=True).click();self.confirm();self.page.get_by_role('button',name='إيقاف فوري',exact=False).wait_for();self.assertTrue(any(p['operation']=='topic_save' for p in self.intel_calls));self.assertFalse(any(p['operation']=='manual_publish' for p in self.intel_calls))
 def test_intel_weekly_consent_is_explicit_and_does_not_subscribe_radar(self):
  self.open();self.page.evaluate("(()=>{Telegram.WebApp.isVersionAtLeast=()=>true;Telegram.WebApp.requestWriteAccess=cb=>cb(true);return true})()");self.page.locator('#account').click();self.page.get_by_role('button',name='النصائح وخصوصية المساعد').click();self.page.get_by_role('button',name='أوافق على النصائح التعليمية والترويجية الأسبوعية').click();self.assertFalse(self.learning);self.confirm();self.page.get_by_role('button',name='إيقاف النصائح',exact=True).wait_for();self.assertTrue(self.learning);self.assertFalse(self.notify_prefs['enabled']);self.page.get_by_role('button',name='إيقاف النصائح',exact=True).click();self.page.get_by_role('button',name='أوافق على النصائح التعليمية والترويجية الأسبوعية').wait_for();self.assertFalse(self.learning)
 def test_intel_preview_uses_basic_label_and_no_provider_or_support_write(self):
  self.role='admin';self.open();self.page.locator('#account').click();self.page.get_by_role('button',name='المرشد والمساعد الذكي',exact=True).click();self.page.get_by_role('button',name='معاينة المساعدة والبحث',exact=False).click();self.page.get_by_label('سؤال اختباري',exact=False).fill('أريد ثلاجة ببغداد بحدود 200 ألف');self.page.get_by_role('button',name='معاينة البحث والرد').click();self.page.get_by_text('مساعدة وسيط الأساسية:',exact=False).wait_for();self.assertEqual([x['operation'] for x in self.intel_calls],['admin','preview'])
 def test_intel_emergency_stop_is_immediate(self):
  self.role='admin';self.intel_cfg.update(channel_enabled=True,tips_enabled=True);self.open();self.page.locator('#account').click();self.page.get_by_role('button',name='المرشد والمساعد الذكي',exact=True).click();self.page.get_by_role('button',name='إيقاف فوري',exact=False).click();self.page.wait_for_function("document.querySelector('input[name=channel_enabled]')&&!document.querySelector('input[name=channel_enabled]').checked");self.assertFalse(self.intel_cfg['tips_enabled']);self.assertTrue(any(p['operation']=='kill' for p in self.intel_calls))
 def test_intel_feature_links_resolve_to_actual_miniapp_sections(self):
  for route,title in [('wanted','مطلوب في وسيط'),('radars','راداري'),('add','إعلان مجاني'),('mine',None),('inbox','محادثات السوق'),('account','حسابي'),('notifications','إعدادات الإشعارات'),('support','الدعم')]:
   self.page.goto('about:blank');self.page.goto(self.origin+'/#tgWebAppStartParam='+route,wait_until='networkidle')
   if title:self.page.get_by_role('heading',name=title,exact=True).wait_for()
   else:self.page.wait_for_function("document.querySelector('#marketTitle').textContent==='إعلاناتي'")
if __name__=='__main__':
 suite=unittest.TestSuite(IntelligenceBrowser(n) for n in unittest.defaultTestLoader.getTestCaseNames(IntelligenceBrowser) if n.startswith('test_intel_'))
 raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
