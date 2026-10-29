"""Explicitly authorized production target; additive migration, no historical replay."""
import os,sys,json,hashlib,re,urllib.request
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts'))
from backup.manual_test_backup import source_config,connection,verify_source_identity,BackupError,safe_error_code
from review.test_upgrade_rollback import fingerprint
REF='beyrctbxojpuvhevfyok';BRANCH='refs/heads/fix/transactional-notification-outbox'
def main():
 conn=None
 try:
  mode=os.environ['OUTBOX_MODE'];assert mode in ['rehearsal','migrate']
  if os.environ.get('GITHUB_REF')!=BRANCH or os.environ.get('CONFIRM_TEST_REF')!=REF:raise BackupError('Explicit production target confirmation required')
  backup=json.loads((ROOT/'telegram-market/evidence/outbox-backup.json').read_text())
  url='https://api.github.com/repos/husseinfadhil8-code/aseet-pwa/actions/runs/'+str(backup['run_id'])
  req=urllib.request.Request(url,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
  with urllib.request.urlopen(req,timeout=20) as r:run=json.load(r)
  if run['conclusion']!='success' or run['path']!='.github/workflows/manual-waseet-test-backup.yml' or (datetime.now(timezone.utc)-datetime.fromisoformat(run['updated_at'].replace('Z','+00:00'))).total_seconds()>86400 or not backup['isolated_postgres_restore_verified'] or backup['project_ref']!=REF:raise BackupError('Fresh restored production backup required')
  sql=(ROOT/'telegram-market/db/011_notification_outbox.sql').read_text();digest=hashlib.sha256(sql.encode()).hexdigest()
  if mode=='migrate':
   proof=json.loads((ROOT/'telegram-market/evidence/outbox-rehearsal.json').read_text())
   if not proof.get('rollback_verified') or proof['sql_sha256']!=digest:raise BackupError('Matching rehearsal required')
  conn=connection(source_config(os.environ.pop('WASEET_TEST_DATABASE_URL')));verify_source_identity(conn);before=fingerprint(conn);conn.rollback();conn.set_session(readonly=False)
  with conn.cursor() as c:
   c.execute("select jsonb_agg(jsonb_build_array(e.evtname,e.evtevent,e.evtenabled,n.nspname,p.proname,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')) order by e.evtname) from pg_event_trigger e join pg_proc p on p.oid=e.evtfoid join pg_namespace n on n.oid=p.pronamespace where e.evtenabled<>'D'")
   pins=json.loads((ROOT/'telegram-market/db/test-hooks.json').read_text())
   if c.fetchone()[0]!=[[p[k] for k in ['name','event','enabled','schema','function','definition_sha256']] for p in pins]:raise BackupError('DDL hooks changed; review required')
   # The SQL envelope is owned here so a rehearsal can never commit itself.
   from pglast import parse_sql
   statements=parse_sql(sql)
   if type(statements[0].stmt).__name__!='TransactionStmt' or type(statements[-1].stmt).__name__!='TransactionStmt':raise BackupError('Unexpected SQL envelope')
   body=sql[statements[0].stmt_location+statements[0].stmt_len+1:statements[-1].stmt_location]
   if any(type(x.stmt).__name__=='TransactionStmt' for x in parse_sql(body)):raise BackupError('Nested transaction control forbidden')
   c.execute(body)
   c.execute("select count(*) from pg_trigger where tgname='notification_outbox_capture' and not tgisinternal")
   if c.fetchone()[0]!=15:raise BackupError('Incomplete capture triggers')
   c.execute('select count(*) from public.notification_outbox')
   if c.fetchone()[0]!=0:raise BackupError('Unexpected historical backfill')
   for role in ['anon','authenticated']:
    c.execute("select has_table_privilege(%s,'public.notification_outbox','SELECT'),has_table_privilege(%s,'public.notification_outbox','INSERT'),has_function_privilege(%s,'public.notification_outbox_claim(integer)','EXECUTE')",(role,role,role))
    if any(c.fetchone()):raise BackupError('Private outbox grants unsafe')
   c.execute("select relrowsecurity and relforcerowsecurity from pg_class where oid='public.notification_outbox'::regclass")
   if not c.fetchone()[0]:raise BackupError('RLS missing')
  if mode=='migrate':conn.commit()
  else:conn.rollback()
  conn.set_session(readonly=True)
  if mode=='rehearsal' and fingerprint(conn)!=before:raise BackupError('Rollback catalog mismatch')
  proof={'project_ref':REF,'source_sha':os.environ['GITHUB_SHA'],'sql_sha256':digest,'backup_run_id':backup['run_id'],'rollback_verified':mode=='rehearsal','production_outbox_installed':mode=='migrate','triggers':15,'no_backfill':True,'rls_verified':True,'business_rows_modified':False}
  (ROOT/'outbox-proof.json').write_text(json.dumps(proof,indent=2));print(json.dumps(proof));return 0
 except Exception as e:print('Outbox stopped safely: '+(str(e) if isinstance(e,BackupError) else safe_error_code(e)));return 1
 finally:
  if conn:conn.rollback();conn.close()
if __name__=='__main__':raise SystemExit(main())
