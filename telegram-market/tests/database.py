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
  cls.sql('create role anon;create role authenticated;create role service_role;grant usage on schema public to anon,authenticated,service_role;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);')
  cls.sql((ROOT/'db/001_telegram_market.sql').read_text())
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
  self.assertEqual(self.sql("select count(*) from pg_class where relname like 'tg_market_%' and relkind='r' and relrowsecurity"),'11')
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
  user=self.action(1,'me')['id'];self.action(3,'admin_user',{'id':user,'role':'rep','banned':False})
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
if __name__=='__main__':unittest.main(verbosity=2)
