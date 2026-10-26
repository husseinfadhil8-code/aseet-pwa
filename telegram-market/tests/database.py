"""Actual isolated PostgreSQL17 tests; no network, hosted credentials or real money."""
import unittest,subprocess,os,time,uuid,json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
ROOT=Path(__file__).resolve().parents[1]
D=['docker','--host=unix:///var/run/docker.sock'];ENV={k:v for k,v in os.environ.items() if k not in ('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH')}
class DatabaseTests(unittest.TestCase):
 @classmethod
 def sql(cls,sql,role=None,deny=False):
  p=subprocess.run(D+['exec','-i',cls.container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres'],input=(f'SET ROLE {role};' if role else '')+sql,text=True,capture_output=True,env=ENV,timeout=20)
  if deny:
   if p.returncode==0:raise AssertionError('Unexpected permission/transition allowed')
   return
  if p.returncode:raise AssertionError(p.stderr)
  return p.stdout.strip()
 @classmethod
 def action(cls,actor,action,data=None,admin=False):
  payload=json.dumps(data or {},ensure_ascii=False).replace("'","''")
  return json.loads(cls.sql(f"select tg_market_action({actor},'{action}','{payload}',{str(admin).lower()},'Synthetic user')",'service_role'))
 @classmethod
 def setUpClass(cls):
  cls.container='waseet-tg-'+uuid.uuid4().hex[:12]
  subprocess.run(D+['run','--rm','-d','--network','none','--name',cls.container,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb'],check=True,capture_output=True,env=ENV,timeout=60)
  cls.addClassCleanup(lambda:subprocess.run(D+['stop','-t','2',cls.container],capture_output=True,env=ENV,timeout=15))
  for _ in range(40):
   p=subprocess.run(D+['logs',cls.container],capture_output=True,text=True,env=ENV)
   if 'init process complete' in p.stdout+p.stderr and subprocess.run(D+['exec',cls.container,'pg_isready','-U','postgres'],capture_output=True,env=ENV).returncode==0:break
   time.sleep(.25)
  else:raise RuntimeError('PostgreSQL startup exceeded10 seconds')
  cls.sql('create role anon;create role authenticated;create role service_role;grant usage on schema public to anon,authenticated,service_role;create schema storage;grant usage on schema storage to anon,authenticated;create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;grant select,insert on storage.objects to authenticated;create policy legacy_open on storage.objects for all to authenticated using(true) with check(true);create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);')
  cls.sql((ROOT/'db/001_telegram_market.sql').read_text());cls.sql((ROOT/'db/002_rep_academy.sql').read_text())
 def setUp(self):
  self.sql('truncate tg_market_users cascade');self.action(1,'me');self.action(2,'me');self.action(3,'me',admin=True)
 def listing(self,actor=1,**extra):
  return self.action(actor,'save',{'title':'Synthetic listing','description':'For isolated tests','category':'أثاث','area':'بغداد','price':5000,'condition':'used','images':[],**extra})['id']
 def order(self,l=None,actor=1):return self.action(actor,'order',{'id':l or self.listing(actor),'stars':50})['id']
 def pay(self,o,actor=1,stars=50,currency='XTR',charge='test-charge'):
  return json.loads(self.sql(f"select tg_market_payment({actor},'{o}',{stars},'{currency}',"+('null' if charge is None else "'"+charge+"'")+")",'service_role'))
 def test_01_anonymous_cannot_impersonate_or_read_private_tables(self):
  for role in ['anon','authenticated']:
   self.sql("select tg_market_action(3,'admin','{}',true,'forged')",role,deny=True)
   for table in ['users','messages','orders','rep_sales']:self.sql('select * from tg_market_'+table,role,deny=True)
 def test_02_all_isolated_tables_have_rls(self):
  self.assertEqual(self.sql("select count(*) from pg_class where relname like 'tg_market_%' and relkind='r' and relrowsecurity"),'17')
 def test_03_public_hides_hidden_and_banned_owner(self):
  l=self.listing();self.action(3,'admin_listing',{'id':l,'status':'hidden'})
  self.assertEqual(json.loads(self.sql('select tg_market_public()','service_role')),[])
 def test_04_customer_cannot_use_admin_or_rep(self):
  for action in ['admin','rep','admin_user','admin_sale','admin_listing']:
   with self.assertRaises(AssertionError):self.action(1,action,{'id':str(uuid.uuid4()),'role':'admin'})
 def test_05_foreign_listing_cannot_be_edited_or_removed(self):
  l=self.listing()
  with self.assertRaises(AssertionError):self.listing(2,id=l)
  with self.assertRaises(AssertionError):self.action(2,'status',{'id':l,'status':'deleted'})
 def test_06_seller_cannot_restore_moderated_listing(self):
  l=self.listing();self.action(3,'admin_listing',{'id':l,'status':'hidden'})
  with self.assertRaises(AssertionError):self.action(1,'status',{'id':l,'status':'active'})
 def test_07_photos_are_owned_and_max_five(self):
  image=self.action(1,'image_intent',{'mime':'image/jpeg'});self.action(1,'image_ready',{'id':image['id']})
  with self.assertRaises(AssertionError):self.listing(2,images=[image['id']])
  with self.assertRaises(AssertionError):self.listing(images=[image['id']]*6)
  self.listing(images=[image['id']])
 def test_08_private_media_stops_when_ad_hidden(self):
  im=self.action(1,'image_intent',{'mime':'image/jpeg'});self.action(1,'image_ready',{'id':im['id']});l=self.listing(images=[im['id']]);self.assertNotEqual(self.sql(f"select tg_market_media('{im['id']}',0)",'service_role'),'')
  self.action(3,'admin_listing',{'id':l,'status':'hidden'});self.assertEqual(self.sql(f"select tg_market_media('{im['id']}',0)",'service_role'),'')
  self.assertNotEqual(self.sql(f"select tg_market_media('{im['id']}',1)",'service_role'),'')
 def test_09_messages_only_participants(self):
  l=self.listing();t=self.action(2,'thread',{'id':l})['id'];self.action(2,'send',{'id':t,'body':'Synthetic message'})
  with self.assertRaises(AssertionError):self.action(3,'messages',{'id':t})
  self.assertEqual(len(self.action(1,'messages',{'id':t})),1)
 def test_10_hidden_listing_blocks_new_message(self):
  l=self.listing();t=self.action(2,'thread',{'id':l})['id'];self.action(3,'admin_listing',{'id':l,'status':'hidden'})
  with self.assertRaises(AssertionError):self.action(2,'send',{'id':t,'body':'Denied'})
 def test_11_invoice_request_does_not_activate(self):
  l=self.listing();o=self.order(l);self.assertEqual(self.action(1,'orders')[0]['status'],'pending');self.assertFalse(json.loads(self.sql('select tg_market_public()','service_role'))[0]['sponsored'])
  self.assertTrue(self.pay(o,charge=None)['approved']);self.assertEqual(self.action(1,'orders')[0]['status'],'pending')
 def test_12_wrong_actor_currency_amount_denied(self):
  o=self.order()
  for params in [dict(actor=2),dict(currency='USD'),dict(stars=1)]:
   with self.assertRaises(AssertionError):self.pay(o,**params)
 def test_13_payment_retry_is_idempotent_and_duration_fixed(self):
  o=self.order()
  with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(lambda _:self.pay(o),range(2)))
  self.assertEqual(self.sql("select count(*) from tg_market_audit where action='telegram_payment'"),'1')
  self.assertEqual(self.sql(f"select ends_at=starts_at+interval '7 days' from tg_market_orders where id='{o}'"),'t')
 def test_14_unique_charge_cannot_pay_two_orders(self):
  a,b=self.order(),self.order();self.pay(a)
  with self.assertRaises(AssertionError):self.pay(b)
 def test_15_hidden_during_checkout_records_money_but_never_promotes(self):
  l=self.listing();o=self.order(l);self.action(3,'admin_listing',{'id':l,'status':'hidden'});self.pay(o);self.assertEqual(self.action(1,'orders')[0]['status'],'paid')
 def test_16_refund_authority_and_uncertainty_lock(self):
  o=self.order();self.pay(o)
  self.sql(f"select tg_market_refund(1,'{o}','claim')",'service_role',deny=True)
  self.sql(f"select tg_market_refund(3,'{o}','claim')",'service_role');self.sql(f"select tg_market_refund(3,'{o}','uncertain')",'service_role')
  self.sql(f"select tg_market_refund(3,'{o}','claim')",'service_role',deny=True)
  self.assertEqual(self.action(1,'orders')[0]['status'],'refund_review')
 def test_17_commission_only_approved_rep_and_unique_reference(self):
  user=self.action(1,'me')['id'];self.approve_rep(1)
  self.action(3,'admin_sale',{'rep':user,'reference':'TEST-SALE','sale':10000,'commission':1000});self.assertEqual(self.action(1,'rep')['commission_iqd'],1000)
  with self.assertRaises(AssertionError):self.action(3,'admin_sale',{'rep':user,'reference':'TEST-SALE','sale':10000,'commission':1000})
 def test_18_concurrent_order_requests_reuse_one_order(self):
  l=self.listing()
  with ThreadPoolExecutor(max_workers=2) as pool:ids=list(pool.map(lambda _:self.order(l),range(2)))
  self.assertEqual(ids[0],ids[1])
 def test_19_banned_actor_cannot_write(self):
  user=self.action(1,'me')['id'];self.action(3,'admin_user',{'id':user,'role':'market','banned':True})
  with self.assertRaises(AssertionError):self.listing()
 def test_20_no_legacy_objects_created(self):
  self.assertEqual(self.sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname not like 'tg_market_%'"),'0')
 def test_21_legacy_storage_allow_cannot_expose_new_bucket(self):
  self.sql("insert into storage.objects(bucket_id,name) values('waseet-telegram-images','private.jpg'),('legacy-bucket','unchanged.jpg')")
  self.assertEqual(self.sql("select count(*) from storage.objects where bucket_id='waseet-telegram-images'",'authenticated'),'0')
  self.assertEqual(self.sql("select count(*) from storage.objects where bucket_id='legacy-bucket'",'authenticated'),'1')
  self.sql("insert into storage.objects(bucket_id,name) values('waseet-telegram-images','forged.jpg')",'authenticated',deny=True)
 def test_22_report_does_not_remove_ad_without_review_but_pauses_promotion(self):
  l=self.listing();o=self.order(l);self.pay(o);self.action(2,'report',{'id':l,'reason':'Synthetic review request'})
  ads=json.loads(self.sql('select tg_market_public()','service_role'));self.assertEqual(len(ads),1);self.assertFalse(ads[0]['sponsored'])
 def test_23_operator_bootstrap_and_banned_payment_support(self):
  user=self.action(1,'me')['id'];self.action(3,'admin_user',{'id':user,'role':'market','banned':True});self.action(1,'support',{'body':'Synthetic payment appeal'});self.assertTrue(self.action(1,'me')['banned']);
  with self.assertRaises(AssertionError):self.action(1,'me',admin=True)
  self.assertEqual(self.action(3,'me',admin=True)['role'],'admin')
 def approve_rep(self,actor=1):
  for lesson in range(1,6):self.action(actor,'lesson',{'lesson':lesson})
  self.action(actor,'quiz',{'answers':[1]*5,'agreed':True});app=self.action(actor,'rep_apply',{'fullName':'Synthetic Rep','governorate':'بغداد','agreed':True});self.action(3,'rep_review',{'id':app['id'],'status':'approved'});return app
 def test_24_exam_cannot_be_forged_or_submitted_before_lessons(self):
  with self.assertRaises(AssertionError):self.action(1,'quiz',{'answers':[1]*5,'agreed':True,'score':5})
  with self.assertRaises(AssertionError):self.action(1,'rep_apply',{'fullName':'Forged Rep','governorate':'بغداد','agreed':True,'passed':True})
  for lesson in range(1,6):self.action(1,'lesson',{'lesson':lesson})
  t=self.action(1,'quiz',{'answers':[0]*5,'agreed':True,'score':5,'passed':True});self.assertFalse(t['passed']);self.assertEqual(t['score'],0)
  with self.assertRaises(AssertionError):self.action(1,'rep_apply',{'fullName':'Forged Rep','governorate':'بغداد','agreed':True})
 def test_25_application_requires_owner_review_and_result_is_persisted(self):
  app=self.approve_rep();self.assertEqual(self.action(1,'me')['role'],'rep');self.assertEqual(self.action(1,'rep_application')['application']['status'],'approved');self.assertEqual(self.action(1,'training')['score'],5)
  with self.assertRaises(AssertionError):self.action(2,'rep_review',{'id':app['id'],'status':'approved'})
  self.action(3,'rep_review',{'id':app['id'],'status':'rejected','reason':'Synthetic review'});self.assertEqual(self.action(1,'me')['role'],'market')
 def test_26_unique_owner_cannot_be_banned_replaced_or_client_promoted(self):
  root=self.action(3,'me')['id'];user=self.action(1,'me')['id']
  for data in [{'id':root,'role':'market','banned':True},{'id':user,'role':'admin'}]:
   with self.assertRaises(AssertionError):self.action(3,'admin_user',data)
  with self.assertRaises(AssertionError):self.action(1,'me',admin=True)
  with self.assertRaises(AssertionError):self.action(3,'admin_user',{'id':user,'role':'rep'})
  self.sql("select tg_market_action_v1(1,'admin','{}',false,'forged')",'service_role',deny=True)
 def test_27_quiz_quota_and_private_rls(self):
  for lesson in range(1,6):self.action(1,'lesson',{'lesson':lesson})
  for attempt in range(5):self.action(1,'quiz',{'answers':[1]*5,'agreed':True})
  with self.assertRaises(AssertionError):self.action(1,'quiz',{'answers':[1]*5,'agreed':True})
  for role in ['anon','authenticated']:
   for table in ['training','rep_applications','root','payouts']:self.sql('select * from tg_market_'+table,role,deny=True)
 def test_28_payout_is_owner_only_idempotent_and_reflected_in_due(self):
  self.approve_rep();rep=self.action(1,'me')['id'];self.action(3,'admin_sale',{'rep':rep,'reference':'TEST-PAYOUT','sale':10000,'commission':1000});sale=self.action(1,'rep')['sales'][0]['id']
  with self.assertRaises(AssertionError):self.action(1,'rep_payout',{'id':sale,'reference':'SELF-PAYOUT'})
  for attempt in range(2):self.action(3,'rep_payout',{'id':sale,'reference':'TEST-TRANSFER'})
  self.assertEqual(self.action(1,'rep')['paid_iqd'],1000);self.assertEqual(self.sql('select count(*) from tg_market_payouts'),'1')
 def test_29_channel_claim_blocks_unapproved_and_duplicate_dispatch(self):
  ad=self.listing()
  with self.assertRaises(AssertionError):self.action(1,'channel_claim',{'id':ad,'channel':'@synthetic'})
  self.action(3,'channel_claim',{'id':ad,'channel':'@synthetic'})
  with self.assertRaises(AssertionError):self.action(3,'channel_claim',{'id':ad,'channel':'@synthetic'})
  self.action(3,'channel_finish',{'id':ad,'state':'review'});self.assertEqual(self.action(3,'admin')['channel_posts'][0]['state'],'review')
  ad2=self.listing();self.action(2,'report',{'id':ad2,'reason':'Synthetic moderation'})
  with self.assertRaises(AssertionError):self.action(3,'channel_claim',{'id':ad2,'channel':'@synthetic'})
 def test_30_multi_day_campaign_uses_server_snapshot_and_payment_duration(self):
  for days in [1,7,14,30]:
   ad=self.listing();o=self.action(1,'order',{'id':ad,'stars':50,'days':days});self.pay(o['id'],charge='charge-'+str(days));self.assertEqual(self.sql("select ends_at=starts_at+make_interval(days=>duration_days) from tg_market_orders where id='"+o['id']+"'"),'t');self.assertEqual(self.action(1,'orders')[0]['duration_days'],days)
 def test_31_pending_campaign_cannot_switch_plan_or_price(self):
  ad=self.listing();self.action(1,'order',{'id':ad,'stars':50,'days':14})
  for data in [{'days':1,'stars':50},{'days':14,'stars':1}]:
   with self.assertRaises(AssertionError):self.action(1,'order',{'id':ad,**data})
if __name__=='__main__':unittest.main(verbosity=2)
