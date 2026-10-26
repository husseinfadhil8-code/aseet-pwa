"""Manual Test-only transactional DDL rehearsal. No user rows or production route."""
import os,sys,json,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts'))
from backup.manual_test_backup import source_config,connection,verify_source_identity,BackupError,TEST_REF,REPOSITORY,safe_error_code
from review.test_upgrade_rollback import fingerprint

def main():
 conn=None
 try:
  if os.environ.get('GITHUB_REPOSITORY')!=REPOSITORY or os.environ.get('GITHUB_EVENT_NAME')!='workflow_dispatch' or os.environ.get('GITHUB_REF')!='refs/heads/feature/telegram-market-starter' or os.environ.get('CONFIRM_TEST_REF')!=TEST_REF:raise BackupError('Manual Telegram branch / Test confirmation required')
  directory=ROOT/'telegram-market/db';sql=(directory/'001_telegram_market.sql').read_text();manifest=json.loads((directory/'manifest.json').read_text())
  if hashlib.sha256(sql.encode()).hexdigest()!=manifest['sha256']:raise BackupError('Unreviewed Telegram SQL bundle')
  from pglast import parse_sql
  if any(type(n.stmt).__name__=='TransactionStmt' for n in parse_sql(sql)):raise BackupError('Transaction control forbidden in bundle')
  conn=connection(source_config(os.environ.pop('WASEET_TEST_DATABASE_URL','')));verify_source_identity(conn);before=fingerprint(conn);conn.rollback();conn.set_session(readonly=False)
  with conn.cursor() as c:
   c.execute("SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='15s'")
   c.execute('select project_ref from waseet_test_ops.target where id=true')
   if c.fetchall()!=[(TEST_REF,)]:raise BackupError('Test marker mismatch')
   c.execute("select jsonb_agg(jsonb_build_array(e.evtname,e.evtevent,e.evtenabled,n.nspname,p.proname,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')) order by e.evtname) from pg_event_trigger e join pg_proc p on p.oid=e.evtfoid join pg_namespace n on n.oid=p.pronamespace where e.evtenabled<>'D'")
   pins=json.loads((directory/'test-hooks.json').read_text());expected=[[p[k] for k in ['name','event','enabled','schema','function','definition_sha256']] for p in pins]
   if c.fetchone()[0]!=expected:raise BackupError('DDL hooks changed; review required')
   c.execute("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'tg_market_%'")
   if c.fetchone()[0]:raise BackupError('Existing Telegram schema needs incremental review')
   c.execute("select exists(select 1 from storage.buckets where id='waseet-telegram-images')")
   if c.fetchone()[0]:raise BackupError('Existing Telegram bucket needs review')
   c.execute(sql)
   c.execute("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'tg_market_%' and c.relkind='r' and c.relrowsecurity")
   if c.fetchone()[0]!=11:raise BackupError('Telegram RLS incomplete')
   c.execute("select has_function_privilege('anon','public.tg_market_action(bigint,text,jsonb,boolean,text)','EXECUTE'),has_function_privilege('authenticated','public.tg_market_action(bigint,text,jsonb,boolean,text)','EXECUTE'),has_table_privilege('anon','public.tg_market_orders','SELECT')")
   if any(c.fetchone()):raise BackupError('Telegram private grants too broad')
  conn.rollback();conn.set_session(readonly=True)
  if fingerprint(conn)!=before:raise BackupError('Catalog rollback mismatch')
  with conn.cursor() as c:
   c.execute("select exists(select 1 from storage.buckets where id='waseet-telegram-images')")
   if c.fetchone()[0]:raise BackupError('Bucket rollback mismatch')
  proof={'test_ref':TEST_REF,'candidate_sha':os.environ.get('GITHUB_SHA'),'sql_sha256':manifest['sha256'],'rollback_verified':True,'hosted_users_or_messages_written':False,'production_changed':False,'hosted_auth_storage_and_bot_delivery_verified':False}
  (ROOT/'telegram-test-rehearsal.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof));return 0
 except Exception as e:print('Telegram Test rehearsal stopped safely: '+(str(e) if isinstance(e,BackupError) else safe_error_code(e)));return 1
 finally:
  if conn:
   try:conn.rollback()
   finally:conn.close()
if __name__=='__main__':raise SystemExit(main())
