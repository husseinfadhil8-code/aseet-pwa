"""Isolated production-shaped PostgreSQL subscription tests. No hosted writes/messages."""
import unittest,json,uuid
from concurrent.futures import ThreadPoolExecutor
from intelligence_database import IntelligenceTests,ROOT

class UserNotificationTests(IntelligenceTests):
 @classmethod
 def setUpClass(cls):
  super().setUpClass()
  cls.sql((ROOT/'db/011_notification_outbox.sql').read_text())
  # Preserve production-shaped old preferences, sent receipts and failed work.
  cls.action(1,'me');cls.action(2,'me');cls.action(3,'me',admin=True)
  cls.sql("insert into tg_market_notify_preferences(user_id,enabled,consent_at,operational) select id,true,now()-interval '2 hours',telegram_id=2 from tg_market_users where telegram_id in(1,2)")
  ad=cls.action(1,'save',{'title':'Legacy synthetic listing','category':'أثاث','area':'بغداد','price':5000,'condition':'used'})['id']
  cls.action(3,'admin_listing_approve',{'id':ad})
  cls.sql("insert into tg_market_notify_events(event_key,kind,listing_id,revision,done) select 'baseline-receipt','listing',id,approved_at,true from tg_market_listings where id='"+ad+"';insert into tg_market_notify_queue(event_id,user_id,state,message_id,created_at) select e.id,u.id,case when u.telegram_id=2 then 'sent' else 'failed' end,case when u.telegram_id=2 then 99 end,now()-interval '40 days' from tg_market_notify_events e cross join tg_market_users u where e.event_key='baseline-receipt' and u.telegram_id in(1,2)")
  projection="select md5(string_agg(to_jsonb(q)::text,'' order by q.user_id)) from (select user_id,enabled,consent_at,scope,governorate,categories,operational,rep_goods,paused_until,blocked,updated_at from tg_market_notify_preferences)q"
  before=cls.sql(projection);events=cls.sql('select count(*) from tg_market_notify_events');queue=cls.sql('select count(*) from tg_market_notify_queue')
  cls.sql((ROOT/'db/013_user_notifications.sql').read_text())
  cls.migration_preserved=(before==cls.sql(projection) and events==cls.sql('select count(*) from tg_market_notify_events') and queue==cls.sql('select count(*) from tg_market_notify_queue'))
  cls.migration_receipts=cls.sql("select count(*) from tg_market_notify_ad_receipts r join tg_market_notify_queue q on q.id=r.queue_id where q.state='sent' and q.message_id=99")
  cls.migration_personal=cls.sql("select string_agg((operational_consent_at is not null)::text,',' order by u.telegram_id) from tg_market_notify_preferences p join tg_market_users u on u.id=p.user_id")
  cls.migration_configured=cls.sql("select count(*) from tg_market_notify_preferences where onboarding_state='configured'")
 def contact(self,actor=2,blocked=False):return self.notify(actor,'bot_seen',{'blocked':blocked})
 def subscribe(self,actor=2,**extra):
  self.contact(actor);return self.sub(actor,operational=False,scope='governorate',governorate='بغداد',categories=['أثاث'],**extra)
 def user_test(self,actor=2,request=None,**extra):return self.notify(actor,'user_test',{'confirmed':True,'request':request or str(uuid.uuid4()),**extra})
 def eligibility(self,event,actor=2):return self.sql(f"select tg_market_notify_eligible({event},'{self.action(actor,'me')['id']}')")=='t'
 def test_user_migration_preserves_legacy_state_and_receipts(self):
  self.assertTrue(self.migration_preserved);self.assertEqual(self.migration_receipts,'1');self.assertEqual(self.migration_personal,'false,true');self.assertEqual(self.migration_configured,'2')
 def test_user_bulk_sync_cannot_clear_live_transport_block(self):
  self.contact(blocked=True);self.sql("select tg_market_notify_contacts('[{\"actor\":2,\"blocked\":false}]')",'service_role');self.assertTrue(self.notify(2,'get')['blocked'])
  self.contact(blocked=False);self.assertFalse(self.notify(2,'get')['blocked'])
 def test_user_selftest_concurrent_replay_queues_once(self):
  self.contact();request=str(uuid.uuid4())
  with ThreadPoolExecutor(max_workers=2) as pool:r=list(pool.map(lambda _:self.user_test(request=request),range(2)))
  self.assertEqual(r[0],r[1]);self.assertEqual(self.sql("select count(*) from tg_market_notify_queue"),'1')
 def test_user_welcome_and_offer_are_once_across_concurrent_surfaces(self):
  for op in ['welcome_claim','onboarding_claim']:
   with ThreadPoolExecutor(max_workers=2) as pool:r=list(pool.map(lambda surface:self.notify(2,op,{'surface':surface}),['bot','miniapp']))
   self.assertEqual(sum(v['show'] for v in r),1)
   self.assertFalse(self.notify(2,op,{'surface':'bot'})['show'])
  prefs=self.notify(2,'get');self.assertIsNotNone(prefs['welcome_seen_at']);self.assertFalse(prefs['enabled']);self.assertIsNone(prefs['consent_at']);self.assertFalse(prefs['bot_started'])
 def test_user_invalid_surface_and_implicit_consent_rejected(self):
  for op in ['welcome_claim','onboarding_claim']:
   for data in [{},{'surface':'forged'}]:
    with self.assertRaises(AssertionError):self.notify(2,op,data)
  with self.assertRaises(AssertionError):self.notify(2,'onboarding_enable')
  self.notify(2,'onboarding_claim',{'surface':'miniapp'});self.notify(2,'onboarding_defer');self.assertEqual(self.notify(2,'get')['onboarding_state'],'deferred')
  self.assertFalse(self.notify(2,'onboarding_claim',{'surface':'bot'})['show'])
 def test_user_target_filters_save_and_replay_do_not_resubscribe(self):
  self.contact();self.notify(2,'onboarding_enable',{'confirmed':True,'update':100})
  self.assertFalse(self.notify(2,'get')['enabled']);self.notify(2,'onboarding_filter',{'governorate':'بغداد','update':101})
  self.notify(2,'onboarding_filter',{'category':'أثاث','update':102});self.notify(2,'onboarding_filter',{'category':'أثاث','update':102})
  self.assertEqual(self.notify(2,'get')['categories'],['أثاث'])
  self.sub(2,scope='governorate',governorate='بغداد',categories=['أثاث'],operational=False)
  self.assertEqual(self.notify(2,'get')['onboarding_state'],'configured')
  self.notify(2,'unsubscribe');self.notify(2,'onboarding_enable',{'confirmed':True,'update':100});self.assertFalse(self.notify(2,'get')['enabled'])
 def test_user_approved_ad_only_to_started_consented_matching_account(self):
  self.subscribe();self.approved(governorate='البصرة');self.approved(category='سيارات');self.pump();self.assertEqual(self.claim(),{})
  ad=self.approved();self.pump();j=self.claim();self.assertEqual(j['chat'],2);self.assertEqual(j['listing'],ad);self.finish(j);self.assertEqual(self.claim(),{})
  self.assertFalse(self.notify(1,'get')['enabled']);self.assertEqual(self.sql("select count(*) from tg_market_notify_queue where state='sent'"),'1')
 def test_user_contact_sync_requires_existing_user_and_never_implies_marketing(self):
  contacts=[{'actor':2,'blocked':False},{'actor':999999,'blocked':False}]
  p=json.dumps(contacts);self.assertEqual(json.loads(self.sql(f"select tg_market_notify_contacts('{p}')",'service_role'))['synced'],1)
  self.assertEqual(self.sql('select count(*) from tg_market_users'),'3');self.assertFalse(self.notify(2,'get')['enabled']);self.assertTrue(self.notify(2,'get')['bot_started'])
  self.sub(2,operational=False);self.approved();self.pump();self.contact(blocked=True);self.assertEqual(self.claim()['skipped'],True)
 def test_user_existing_pending_waits_for_contact_sync_without_loss(self):
  self.subscribe();self.approved();self.pump();self.sql('update tg_market_notify_preferences set bot_started_at=null where user_id=(select id from tg_market_users where telegram_id=2)')
  self.assertTrue(self.claim()['skipped']);self.assertEqual(self.sql("select state||':'||error_code from tg_market_notify_queue"),'pending:private_start_unverified')
  self.contact();self.sql('update tg_market_notify_queue set available_at=now()');self.assertTrue(self.claim().get('id'))
 def test_user_miniapp_subscription_without_real_bot_start_cannot_send(self):
  self.sub(2,operational=False);self.approved();self.pump();self.assertEqual(self.claim(),{})
  with self.assertRaises(AssertionError):self.user_test()
 def test_user_selftest_is_explicit_idempotent_own_status_and_not_subscription(self):
  self.contact();request=str(uuid.uuid4())
  with self.assertRaises(AssertionError):self.notify(2,'user_test',{'request':request})
  with self.assertRaises(AssertionError):self.notify(2,'user_test',{'confirmed':True})
  t=self.user_test(request=request);self.assertEqual(t['state'],'pending');self.assertEqual(self.user_test(request=request),t)
  self.assertEqual(self.notify(1,'user_test_status',{'request':request}),{'state':'not_found'})
  with self.assertRaises(AssertionError):self.user_test()
  self.sql('update tg_market_notify_control set enabled=false');j=self.claim();self.assertEqual(j['kind'],'test_user');self.assertEqual(j['chat'],2);self.finish(j,message=123)
  status=self.notify(2,'user_test_status',{'request':request});self.assertEqual(status['state'],'sent');self.assertEqual(status['telegram_message_id'],123);self.assertFalse(self.notify(2,'get')['enabled'])
  self.assertEqual(self.claim(),{})
 def test_user_selftest_optional_real_approved_ad_photo_and_sold_revalidate(self):
  self.contact();im=self.action(1,'image_intent',{'mime':'image/jpeg'});self.action(1,'image_ready',{'id':im['id']});ad=self.approved(images=[im['id']])
  self.user_test(listing=ad);j=self.claim();self.assertEqual(j['listing'],ad);self.assertEqual(j['image']['path'],im['path'])
  self.action(1,'status',{'id':ad,'status':'sold'});self.assertFalse(self.work('validate',{'id':j['id'],'lease':j['lease']})['valid'])
 def test_user_unsubscribe_and_ad_status_are_rechecked_before_send(self):
  self.subscribe();ad=self.approved();self.pump();j=self.claim();self.notify(2,'unsubscribe');self.assertFalse(self.work('validate',{'id':j['id'],'lease':j['lease']})['valid'])
  self.subscribe();ad=self.approved();self.pump();j=self.claim();self.sql(f"update tg_market_listings set status='hidden' where id='{ad}'");self.assertFalse(self.work('validate',{'id':j['id'],'lease':j['lease']})['valid'])
 def test_user_operational_consent_is_independent_of_marketing(self):
  self.contact();self.sub(2,enabled=False,operational=True);ad=self.approved();t=self.action(2,'thread',{'id':ad})['id'];self.action(1,'send',{'id':t,'body':'Private synthetic reply'});self.pump();j=self.claim();self.assertEqual(j['kind'],'message');self.finish(j)
  self.assertFalse(self.notify(2,'get')['enabled']);self.assertIsNotNone(self.notify(2,'get')['operational_consent_at'])
  self.notify(2,'unsubscribe');self.action(1,'send',{'id':t,'body':'Must remain optional'});self.pump();self.assertEqual(self.claim(),{})
 def test_user_disabling_offers_preserves_pending_account_message(self):
  self.contact();self.sub(2,operational=True);ad=self.approved();self.pump()
  while (j:=self.claim()).get('id'):self.finish(j)
  t=self.action(2,'thread',{'id':ad})['id'];self.action(1,'send',{'id':t,'body':'Retained personal message'});self.pump();self.sub(2,enabled=False,operational=True)
  self.assertEqual(self.claim()['kind'],'message')
 def test_user_radar_and_general_ad_share_one_delivery_receipt(self):
  self.subscribe();r=self.radar(notifications=True,confirmed=True);ad=self.approved(title='كرسي خشب نظيف');self.scan();self.pump();j=self.claim();self.finish(j)
  for _ in range(10):
   k=self.claim()
   if k.get('id'):self.fail('same listing claimed twice via radar/general')
  self.assertEqual(self.sql('select count(*) from tg_market_notify_ad_receipts'),'1');self.assertEqual(self.sql("select count(*) from tg_market_notify_queue where state='sent'"),'1')
 def test_user_retry_backoff_and_uncertain_response_retained(self):
  self.subscribe();self.approved();self.pump();j=self.claim();self.finish(j,'retryable');first=int(self.sql("select extract(epoch from available_at-now())::int from tg_market_notify_queue where id='"+j['id']+"'"));self.assertGreaterEqual(first,14)
  self.sql("update tg_market_notify_queue set available_at=now(),attempts=15");j=self.claim();self.assertTrue(j.get('id'));self.finish(j,'rate_limited',retry_after=60);self.assertGreater(self.work('claim')['wait_ms'],50000)
  self.sql('update tg_market_notify_queue set available_at=now()');j=self.claim();self.finish(j,'review');self.assertEqual(self.claim(),{});self.assertEqual(self.sql('select count(*) from tg_market_notify_queue'),'1')
 def test_user_failed_records_not_deleted_and_banned_actions_rejected(self):
  self.contact();self.user_test();j=self.claim();self.finish(j,'failed');self.sql("update tg_market_notify_queue set created_at=now()-interval '40 days'");self.pump();self.assertEqual(self.sql("select count(*) from tg_market_notify_queue where state='failed'"),'1')
  self.sql('update tg_market_users set banned=true where telegram_id=2')
  for op,data in [('welcome_claim',{'surface':'bot'}),('onboarding_enable',{'confirmed':True}),('user_test',{'confirmed':True,'request':str(uuid.uuid4())})]:
   with self.assertRaises(AssertionError):self.notify(2,op,data)
  self.notify(2,'unsubscribe')
 def test_user_receipts_and_contacts_are_private_service_rpc_only(self):
  for role in ['anon','authenticated','service_role']:self.sql('select * from tg_market_notify_ad_receipts',role,deny=True)
  for role in ['anon','authenticated']:
   self.sql("select tg_market_notify_contacts('[]')",role,deny=True);self.sql("select tg_market_notifications(2,'get')",role,deny=True)
  self.sql("select tg_market_notifications_v12(2,'get')",'service_role',deny=True);self.sql("select tg_market_notify_worker_v12('claim')",'service_role',deny=True)
  self.assertEqual(self.sql("select relrowsecurity and relforcerowsecurity from pg_class where relname='tg_market_notify_ad_receipts'"),'t')

if __name__=='__main__':
 suite=unittest.TestSuite(UserNotificationTests(n) for n in unittest.defaultTestLoader.getTestCaseNames(UserNotificationTests) if n.startswith('test_user_'))
 raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
