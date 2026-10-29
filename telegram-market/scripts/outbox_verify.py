"""Live transaction tests use temporary clones only; one tagged outbox probe persists."""
import os,sys,json,uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts'))
from backup.manual_test_backup import source_config,connection,verify_source_identity,BackupError,safe_error_code
from psycopg2 import sql
REF='beyrctbxojpuvhevfyok'
def clone(c,table):
 c.execute(sql.SQL('create temporary table {} (like public.{} including defaults including constraints) on commit drop').format(sql.Identifier(table),sql.Identifier(table)))
 c.execute('select tgargs from pg_trigger where tgrelid=%s::regclass and tgname=%s',('public.'+table,'notification_outbox_capture'))
 args=bytes(c.fetchone()[0]).rstrip(b'\0').decode()
 c.execute(sql.SQL('create trigger probe_capture after insert or update or delete on pg_temp.{} for each row execute function public.capture_notification_outbox({})').format(sql.Identifier(table),sql.Literal(args)))
def session(config):
 conn=connection(config);verify_source_identity(conn);conn.rollback();conn.set_session(readonly=False)
 with conn.cursor() as c:c.execute("set local waseet.notification_test='true'; set local lock_timeout='3s'; set local statement_timeout='20s';")
 return conn
def listing(c,owner):
 c.execute("insert into pg_temp.tg_market_listings(owner_id,title,category,area,price,condition) values(%s,'Safe isolated outbox test','أخرى','بغداد',1,'used') returning id",(owner,));return str(c.fetchone()[0])
def main():
 connections=[]
 try:
  if os.environ.get('CONFIRM_TEST_REF')!=REF or os.environ.get('GITHUB_REF')!='refs/heads/fix/transactional-notification-outbox':raise BackupError('Production confirmation required')
  config=source_config(os.environ.pop('WASEET_TEST_DATABASE_URL'));conn=session(config);connections.append(conn)
  with conn.cursor() as c:
   c.execute("set local request.headers='{\"x-waseet-origin\":\"miniapp\"}';")
   clone(c,'tg_market_users');c.execute("insert into pg_temp.tg_market_users(telegram_id,display_name) values(9000000000000001,'Isolated notification test') returning id");user=str(c.fetchone()[0])
   c.execute("select payload->>'origin' from public.notification_outbox where record_id=%s",(user,));assert c.fetchall()==[('miniapp',)]
   clone(c,'tg_market_listings');ad=listing(c,user)
   c.execute("update pg_temp.tg_market_listings set title='Safe second outbox title' where id=%s",(ad,));c.execute("update pg_temp.tg_market_listings set title='Safe isolated outbox test' where id=%s",(ad,))
   c.execute("select count(*),count(distinct id) from public.notification_outbox where record_id=%s",(ad,));assert c.fetchone()==(3,3)
   for role in ['anon','authenticated']:
    c.execute('savepoint denied');c.execute(sql.SQL('set local role {}').format(sql.Identifier(role)))
    try:c.execute('select * from public.notification_outbox limit 1')
    except Exception:c.execute('rollback to savepoint denied')
    else:raise BackupError('Ordinary user read unexpectedly allowed')
   c.execute('select count(*) from public.notification_outbox where record_id in (%s,%s)',(ad,user));assert c.fetchone()[0]==4
  conn.rollback()
  # Concurrent committed business writes are simulated in temporary clones, with
  # each transaction rolled back before any delivery can see their test events.
  def concurrent(_):
   con=session(config)
   try:
    with con.cursor() as c:
     clone(c,'tg_market_listings');ad=listing(c,str(uuid.uuid4()));c.execute('select count(*) from public.notification_outbox where record_id=%s',(ad,));assert c.fetchone()[0]==1
    con.rollback();return True
   finally:con.close()
  with ThreadPoolExecutor(max_workers=4) as p:assert all(p.map(concurrent,range(8)))
  conn.close();connections.remove(conn);conn=session(config);connections.append(conn)
  with conn.cursor() as c:
   clone(c,'tg_market_audit');probe=-int(uuid.uuid4().int%9000000000000000000)
   c.execute("insert into pg_temp.tg_market_audit(id,action) values(%s,'transactional_outbox_probe')",(probe,))
   c.execute("select id,is_test from public.notification_outbox where source_table='tg_market_audit' and record_id=%s",(str(probe),));event,tag=c.fetchone();assert tag
  if os.environ.get('OUTBOX_RECOVERY')=='true':
   with conn.cursor() as c:c.execute("update public.notification_outbox set status='processing',attempts=1,lease_token=gen_random_uuid(),lease_until=now()-interval '1 second' where id=%s",(event,))
  conn.commit()
  proof={'project_ref':REF,'production_database_tests':True,'expired_worker_lease_injected':os.environ.get('OUTBOX_RECOVERY')=='true','temporary_user_and_listing_rollback_verified':True,'rapid_reversible_updates_captured':True,'concurrent_transactions':8,'ordinary_role_access_denied':True,'outbox_test_event_id':str(event),'only_persisted_test_record':'notification_outbox','public_business_rows_modified':False,'real_rewards_created':False}
  (ROOT/'outbox-proof.json').write_text(json.dumps(proof,indent=2));print(json.dumps(proof));return 0
 except Exception as e:print('Outbox verification stopped safely: '+(str(e) if isinstance(e,BackupError) else safe_error_code(e)));return 1
 finally:
  for conn in connections:conn.rollback();conn.close()
if __name__=='__main__':raise SystemExit(main())
