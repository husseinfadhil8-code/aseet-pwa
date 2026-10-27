"""Pinned incremental Telegram migration; manual confirmed Test only, never production."""
import os,sys,json,hashlib,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts'));sys.path.insert(0,str(ROOT/'telegram-market/scripts'))
from backup.manual_test_backup import source_config,connection,verify_source_identity,BackupError,TEST_REF,REPOSITORY,safe_error_code
from review.test_upgrade_rollback import fingerprint
from test_rehearsal import legacy_fingerprint

def main():
 conn=None
 try:
  if os.environ.get('GITHUB_REPOSITORY')!=REPOSITORY or os.environ.get('GITHUB_EVENT_NAME')!='workflow_dispatch' or os.environ.get('GITHUB_REF') not in ['refs/heads/feature/telegram-intelligent-guide'] or os.environ.get('CONFIRM_TEST_REF')!=TEST_REF:raise BackupError('Manual Telegram Test confirmation required')
  directory=ROOT/'telegram-market/db';sql=(directory/'006_guide_assistant.sql').read_text();digest=hashlib.sha256(sql.encode()).hexdigest()
  if digest!=json.loads((directory/'phase6-manifest.json').read_text())['sha256']:raise BackupError('Unreviewed incremental SQL')
  from pglast import parse_sql
  if any(type(n.stmt).__name__=='TransactionStmt' for n in parse_sql(sql)):raise BackupError('Transaction control forbidden')
  backup=json.loads((ROOT/'telegram-market/evidence/phase6-backup.json').read_text())
  from datetime import datetime,timezone
  if not backup.get('actual_hosted_backup') or not backup.get('isolated_postgres_restore_verified') or backup.get('project_ref')!=TEST_REF or (datetime.now(timezone.utc)-datetime.fromisoformat(backup['completed_at'].replace('Z','+00:00'))).total_seconds()>86400:raise BackupError('Fresh restored Test backup required')
  install=os.environ.get('TELEGRAM_PHASE6_INSTALL')=='true'
  if install:
   proof=json.loads((ROOT/'telegram-market/evidence/phase6-rollback.json').read_text())
   if not proof.get('rollback_verified') or proof.get('sql_sha256')!=digest:raise BackupError('Matching hosted rollback proof required')
  conn=connection(source_config(os.environ.pop('WASEET_TEST_DATABASE_URL','')));verify_source_identity(conn);before=fingerprint(conn);legacy=legacy_fingerprint(conn);conn.rollback();conn.set_session(readonly=False)
  with conn.cursor() as c:
   c.execute("SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s'")
   c.execute('select project_ref from waseet_test_ops.target where id=true')
   if c.fetchall()!=[(TEST_REF,)]:raise BackupError('Test marker mismatch')
   c.execute("select jsonb_agg(jsonb_build_array(e.evtname,e.evtevent,e.evtenabled,n.nspname,p.proname,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')) order by e.evtname) from pg_event_trigger e join pg_proc p on p.oid=e.evtfoid join pg_namespace n on n.oid=p.pronamespace where e.evtenabled<>'D'")
   pins=json.loads((directory/'test-hooks.json').read_text())
   if c.fetchone()[0]!=[[p[k] for k in ['name','event','enabled','schema','function','definition_sha256']] for p in pins]:raise BackupError('DDL hooks changed; stop for review')
   c.execute("select to_regclass('public.tg_market_intelligence_settings')")
   if c.fetchone()[0] is not None:raise BackupError('Phase6 already exists; do not reapply')
   baseline=(directory/'005_wanted_radar.sql').read_text()
   for match in re.finditer(r'create (?:or replace )?function public\.(\w+)\(.*?\$\$(.*?)\$\$;',baseline,re.S):
    function,expected=match.groups()
    c.execute('select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=%s and p.proname=%s',('public',function))
    if c.fetchall()!=[(expected,)]:raise BackupError('Telegram baseline changed; incremental review required')
   c.execute(sql)
   c.execute("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'tg_market_%' and c.relrowsecurity")
   if c.fetchone()[0]!=44:raise BackupError('RLS incomplete')
   for function in ['public.tg_market_intelligence_action(bigint,text,jsonb,boolean,text)','public.tg_market_guide_worker(text,jsonb)','public.tg_market_assistant_worker(text,jsonb)','public.tg_market_assist_search(jsonb)','public.tg_market_assistant_tools(bigint,text)']:
    c.execute("select has_function_privilege('anon',%s,'EXECUTE'),has_function_privilege('authenticated',%s,'EXECUTE')",(function,function))
    if any(c.fetchone()):raise BackupError('Private RPC grants unsafe')
   c.execute('select (select count(*) from public.tg_market_guide_outbox)+(select count(*) from public.tg_market_assistant_jobs)+(select count(*) from public.tg_market_learning_preferences)')
   if c.fetchone()[0]!=0:raise BackupError('Unexpected new feature data')
   c.execute('select channel_enabled,tips_enabled,assistant_enabled from public.tg_market_intelligence_settings where singleton')
   if any(c.fetchone()):raise BackupError('New systems must remain disabled')
   c.execute('select count(*) from public.tg_market_guide_topics where approved')
   if c.fetchone()[0]!=0:raise BackupError('Content approval must be explicit')
   if legacy_fingerprint(conn)!=legacy:raise BackupError('Legacy catalog changed')
  if install:conn.commit()
  else:conn.rollback()
  conn.set_session(readonly=True)
  if legacy_fingerprint(conn)!=legacy:raise BackupError('Legacy catalog mismatch')
  if not install and fingerprint(conn)!=before:raise BackupError('Rollback catalog mismatch')
  proof={'test_ref':TEST_REF,'candidate_sha':os.environ.get('GITHUB_SHA'),'sql_sha256':digest,'rollback_verified':not install,'test_phase6_installed':install,'legacy_catalog_unchanged':True,'production_changed':False,'hosted_users_or_messages_written':False}
  (ROOT/'telegram-phase6-proof.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof));return 0
 except Exception as e:print('Phase6 stopped safely: '+(str(e) if isinstance(e,BackupError) else safe_error_code(e)));return 1
 finally:
  if conn:
   try:conn.rollback()
   finally:conn.close()
if __name__=='__main__':raise SystemExit(main())
