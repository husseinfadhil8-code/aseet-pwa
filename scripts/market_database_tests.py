"""Actual PostgreSQL RLS/ledger regression; disposable synthetic DB, no hosted access.
Uses docker exec only; --network none, no published ports or source credentials.
"""
from pathlib import Path
import os, subprocess, time, unittest, uuid
from concurrent.futures import ThreadPoolExecutor
ROOT=Path(__file__).resolve().parents[1]
DOCKER=['docker','--host=unix:///var/run/docker.sock']
ENV={k:v for k,v in os.environ.items() if k not in ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']}
SELLER='00000000-0000-0000-0000-000000000001'; BUYER='00000000-0000-0000-0000-000000000002'; ADMIN='00000000-0000-0000-0000-000000000003'; OTHER='00000000-0000-0000-0000-000000000004'
class MarketDatabaseTests(unittest.TestCase):
 @classmethod
 def sql(cls,query,actor=None,role=None,ok=True):
  prefix=''
  if role or actor:prefix=f"set role {role or 'authenticated'}; set request.jwt.claim.sub='{actor or ''}';\n"
  p=subprocess.run(DOCKER+['exec','-i',cls.container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres'],input=prefix+query,text=True,capture_output=True,env=ENV,timeout=20)
  if ok and p.returncode:raise AssertionError(p.stderr)
  if not ok and not p.returncode:raise AssertionError('Unexpected SQL permission/transition allowed')
  return p.stdout.strip()
 @classmethod
 def setUpClass(cls):
  cls.container='waseet-market-test-'+uuid.uuid4().hex[:12]
  subprocess.run(DOCKER+['run','--rm','--detach','--network','none','--name',cls.container,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb'],check=True,capture_output=True,env=ENV,timeout=60)
  cls.addClassCleanup(lambda:subprocess.run(DOCKER+['stop','--time','2',cls.container],capture_output=True,env=ENV,timeout=15))
  for _ in range(40):
   logs=subprocess.run(DOCKER+['logs',cls.container],capture_output=True,text=True,env=ENV)
   if 'init process complete' in logs.stdout+logs.stderr and subprocess.run(DOCKER+['exec',cls.container,'pg_isready','-U','postgres'],capture_output=True,env=ENV).returncode==0:break
   time.sleep(.25)
  else:raise RuntimeError('Isolated PostgreSQL did not start within 10 seconds')
  cls.sql("""
   create role anon;create role authenticated;
   create schema auth;create schema storage;
   create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
   grant usage on schema public,auth,storage to anon,authenticated;
   grant execute on function auth.uid() to anon,authenticated;
   create table public.profiles(id uuid primary key,role text,status text);
   alter table public.profiles enable row level security;
   grant select on public.profiles to authenticated;
   create policy self on public.profiles for select using(id=auth.uid());
   create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
   alter table storage.objects enable row level security;
   grant select,insert,delete on storage.objects to anon,authenticated;
   create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
  """)
  for name in ['phase1','chat-phase1','engagement-phase1','promotion-phase1']:
   cls.sql((ROOT/'supabase'/('public-market-'+name+'.sql')).read_text())
  for uid in [SELLER,BUYER,ADMIN,OTHER]:
   cls.sql(f"insert into auth.users values('{uid}');insert into market_members(user_id,display_name) values('{uid}','Test member');")
  cls.sql(f"insert into profiles values('{ADMIN}','admin','approved'),('{SELLER}','rep','pending');update market_payment_settings set enabled=true,qr_url='https://example.invalid/merchant.png',merchant_name='Synthetic merchant';")
 def setUp(self):
  self.sql('truncate market_listings cascade')
 def listing(self,owner=SELLER):
  return self.sql(f"insert into market_listings(seller_id,title,category,area,price) values('{owner}','Synthetic listing','أثاث','بغداد',5000) returning id",owner)
 def order(self,listing):return self.sql(f"select market_request_promotion('{listing}')",SELLER)
 def review(self,order,action,reference='txn'):
  return self.sql(f"select market_review_promotion('{order}','{action}','{reference}')",ADMIN)
 def test_01_anonymous_can_only_read_active(self):
  l=self.listing();self.sql(f"update market_listings set status='hidden' where id='{l}'",ADMIN)
  self.assertEqual(self.sql(f"select count(*) from market_browse where id='{l}'",role='anon'),'0')
  self.sql('select * from market_promotions',role='anon',ok=False)
  self.sql('select * from profiles',role='anon',ok=False)
 def test_02_other_account_cannot_edit_or_read_threads(self):
  l=self.listing();self.assertEqual(self.sql(f"with x as(update market_listings set title='Intruder change' where id='{l}' returning id) select count(*) from x",BUYER),'0')
  t=self.sql(f"insert into market_threads(listing_id,buyer_id,seller_id) values('{l}','{BUYER}','{SELLER}') returning id",BUYER)
  self.assertEqual(self.sql(f"select count(*) from market_threads where id='{t}'",OTHER),'0')
  self.sql(f"insert into market_messages(thread_id,sender_id,body) values('{t}','{OTHER}','Denied')",OTHER,ok=False)
  self.sql(f"insert into market_messages(thread_id,sender_id,body) values('{t}','{BUYER}','Allowed')",BUYER)
 def test_03_forged_seller_and_moderation(self):
  l=self.listing()
  self.sql(f"insert into market_threads(listing_id,buyer_id,seller_id) values('{l}','{BUYER}','{OTHER}')",BUYER,ok=False)
  self.sql(f"update market_listings set seller_id='{BUYER}' where id='{l}'",SELLER,ok=False)
  self.sql(f"update market_listings set status='hidden' where id='{l}'",ADMIN)
  self.sql(f"update market_listings set status='active' where id='{l}'",SELLER,ok=False)
  self.sql(f"delete from market_listings where id='{l}'",SELLER,ok=False)
 def test_04_client_cannot_forge_payment(self):
  l=self.listing();o=self.order(l)
  self.sql(f"update market_promotions set status='active' where id='{o}'",SELLER,ok=False)
  self.sql(f"insert into market_promotions(listing_id,buyer_id) values('{l}','{SELLER}')",SELLER,ok=False)
  self.sql(f"select market_review_promotion('{o}','confirm','forged')",SELLER,ok=False)
  self.sql(f"select market_submit_payment('{o}')",BUYER)
  self.assertEqual(self.sql(f"select status from market_promotions where id='{o}'",SELLER),'awaiting_payment')
 def test_05_concurrent_requests_and_activation_are_idempotent(self):
  l=self.listing()
  with ThreadPoolExecutor(max_workers=2) as pool:orders=list(pool.map(lambda _:self.order(l),range(2)))
  self.assertEqual(orders[0],orders[1]);o=orders[0]
  self.sql(f"select market_submit_payment('{o}')",SELLER)
  self.review(o,'confirm','unique-'+o)
  with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(lambda _:self.review(o,'activate'),range(2)))
  self.assertEqual(self.sql(f"select count(*) from market_promotion_events where promotion_id='{o}' and action='activate'"),'1')
  self.assertEqual(self.sql(f"select ends_at=starts_at+interval '7 days' from market_promotions where id='{o}'"),'t')
  self.assertEqual(self.sql(f"select is_promoted from market_browse where id='{l}'",role='anon'),'t')
 def test_06_transaction_reference_cannot_pay_twice(self):
  a=self.order(self.listing());b=self.order(self.listing())
  for o in [a,b]:self.sql(f"select market_submit_payment('{o}')",SELLER)
  self.review(a,'confirm','merchant-reference-six');self.sql(f"select market_review_promotion('{b}','confirm','merchant-reference-six')",ADMIN,ok=False)
 def test_07_hidden_or_reported_listing_cannot_activate(self):
  l=self.listing();o=self.order(l);self.sql(f"select market_submit_payment('{o}')",SELLER);self.review(o,'confirm','unique-'+o)
  self.sql(f"insert into market_reports(listing_id,reporter_id,reason) values('{l}','{BUYER}','scam')",BUYER)
  self.sql(f"select market_review_promotion('{o}','activate')",ADMIN,ok=False)
  self.sql(f"update market_reports set status='reviewed' where listing_id='{l}'",ADMIN)
  self.sql(f"update market_listings set status='hidden' where id='{l}'",ADMIN)
  self.sql(f"select market_review_promotion('{o}','activate')",ADMIN,ok=False)
 def test_08_expired_projection_and_no_private_payment_fields(self):
  l=self.listing();o=self.order(l);self.sql(f"select market_submit_payment('{o}')",SELLER);self.review(o,'confirm','unique-'+o);self.review(o,'activate')
  self.sql(f"update market_promotions set starts_at=now()-interval '8 days',ends_at=now()-interval '1 day' where id='{o}'")
  self.assertEqual(self.sql(f"select is_promoted from market_browse where id='{l}'",role='anon'),'f')
  self.sql('select provider_transaction_id from market_browse',role='anon',ok=False)
 def test_09_storage_is_owner_scoped(self):
  self.sql(f"insert into storage.objects(bucket_id,name) values('market-listing-images','{SELLER}/photo.jpg')",SELLER)
  self.sql(f"insert into storage.objects(bucket_id,name) values('market-listing-images','{SELLER}/forged.jpg')",BUYER,ok=False)
  self.assertEqual(self.sql(f"with x as(delete from storage.objects where name='{SELLER}/photo.jpg' returning id) select count(*) from x",BUYER),'0')
 def test_10_suspended_account_cannot_publish_or_promote(self):
  # Dedicated member avoids changing the shared seller fixture.
  l=self.listing(OTHER)
  self.sql(f"select market_suspend_member('{OTHER}',true)",ADMIN)
  self.assertEqual(self.sql(f"select status from market_listings where id='{l}'",OTHER),'hidden')
  self.sql(f"insert into market_listings(seller_id,title,category,area,price) values('{OTHER}','Blocked listing','أثاث','بغداد',5)",OTHER,ok=False)
  self.sql(f"update market_members set suspended=false where user_id='{OTHER}'",OTHER,ok=False)
  self.sql(f"select market_suspend_member('{OTHER}',false)",ADMIN)
  self.assertEqual(self.sql(f"select status from market_listings where id='{l}'",OTHER),'hidden')
 def test_11_payment_settings_admin_only(self):
  self.sql("update market_payment_settings set enabled=false",SELLER)
  self.assertEqual(self.sql('select enabled from market_payment_settings',role='anon'),'t')
  self.sql('select * from market_promotion_events',role='anon',ok=False)
  self.assertEqual(self.sql('select count(*) from market_promotion_events',BUYER),'0')
 def test_12_direct_timestamp_or_id_reassignment_denied(self):
  l=self.listing()
  self.sql(f"update market_listings set created_at=now()+interval '1 year' where id='{l}'",SELLER,ok=False)
  self.sql(f"update market_listings set id=gen_random_uuid() where id='{l}'",SELLER,ok=False)
 def test_13_pending_or_rejected_order_is_never_sponsored(self):
  l=self.listing();o=self.order(l)
  self.assertEqual(self.sql(f"select is_promoted from market_browse where id='{l}'",role='anon'),'f')
  self.sql(f"select market_review_promotion('{o}','activate')",ADMIN,ok=False)
  self.review(o,'reject')
  self.sql(f"select market_submit_payment('{o}')",SELLER)
  self.assertEqual(self.sql(f"select status from market_promotions where id='{o}'",SELLER),'rejected')
 def test_14_other_customer_cannot_read_financial_record(self):
  o=self.order(self.listing())
  self.assertEqual(self.sql(f"select count(*) from market_promotions where id='{o}'",BUYER),'0')
 def test_15_anonymous_cannot_call_payment_mutations(self):
  self.sql("select market_request_promotion(gen_random_uuid())",role='anon',ok=False)
  self.sql("select market_review_promotion(gen_random_uuid(),'confirm','bad')",role='anon',ok=False)
 def test_16_removing_promoted_listing_preserves_payment_and_hides_ad(self):
  l=self.listing();o=self.order(l);self.sql(f"select market_submit_payment('{o}')",SELLER);self.review(o,'confirm','unique-'+o);self.review(o,'activate')
  self.sql(f"select market_delete_listing('{l}')",BUYER,ok=False)
  self.sql(f"select market_delete_listing('{l}')",SELLER)
  self.assertEqual(self.sql(f"select count(*) from market_browse where id='{l}'",role='anon'),'0')
  self.assertEqual(self.sql(f"select status from market_promotions where id='{o}'",SELLER),'active')
  self.sql(f"update market_listings set status='active' where id='{l}'",SELLER,ok=False)
 def test_17_admin_can_restore_reviewed_hidden_listing(self):
  l=self.listing();self.sql(f"update market_listings set status='hidden' where id='{l}'",ADMIN)
  self.sql(f"update market_listings set status='active' where id='{l}'",ADMIN)
  self.assertEqual(self.sql(f"select status from market_browse where id='{l}'",role='anon'),'active')
 def test_18_listing_quota_and_unforgeable_timestamps(self):
  for _ in range(10):self.listing()
  self.sql(f"insert into market_listings(seller_id,title,category,area,price) values('{SELLER}','Spam listing','أثاث','بغداد',1)",SELLER,ok=False)
  self.sql(f"insert into market_listings(seller_id,title,category,area,price,created_at) values('{SELLER}','Backdated spam','أثاث','بغداد',1,now()-interval '1 year')",SELLER,ok=False)
 def test_19_more_than_five_photos_denied_at_rest_layer(self):
  self.sql(f"insert into market_listings(seller_id,title,category,area,price,image_urls) values('{SELLER}','Too many images','أثاث','بغداد',1,array_fill('https://example.invalid/photo.jpg'::text,array[6]))",SELLER,ok=False)
if __name__=='__main__':unittest.main(verbosity=2)
