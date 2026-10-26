"""Phase3 actual disposable PostgreSQL checks; no hosted data or payment."""
import unittest,json,uuid
from database import DatabaseTests,ROOT
class SettingsTests(DatabaseTests):
 @classmethod
 def setUpClass(cls):
  super().setUpClass();cls.sql((ROOT/'db/003_admin_settings.sql').read_text())
 def setUp(self):
  super().setUp();self.sql("truncate tg_market_packages cascade;insert into tg_market_packages(name,days) values('ترويج يوم واحد',1),('ترويج 7 أيام',7),('ترويج 14 يوماً',14),('ترويج 30 يوماً',30);update tg_market_settings set channel=null,channel_title=null,channel_verified=false,auto_publish=false,purchases_enabled=false,payments_verified=false")
 def package(self,**data):
  return self.action(3,'packages_save',{'name':'Synthetic package','description':'Synthetic description','days':7,'stars':50,'priority':10,'enabled':True,'confirmed':True,**data})
 def live(self):self.sql('update tg_market_settings set payments_verified=true,purchases_enabled=true')
 def test_settings_private_name_and_verified_identity(self):
  uid=self.action(3,'me')['id'];self.assertEqual(self.action(3,'me')['name'],'مدير وسيط');ad=self.listing(3);feed=json.loads(self.sql('select tg_market_public()','service_role'));self.assertTrue(feed[0]['author']['verified_internal']);self.assertNotIn('Synthetic user',json.dumps(feed));self.assertEqual(self.sql("select original_name from tg_market_private_identity where user_id='"+uid+"'"),'Synthetic user');self.assertFalse(json.loads(self.sql("select tg_market_identity('"+self.action(1,'me')['id']+"')",'service_role'))['verified_internal'])
 def test_settings_private_tables_and_retired_rpc(self):
  for role in ['anon','authenticated']:
   for table in ['private_identity','settings','packages','publications']:self.sql('select * from tg_market_'+table,role,deny=True)
  self.sql("select tg_market_action_v2(1,'admin','{}',false,'forged')",'service_role',deny=True)
  for action in ['settings','packages_save','channel_save','publication_resolve','purchases_save']:
   with self.assertRaises(AssertionError):self.action(1,action,{'confirmed':True,'enabled':True})
 def test_settings_seeded_packages_have_no_paid_default(self):
  packages=self.action(3,'settings')['packages'];self.assertEqual(sorted(p['days'] for p in packages),[1,7,14,30]);self.assertTrue(all(p['stars'] is None and not p['enabled'] for p in packages));self.assertEqual(json.loads(self.sql('select tg_market_offers()','service_role')),[])
 def test_settings_price_confirmation_version_and_history(self):
  with self.assertRaises(AssertionError):self.package(confirmed=False)
  p=self.package();self.live();ad=self.listing();o=self.action(1,'order',{'id':ad,'package':p['id'],'stars':1,'days':30});self.assertEqual(o['stars'],50);self.assertEqual(o['duration_days'],7)
  changed=self.package(id=p['id'],version=p['version'],stars=90,days=12,name='Changed package');self.assertEqual(changed['version'],2)
  old=self.action(1,'order',{'id':ad,'package':p['id']});self.assertEqual(old['stars'],50);self.assertEqual(old['duration_days'],7);self.assertEqual(old['snapshot_name'],'Synthetic package')
  with self.assertRaises(AssertionError):self.package(id=p['id'],version=p['version'],stars=5)
 def test_settings_purchase_gate_and_real_confirmation_required(self):
  p=self.package();ad=self.listing()
  with self.assertRaises(AssertionError):self.action(3,'purchases_save',{'enabled':'true'})
  with self.assertRaises(AssertionError):self.action(3,'purchases_save',{'enabled':True})
  with self.assertRaises(AssertionError):self.action(1,'order',{'id':ad,'package':p['id']})
  with self.assertRaises(AssertionError):self.action(1,'order',{'id':ad,'package':p['id'],'test':True})
  ad=self.listing(3);o=self.action(3,'order',{'id':ad,'package':p['id'],'test':True});self.pay(o['id'],actor=3);self.assertEqual(self.action(3,'orders')[0]['status'],'paid');self.assertFalse(self.action(3,'settings')['payments_verified']);self.sql("select tg_market_refund(3,'"+o['id']+"','claim')",'service_role');self.sql("select tg_market_refund(3,'"+o['id']+"','done')",'service_role');self.assertTrue(self.action(3,'settings')['payments_verified']);self.action(3,'purchases_save',{'enabled':True})
 def channel(self):self.action(3,'channel_save',{'channel':'@synthetic_channel','title':'Synthetic channel','auto':True})
 def test_settings_channel_needs_approval_and_edit_invalidates_it(self):
  self.channel();ad=self.listing()
  with self.assertRaises(AssertionError):self.action(3,'publication_queue',{'id':ad,'key':str(uuid.uuid4())})
  queued=self.action(3,'admin_listing_approve',{'id':ad});self.assertEqual(queued['state'],'queued');self.listing(id=ad,title='Changed synthetic listing');
  with self.assertRaises(AssertionError):self.action(3,'publication_claim',{'id':queued['id']})
 def test_settings_publication_retries_and_explicit_repost_are_distinct(self):
  self.channel();ad=self.listing();queued=self.action(3,'admin_listing_approve',{'id':ad});again=self.action(3,'admin_listing_approve',{'id':ad});self.assertEqual(queued['id'],again['id']);self.assertTrue(self.action(3,'publication_claim',{'id':queued['id']})['dispatch']);self.assertFalse(self.action(3,'publication_claim',{'id':queued['id']})['dispatch']);self.action(3,'publication_finish',{'id':queued['id'],'state':'review'});self.assertEqual(self.action(3,'publication_queue',{'id':ad,'key':str(uuid.uuid4()),'repost':True})['id'],queued['id']);self.action(3,'publication_resolve',{'id':queued['id'],'resolution':'not_sent','confirmed':True});self.sql("update tg_market_publications set created_at=now()-interval '10 minutes'");new=self.action(3,'publication_queue',{'id':ad,'key':str(uuid.uuid4()),'repost':True});self.assertNotEqual(new['id'],queued['id'])
 def test_settings_hidden_sold_and_reported_never_publish(self):
  self.channel()
  for status in ['hidden','sold']:
   ad=self.listing();self.action(3,'admin_listing',{'id':ad,'status':status}) if status=='hidden' else self.action(1,'status',{'id':ad,'status':status})
   with self.assertRaises(AssertionError):self.action(3,'admin_listing_approve',{'id':ad})
  ad=self.listing();self.action(2,'report',{'id':ad,'reason':'Synthetic reason'})
  with self.assertRaises(AssertionError):self.action(3,'admin_listing_approve',{'id':ad})
 def test_settings_official_messages_and_target_listing_link(self):
  ad=self.listing(3);t=self.action(1,'thread',{'id':ad});self.action(3,'send',{'id':t['id'],'body':'Official reply'});m=self.action(1,'messages',{'id':t['id']})[0];self.assertEqual(m['author']['name'],'مدير وسيط');self.assertTrue(m['author']['verified_internal']);self.action(1,'send',{'id':t['id'],'body':'Normal reply','verified_internal':True});self.assertFalse(self.action(1,'messages',{'id':t['id']})[-1]['author']['verified_internal']);self.assertEqual(json.loads(self.sql("select tg_market_listing('"+ad+"')",'service_role'))['id'],ad);self.action(3,'admin_listing',{'id':ad,'status':'hidden'});self.assertEqual(self.sql("select tg_market_listing('"+ad+"')",'service_role'),'')
 def test_settings_checkout_reservation_is_atomic_and_cannot_be_self_released(self):
  from concurrent.futures import ThreadPoolExecutor
  self.live();p=self.package();ad=self.listing();o=self.action(1,'order',{'id':ad,'package':p['id']})
  def reserve(key):
   try:self.sql("select tg_market_checkout(1,'"+o['id']+"',50,'XTR','"+key+"')",'service_role');return True
   except AssertionError:return False
  with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(reserve,['checkout-a','checkout-b']))
  self.assertEqual(sum(results),1)
  with self.assertRaises(AssertionError):self.action(1,'checkout_release',{'id':o['id'],'confirmed':True})
  with self.assertRaises(AssertionError):self.action(3,'checkout_release',{'id':o['id'],'confirmed':True})
  self.sql("update tg_market_orders set checkout_reserved_at=now()-interval '20 minutes' where id='"+o['id']+"'");self.action(3,'checkout_release',{'id':o['id'],'confirmed':True});self.assertTrue(reserve('checkout-c'))
 def test_settings_old_order_resume_and_ranking_use_stored_snapshot(self):
  self.live();fast=self.package(priority=1);slow=self.package(priority=99);a=self.listing();b=self.listing(2);oa=self.action(1,'order',{'id':a,'package':fast['id']});ob=self.action(2,'order',{'id':b,'package':slow['id']});self.package(id=fast['id'],version=fast['version'],stars=90,days=30,priority=999)
  old=self.action(1,'order_resume',{'id':oa['id']});self.assertEqual(old['stars'],50);self.assertEqual(old['duration_days'],7)
  with self.assertRaises(AssertionError):self.action(2,'order_resume',{'id':oa['id']})
  self.pay(oa['id'],charge='fast');self.pay(ob['id'],actor=2,charge='slow');feed=json.loads(self.sql('select tg_market_public()','service_role'));self.assertEqual(feed[0]['id'],a)
 def test_settings_rep_privacy_and_approval_are_preserved(self):
  self.approve_rep(1);self.approve_rep(2);u=self.action(1,'me')['id'];self.action(3,'admin_sale',{'rep':u,'reference':'ISOLATED-SALE','sale':10000,'commission':1000});self.assertEqual(len(self.action(1,'rep')['sales']),1);self.assertEqual(self.action(2,'rep')['sales'],[])
if __name__=='__main__':
 suite=unittest.TestSuite(SettingsTests(name) for name in SettingsTests.__dict__ if name.startswith('test_settings_'));result=unittest.TextTestRunner(verbosity=2).run(suite);raise SystemExit(not result.wasSuccessful())
