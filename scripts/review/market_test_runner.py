"""Manual PR50-only Test DDL rehearsal. No source/user data exported or persisted."""
import hashlib,json,os,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backup.manual_test_backup import BackupError,REPOSITORY,TEST_REF,source_config,connection,verify_source_identity,safe_error_code
from review.market_test_rollback import FILES,ROOT,FINGERPRINT,hook_guard

def main():
 conn=None
 try:
  if (os.environ.get('GITHUB_REPOSITORY')!=REPOSITORY or os.environ.get('GITHUB_REF')!='refs/heads/feat/unified-public-market-phase1' or os.environ.get('GITHUB_EVENT_NAME')!='workflow_dispatch' or os.environ.get('CONFIRM_TEST_REF')!=TEST_REF):raise BackupError('Manual PR50 Test confirmation required')
  texts=[(ROOT/'supabase'/name).read_text() for name in FILES]
  manifest=json.loads((ROOT/'scripts/review/market_bundle.json').read_text())
  if manifest!={name:hashlib.sha256(text.encode()).hexdigest() for name,text in zip(FILES,texts)}:raise BackupError('Unreviewed market SQL bundle')
  conn=connection(source_config(os.environ.pop('WASEET_TEST_DATABASE_URL','')))
  verify_source_identity(conn)
  with conn.cursor() as c:c.execute(FINGERPRINT);baseline=c.fetchone()[0]
  conn.rollback();conn.set_session(readonly=False)
  with conn.cursor() as c:
   c.execute("SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='15s'")
   c.execute(hook_guard())
   for text in texts:c.execute(text)
   c.execute("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('market_members','market_listings','market_threads','market_messages','market_favorites','market_reports','market_promotions','market_promotion_events','market_payment_settings','market_moderation_events') AND c.relrowsecurity")
   if c.fetchone()[0]!=10:raise BackupError('Market RLS incomplete')
   c.execute("SELECT has_table_privilege('authenticated','public.market_promotions','INSERT,UPDATE,DELETE'),has_table_privilege('anon','public.market_promotions','SELECT')")
   if any(c.fetchone()):raise BackupError('Payment permissions too broad')
   c.execute("SET LOCAL ROLE anon;SELECT id FROM public.market_browse LIMIT 0;SELECT * FROM public.market_promoted_listings() LIMIT 0;RESET ROLE")
  conn.rollback();conn.set_session(readonly=True)
  with conn.cursor() as c:c.execute(FINGERPRINT);after=c.fetchone()[0]
  if baseline!=after:raise BackupError('Catalog rollback mismatch')
  evidence=dict(project_ref=TEST_REF,candidate_sha=os.environ.get('GITHUB_SHA'),schema_rehearsal_passed=True,rollback_verified=True,hosted_jwt_behavior_verified=False,production_changed=False,hosted_user_rows_written=False,sql_sha256=manifest,catalog_fingerprint=baseline)
  output=ROOT/'market-test-rehearsal.json';output.write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,sort_keys=True));return 0
 except Exception as error:
  print('Test market rehearsal stopped safely: '+(str(error) if isinstance(error,BackupError) else safe_error_code(error)),file=sys.stderr);return 1
 finally:
  if conn:
   try:conn.rollback()
   finally:conn.close()
if __name__=='__main__':raise SystemExit(main())
