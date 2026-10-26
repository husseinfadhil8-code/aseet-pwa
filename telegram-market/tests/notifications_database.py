"""Actual isolated PostgreSQL notification tests. No hosted fixtures or Telegram sends."""
import unittest,json,uuid
from settings_database import SettingsTests,ROOT
class NotificationTests(SettingsTests):
 @classmethod
 def setUpClass(cls):super().setUpClass();cls.sql((ROOT/'db/004_notifications.sql').read_text())
 def setUp(self):
  super().setUp();self.sql('truncate tg_market_notify_events cascade;truncate tg_market_rep_goods cascade;update tg_market_notify_control set enabled=true,enabled_at=now()-interval \'1 hour\',next_send_at=now()')
 def notify(self,actor,operation,data=None):
  payload=json.dumps(data or {}).replace("'","''");return json.loads(self.sql(f"select tg_market_notifications({actor},'{operation}','{payload}',{str(actor==3).lower()})",'service_role'))
 def work(self,operation,data=None):
  payload=json.dumps(data or {}).replace("'","''");return json.loads(self.sql(f"select tg_market_notify_worker('{operation}','{payload}')",'service_role'))
 def sub(self,actor=2,**extra):return self.notify(actor,'save',{'enabled':True,'confirmed':True,'scope':'all',**extra})
 def approved(self,actor=1,**extra):
  ad=self.notify(actor,'save_listing',{'title':'Synthetic test listing','category':'أثاث','area':'الكرادة','governorate':'بغداد','price':5000,'condition':'used',**extra})['id'];self.action(3,'admin_listing_approve',{'id':ad});return ad
 def pump(self):
  for _ in range(10):self.work('fanout')
 def claim(self):self.sql('update tg_market_notify_control set next_send_at=now()');return self.work('claim')
 def finish(self,j,outcome='sent',**extra):return self.work('finish',{'id':j['id'],'lease':j['lease'],'outcome':outcome,'message':42,**extra})
 def test_notify_no_default_or_implicit_start_subscription(self):
  self.assertFalse(self.notify(1,'get')['enabled']);self.approved();self.pump();self.assertEqual(self.claim(),{})
  with self.assertRaises(AssertionError):self.notify(1,'save',{'enabled':True})
  with self.assertRaises(AssertionError):self.notify(1,'save',{'enabled':'true','confirmed':True})
 def test_notify_filters_and_no_late_subscriber_backfill(self):
  self.sub(scope='governorate',governorate='البصرة');self.approved();self.pump();self.assertEqual(self.claim(),{})
  self.sub(scope='governorate',governorate='بغداد',categories=['سيارات']);self.approved();self.pump();self.assertEqual(self.claim(),{})
  self.sub(categories=['أثاث']);ad=self.approved();self.sub(1);self.pump();j=self.claim();self.assertEqual(j['listing'],ad);self.finish(j);self.assertEqual(self.claim(),{})
 def test_notify_retry_dedup_and_edit_reapproval(self):
  self.sub();ad=self.approved();self.action(3,'admin_listing_approve',{'id':ad});self.pump();j=self.claim();self.finish(j);self.finish(j);self.assertEqual(self.claim(),{})
  self.action(1,'save',{'id':ad,'title':'Changed synthetic ad','category':'أثاث','area':'بغداد','price':6000,'condition':'used'});self.action(3,'admin_listing_approve',{'id':ad});self.pump();self.assertEqual(self.claim(),{});self.assertEqual(self.sql("select count(*) from tg_market_notify_queue where state='sent'"),'1')
 def test_notify_hidden_sold_deleted_reported_do_not_send(self):
  self.sub()
  for status in ['hidden','sold','deleted']:
   ad=self.approved();self.sql("update tg_market_listings set status='"+status+"' where id='"+ad+"'");self.pump();self.assertEqual(self.claim(),{})
  ad=self.approved();self.action(2,'report',{'id':ad,'reason':'Synthetic report'});self.pump();self.assertEqual(self.claim(),{})
 def test_notify_pause_unsubscribe_and_revalidation(self):
  self.sub();self.approved();self.pump();j=self.claim();self.notify(2,'unsubscribe');self.assertFalse(self.work('validate',{'id':j['id'],'lease':j['lease']})['valid']);self.finish(j);self.assertEqual(self.sql("select state from tg_market_notify_queue where id='"+j['id']+"'"),'cancelled')
  self.sub();self.approved();self.pump();self.notify(2,'pause');self.assertEqual(self.claim(),{})
 def test_notify_rate_limit_is_global_and_block_stops_all(self):
  self.sub();self.approved();self.approved();self.pump();j=self.claim();self.finish(j,'rate_limited',retry_after=90);self.assertGreater(self.work('claim')['wait_ms'],80000);self.sql('update tg_market_notify_queue set available_at=now()');j=self.claim();self.finish(j,'blocked');self.assertFalse(self.notify(2,'get')['enabled']);self.assertTrue(self.notify(2,'get')['blocked']);self.assertEqual(self.claim(),{})
 def test_notify_unknown_delivery_is_never_automatically_retried(self):
  self.sub();self.approved();self.pump();j=self.claim();self.finish(j,'review');self.assertEqual(self.claim(),{});self.assertEqual(self.sql("select state from tg_market_notify_queue where id='"+j['id']+"'"),'review')
 def test_notify_crash_stale_lease_and_foreign_ack(self):
  self.sub();self.approved();self.pump();j=self.claim();self.finish({**j,'lease':str(uuid.uuid4())});self.assertEqual(self.sql("select state from tg_market_notify_queue where id='"+j['id']+"'"),'sending');self.sql("update tg_market_notify_queue set claimed_at=now()-interval '10 minutes'");self.pump();self.assertEqual(self.sql("select state from tg_market_notify_queue where id='"+j['id']+"'"),'review')
 def test_notify_rpc_and_queue_cannot_be_accessed_by_clients(self):
  for role in ['anon','authenticated']:
   self.sql("select tg_market_notifications(3,'stats','{}',true)",role,deny=True);self.sql("select tg_market_notify_worker('claim')",role,deny=True)
   for t in ['preferences','queue','events','control','presence','reads','updates']:self.sql('select * from tg_market_notify_'+t,role,deny=True)
  for op in ['stats','test','reject_listing','good_save']:
   with self.assertRaises(AssertionError):self.notify(1,op,{})
 def test_notify_bot_consent_updates_are_replay_safe_and_preserve_filters(self):
  self.notify(2,'bot_enable',{'update':10});self.sub(categories=['سيارات']);self.notify(2,'bot_enable',{'update':11});self.assertEqual(self.notify(2,'get')['categories'],['سيارات']);self.notify(2,'bot_stop',{'update':12});self.notify(2,'bot_enable',{'update':10});self.assertFalse(self.notify(2,'get')['enabled'])
 def test_notify_private_messages_and_open_conversation_suppression(self):
  self.sub();ad=self.approved();self.pump();j=self.claim();self.finish(j);t=self.action(2,'thread',{'id':ad})['id'];self.notify(2,'presence',{'thread':t,'active':True});self.action(1,'send',{'id':t,'body':'Synthetic private text'});read=self.action(2,'messages',{'id':t})[-1]['id'];self.notify(2,'presence',{'thread':t,'active':True,'read_id':read});self.pump();self.assertEqual(self.claim(),{});self.notify(2,'presence',{'thread':t,'active':False});self.action(1,'send',{'id':t,'body':'Another private message'});self.pump();j=self.claim();self.assertEqual(j['kind'],'message');self.assertNotIn('body',j);self.assertEqual(j['chat'],2)
 def test_notify_rep_goods_roles_and_review_notifications(self):
  self.sub();self.sub(1);self.sub(3);self.approve_rep(1);self.pump()
  while (j:=self.claim()).get('id'):self.finish(j)
  self.notify(3,'good_save',{'id':str(uuid.uuid4()),'title':'Synthetic rep good','description':'private','area':'بغداد','price':5000});self.pump();j=self.claim();self.assertEqual(j['chat'],1);self.assertEqual(j['kind'],'rep_good');self.finish(j);self.assertEqual(self.claim(),{})
  with self.assertRaises(AssertionError):self.notify(2,'goods')
 def test_notify_owner_approval_rejection_and_startup_no_backfill(self):
  ad=self.listing();self.sql("update tg_market_listings set approved_at=now(),approved_by=(select user_id from tg_market_root) where id='"+ad+"'");self.sub(1);self.pump();self.assertEqual(self.claim(),{});ad=self.approved();self.pump();j=self.claim();self.assertEqual(j['kind'],'listing_approved');self.finish(j);self.notify(3,'reject_listing',{'id':ad});self.pump();j=self.claim();self.assertEqual(j['kind'],'listing_rejected')
 def test_notify_test_is_explicit_root_only_not_subscription(self):
  self.sql('update tg_market_notify_control set enabled=false')
  with self.assertRaises(AssertionError):self.work('activate')
  request=str(uuid.uuid4());self.notify(3,'test',{'confirmed':True,'request':request});self.notify(3,'test',{'confirmed':True,'request':request});j=self.claim();self.assertEqual(j['kind'],'test');self.assertFalse(self.notify(3,'get')['enabled']);self.finish(j);self.work('activate');self.assertEqual(self.claim(),{})
 def test_notify_concurrent_workers_claim_only_one_global_slot(self):
  from concurrent.futures import ThreadPoolExecutor
  self.sub();self.approved();self.approved();self.pump();self.sql('update tg_market_notify_control set next_send_at=now()')
  with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:self.work('claim'),range(2)))
  self.assertEqual(sum(bool(r.get('id')) for r in results),1);self.assertEqual(sum(bool(r.get('wait_ms')) for r in results),1)
 def test_notify_region_change_clears_approval_and_cancels_claim(self):
  self.sub();ad=self.approved();self.pump();j=self.claim();self.sql("update tg_market_listings set governorate='البصرة' where id='"+ad+"'");self.assertFalse(self.work('validate',{'id':j['id'],'lease':j['lease']})['valid']);self.assertEqual(self.sql("select approved_at is null from tg_market_listings where id='"+ad+"'"),'t')
 def test_notify_force_close_does_not_lose_an_unread_chat_message(self):
  self.sub();ad=self.approved();self.pump();j=self.claim();self.finish(j);t=self.action(2,'thread',{'id':ad})['id'];self.notify(2,'presence',{'thread':t,'active':True});self.action(1,'send',{'id':t,'body':'Unread test'});self.pump();self.assertTrue(self.claim()['skipped']);self.assertEqual(self.sql("select count(*) from tg_market_notify_queue where state='pending'"),'1');self.sql("update tg_market_notify_presence set expires_at=now()-interval '1 minute';update tg_market_notify_queue set available_at=now()");self.assertEqual(self.claim()['kind'],'message')
 def test_notify_closed_test_can_use_only_an_approved_real_owner_listing(self):
  ad=self.approved(1)
  with self.assertRaises(AssertionError):self.notify(3,'test',{'confirmed':True,'request':str(uuid.uuid4()),'listing':ad})
  image=self.action(3,'image_intent',{'mime':'image/jpeg'});self.action(3,'image_ready',{'id':image['id']});ad=self.approved(3,images=[image['id']]);self.notify(3,'test',{'confirmed':True,'request':str(uuid.uuid4()),'listing':ad});j=self.claim();self.assertEqual(j['kind'],'test');self.assertEqual(j['listing'],ad);self.assertEqual(j['image']['path'],image['path']);self.assertFalse(self.notify(3,'get')['enabled'])
if __name__=='__main__':
 suite=unittest.TestSuite(NotificationTests(n) for n in NotificationTests.__dict__ if n.startswith('test_notify_'));r=unittest.TextTestRunner(verbosity=2).run(suite);raise SystemExit(not r.wasSuccessful())
