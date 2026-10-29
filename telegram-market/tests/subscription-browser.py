"""Isolated browser fixtures for subscription conversion; never contacts Telegram."""
import unittest,json
import browser as fixtures

class SubscriptionBrowser(unittest.TestCase):
 setUpClass=classmethod(fixtures.BrowserTests.setUpClass.__func__)
 tearDownClass=classmethod(fixtures.BrowserTests.tearDownClass.__func__)
 tearDown=fixtures.BrowserTests.tearDown
 fixture=fixtures.BrowserTests.fixture
 def setUp(self):
  fixtures.BrowserTests.setUp(self)
  self.services_ready=False
  self.welcome_seen=False;self.prompt_state='unseen';self.test_requests={};self.test_accepted=False
  self.notify_prefs.update(bot_started=True,operational=False,operational_consent_at=None,blocked=False)
 def route(self,r):
  if '/api/notifications' in r.request.url:
   payload=r.request.post_data_json;op=payload['operation'];data=payload.get('data',{});self.calls.append({'path':'notifications','body':payload})
   if op=='welcome_claim':show=not self.welcome_seen;self.welcome_seen=True;result={'show':show}
   elif op=='onboarding_claim':show=self.prompt_state=='unseen';self.prompt_state='shown' if show else self.prompt_state;result={'show':show}
   elif op=='onboarding_enable':self.prompt_state='configuring';result={}
   elif op=='onboarding_defer':self.prompt_state='deferred';result={}
   elif op=='save':self.notify_prefs.update(data);self.prompt_state='configured';result=self.notify_prefs
   elif op=='get':result=self.notify_prefs
   elif op=='unsubscribe':self.notify_prefs.update(enabled=False,operational=False);result={}
   elif op=='user_test':self.test_requests[data['request']]=True;result={'event':8,'state':'pending'}
   elif op=='user_test_status':result={'event':8,'state':'sent','telegram_message_id':456} if self.test_accepted else {'event':8,'state':'pending'}
   else:result={}
   r.fulfill(json={'data':result});return
  fixtures.BrowserTests.route(self,r)
 def open(self,path='/'):
  self.page.goto(self.origin+path,wait_until='networkidle')
 def open_settings(self):
  self.welcome_seen=True;self.prompt_state='deferred';self.open('/?tgWebAppStartParam=notifications');self.page.locator('input[name=enabled]').wait_for()
 def test_first_entry_defer_and_reload_do_not_prompt_again(self):
  self.open();self.page.get_by_text('هلا بيك بوسيط 🌹 سوق العراقيين:',exact=False).wait_for();self.page.get_by_role('button',name='مو هسه',exact=True).click();self.assertEqual(self.prompt_state,'deferred');self.page.reload(wait_until='networkidle');self.assertEqual(self.page.get_by_role('button',name='مو هسه',exact=True).count(),0);self.assertFalse(self.notify_prefs['enabled']);self.assertFalse(any(c['body'].get('operation')=='save' for c in self.calls))
 def test_enable_filters_are_explicit_and_saved(self):
  self.open();self.page.get_by_role('button',name='فعّل الإشعارات',exact=True).click();self.page.locator('select[name=governorate]').select_option('البصرة');self.page.locator('input[name=category]').first.check();self.assertFalse(self.page.locator('input[name=operational]').is_checked());self.page.get_by_role('button',name='✅ احفظ وفعّل إشعاراتي',exact=True).click();self.page.get_by_text('✅ تم تفعيل إشعاراتك!',exact=False).wait_for();self.assertTrue(self.notify_prefs['enabled']);self.assertEqual(self.notify_prefs['governorate'],'البصرة');self.assertEqual(self.notify_prefs['categories'],['أثاث']);self.assertFalse(self.notify_prefs['operational'])
 def test_user_test_requires_explicit_confirmation_and_acceptance(self):
  self.open_settings();self.page.get_by_role('button',name='🔔 اختبار إشعاراتي',exact=True).click();self.assertEqual(len(self.test_requests),0);self.page.locator('dialog.confirmation').get_by_role('button',name='تأكيد',exact=True).click();self.page.get_by_text('وُضع اختبارك بالطابور.',exact=False).wait_for();self.assertEqual(len(self.test_requests),1);self.assertEqual(self.page.get_by_text('✅ قبل Telegram',exact=False).count(),0);self.test_accepted=True;self.page.get_by_role('button',name='تحديث حالة الاختبار').click();self.page.get_by_text('✅ قبل Telegram رسالة اختبارك',exact=False).wait_for();self.assertFalse(self.notify_prefs['enabled']);self.assertEqual(len(self.test_requests),1)
 def test_test_button_without_bot_start_never_queues(self):
  self.notify_prefs['bot_started']=False;self.open_settings();self.page.get_by_role('button',name='🔔 اختبار إشعاراتي',exact=True).click();self.page.get_by_role('link',name='ابدأ @WaseetIraqMarketBot').wait_for();self.assertEqual(len(self.test_requests),0)
 def test_ad_deep_link_keeps_ad_and_displays_inline_prompt(self):
  ad=self.fixture();self.ads=[ad];self.open('/?tgWebAppStartParam=ad_'+ad['id']);self.page.locator('.subscription-prompt button').get_by_text('مو هسه',exact=True).wait_for();self.assertIn(ad['title'],self.page.locator('#sheetTitle').inner_text());self.assertIn(ad['description'],self.page.locator('#sheetBody').inner_text());self.page.get_by_role('button',name='مو هسه',exact=True).click();self.assertIn(ad['title'],self.page.locator('#sheetTitle').inner_text());self.assertIn(ad['description'],self.page.locator('#sheetBody').inner_text());self.assertEqual(self.page.get_by_text('🔔 تحب توصلك',exact=False).count(),0)
 def test_previously_claimed_bot_prompt_is_not_repeated_in_miniapp(self):
  self.welcome_seen=True;self.prompt_state='shown';self.open();self.assertEqual(self.page.get_by_role('button',name='مو هسه',exact=True).count(),0);self.assertFalse(self.notify_prefs['enabled'])

if __name__=='__main__':unittest.main()
