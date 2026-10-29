"""Isolated PostgreSQL tests. No production credentials or business data."""
import unittest,subprocess,os,time,uuid,json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
ROOT=Path(__file__).resolve().parents[1]
D=['docker','--host=unix:///var/run/docker.sock'];ENV={k:v for k,v in os.environ.items() if k not in ('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH')}
class Outbox(unittest.TestCase):
 @classmethod
 def sql(c,s,deny=False):
  p=subprocess.run(D+['exec','-i',c.name,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres'],input=s,text=True,capture_output=True,env=ENV,timeout=20)
  if deny:
   assert p.returncode!=0;return
  if p.returncode:raise AssertionError(p.stderr)
  return p.stdout.strip()
 @classmethod
 def setUpClass(c):
  c.name='outbox-'+uuid.uuid4().hex[:12]
  subprocess.run(D+['info'],check=True,capture_output=True,env=ENV)
  subprocess.run(D+['run','--rm','-d','--network','none','--name',c.name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb'],check=True,capture_output=True,env=ENV)
  c.addClassCleanup(lambda:subprocess.run(D+['stop','-t','1',c.name],capture_output=True,env=ENV))
  for _ in range(40):
   logs=subprocess.run(D+['logs',c.name],capture_output=True,text=True,env=ENV)
   if 'init process complete' in logs.stdout+logs.stderr and subprocess.run(D+['exec',c.name,'pg_isready','-U','postgres'],capture_output=True,env=ENV).returncode==0:break
   time.sleep(.25)
  c.sql('create role anon;create role authenticated;create role service_role;grant usage on schema public to anon,authenticated,service_role;')
  # Review-catalog-shaped fixture; business behavior regression is tested separately.
  import re
  migration=(ROOT/'db/011_notification_outbox.sql').read_text()
  for table,columns in re.findall(r"\('([a-z_]+)','((?:id|singleton),[^']+)'\)",migration):
   types={'id':'uuid primary key default gen_random_uuid()','price':'numeric','images':'uuid[]','telegram_id':'bigint','banned':'boolean','approved_at':'timestamptz','created_at':'timestamptz default now()','updated_at':'timestamptz default now()'}
   c.sql('create table tg_market_'+table+'('+','.join(col+' '+types.get(col,'text') for col in columns.split(','))+');')
  c.sql("insert into tg_market_users(display_name) values('preexisting');")
  c.sql(migration)
 def setUp(self):self.sql('truncate notification_outbox;truncate tg_market_listings;')
 def test_no_historical_backfill(self):self.assertEqual(self.sql('select count(*) from notification_outbox'),'0')
 def test_atomic_rollback_and_rapid_changes(self):
  self.sql("begin;insert into tg_market_listings(title) values('rolled back');rollback;")
  self.assertEqual(self.sql('select count(*) from notification_outbox'),'0')
  self.sql("insert into tg_market_listings(title) values('a');update tg_market_listings set title='b';update tg_market_listings set title='a';delete from tg_market_listings;")
  self.assertEqual(self.sql('select count(distinct id) from notification_outbox'),'4')
  self.assertEqual(self.sql("select string_agg(event_type,',' order by occurred_at) from notification_outbox"),'insert,update,update,delete')
 def test_concurrent_writes_and_disjoint_claims(self):
  with ThreadPoolExecutor(max_workers=8) as p:list(p.map(lambda n:self.sql(f"insert into tg_market_listings(title) values('synthetic {n}');"),range(40)))
  def claim(_):return json.loads(self.sql('set role service_role;select coalesce(json_agg(x),\'[]\') from notification_outbox_claim(10) x'))
  with ThreadPoolExecutor(max_workers=4) as p:groups=list(p.map(claim,range(4)))
  ids=[x['id'] for g in groups for x in g];self.assertEqual(len(ids),40);self.assertEqual(len(set(ids)),40)
 def test_lease_recovery_and_stale_ack(self):
  self.sql("insert into tg_market_listings(title) values('recover');")
  a=json.loads(self.sql('select row_to_json(x) from notification_outbox_claim(1) x'))
  self.sql("update notification_outbox set lease_until=now()-interval '1 second';")
  b=json.loads(self.sql('select row_to_json(x) from notification_outbox_claim(1) x'))
  self.assertNotEqual(a['lease_token'],b['lease_token']);self.assertEqual(b['attempts'],2)
  self.assertEqual(self.sql(f"select notification_outbox_bridge_ack('{a['id']}','{a['lease_token']}')"),'f')
  self.assertEqual(self.sql(f"select notification_outbox_bridge_ack('{b['id']}','{b['lease_token']}')"),'t')
  self.assertEqual(self.sql(f"select notification_outbox_delivery('{b['id']}','sent',1,'[99]')"),'t')
  self.assertEqual(self.sql('select status from notification_outbox'),'sent')
 def test_failure_retained_and_backoff(self):
  self.sql("insert into tg_market_listings(title) values('retry');")
  a=json.loads(self.sql('select row_to_json(x) from notification_outbox_claim(1) x'))
  self.sql(f"select notification_outbox_bridge_ack('{a['id']}','{a['lease_token']}','failure');")
  self.assertEqual(self.sql("select status='retry' and next_attempt_at>now() and last_error='outbox_bridge_failed' from notification_outbox"),'t')
 def test_rls_and_rpc_permissions(self):
  for r in ['anon','authenticated']:
   for q in ['select * from notification_outbox',"insert into notification_outbox(event_type,source_table,record_id,payload) values('fake','x','x','{}')",'select * from notification_outbox_claim(1)',"select notification_outbox_health()"]:self.sql(f'set role {r};'+q,deny=True)
  self.assertEqual(self.sql("select relrowsecurity and relforcerowsecurity from pg_class where relname='notification_outbox'"),'t')
 def test_capture_failure_aborts_business_write(self):
  self.sql("alter table notification_outbox add constraint synthetic_failure check(event_type!='insert');")
  try:
   self.sql("insert into tg_market_listings(title) values('must fail');",deny=True)
   self.assertEqual(self.sql('select count(*) from tg_market_listings'),'0')
  finally:self.sql('alter table notification_outbox drop constraint synthetic_failure;')
if __name__=='__main__':unittest.main(verbosity=2)
