"""Explicit Test-only HTTPS transactional schema rehearsal; always ROLLBACK.
No source rows exported, fixtures/users created, credentials logged, or production route.
"""
import argparse,hashlib,json,os,sys,urllib.request,urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
REF='beyrctbxojpuvhevfyok'
FILES=['public-market-phase1.sql','public-market-chat-phase1.sql','public-market-engagement-phase1.sql','public-market-promotion-phase1.sql']
FINGERPRINT="""SELECT md5(coalesce(string_agg(item::text,'' order by item::text),'')) AS fingerprint FROM (
 SELECT jsonb_build_array('relation',n.nspname,c.relname,c.relkind,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.relacl) item FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname in ('public','storage')
 UNION ALL SELECT jsonb_build_array('policy',n.nspname,c.relname,p.polname,p.polcmd,p.polroles,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname in ('public','storage')
 UNION ALL SELECT jsonb_build_array('function',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid),p.proacl) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname in ('public','storage') AND p.prokind in ('f','p')
 UNION ALL SELECT jsonb_build_array('trigger',n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid)) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname in ('public','storage') AND NOT t.tgisinternal
 UNION ALL SELECT jsonb_build_array('column',n.nspname,c.relname,a.attname,a.atttypid,a.attnotnull,a.attacl) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname in ('public','storage') AND a.attnum>0 AND NOT a.attisdropped
) data"""
def query(sql,readonly=True):
 token=os.environ.get('WASEET_TEST_MANAGEMENT_TOKEN')
 if not token:raise RuntimeError('Test Management credential unavailable')
 req=urllib.request.Request(f'https://api.supabase.com/v1/projects/{REF}/database/query',data=json.dumps({'query':sql,'read_only':readonly}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='POST')
 try:
  with urllib.request.urlopen(req,timeout=45) as response:return json.load(response)
 except urllib.error.HTTPError as error:
  # Local diagnostic only; generated DDL contains no source rows/credentials.
  Path('/tmp/waseet-market-management-error.json').write_bytes(error.read())
  raise
def hook_guard():
 pins=json.loads(Path(__file__).with_name('market_test_hooks.json').read_text())
 expected=[[p[k] for k in ['name','event','enabled','schema','function','definition_sha256']] for p in pins]
 value=json.dumps(expected).replace("'","''")
 return f"""DO $guard$ BEGIN
 IF (SELECT project_ref FROM waseet_test_ops.target WHERE id=true) IS DISTINCT FROM '{REF}' THEN RAISE EXCEPTION 'Test identity mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'market_%') THEN RAISE EXCEPTION 'Existing market schema needs incremental review'; END IF;
 IF (SELECT jsonb_agg(jsonb_build_array(e.evtname,e.evtevent,e.evtenabled,n.nspname,p.proname,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')) ORDER BY e.evtname) FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE e.evtenabled<>'D') IS DISTINCT FROM '{value}'::jsonb THEN RAISE EXCEPTION 'DDL hooks changed; review required'; END IF;
 END $guard$;"""
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--execute-test-rollback',action='store_true');args=parser.parse_args()
 if not args.execute_test_rollback:parser.error('Explicit --execute-test-rollback is required')
 manifest={n:hashlib.sha256((ROOT/'supabase'/n).read_bytes()).hexdigest() for n in FILES}
 try:
  identity=query(f"SELECT (SELECT project_ref FROM waseet_test_ops.target WHERE id=true) AS project_ref")
  if identity!=[{'project_ref':REF}]:raise RuntimeError('Test identity mismatch')
  readiness=query("SELECT current_user,current_setting('transaction_read_only') AS read_only",False)
  if readiness[0]['read_only']!='off' or readiness[0]['current_user']=='supabase_read_only_user':raise RuntimeError('Configured Test Management identity is read-only; hosted DDL rehearsal requires a write-capable Test runner')
  before=query(FINGERPRINT)
  sql="BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s';\n"+hook_guard()+'\n'+'\n'.join((ROOT/'supabase'/n).read_text() for n in FILES)
  sql+="""
 DO $assert$ BEGIN
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('market_members','market_listings','market_threads','market_messages','market_favorites','market_reports','market_promotions','market_promotion_events','market_payment_settings','market_moderation_events') AND c.relrowsecurity)<>10 THEN RAISE EXCEPTION 'RLS incomplete'; END IF;
 IF has_table_privilege('authenticated','public.market_promotions','INSERT,UPDATE,DELETE') OR has_table_privilege('anon','public.market_promotions','SELECT') THEN RAISE EXCEPTION 'Payment permissions too broad'; END IF;
 END $assert$;
 SET LOCAL ROLE anon;
 SELECT id FROM public.market_browse LIMIT 0;
 SELECT * FROM public.market_promoted_listings() LIMIT 0;
 RESET ROLE;
 ROLLBACK;
 """
  query(sql,False)
  after=query(FINGERPRINT)
  if before!=after:raise RuntimeError('Catalog rollback mismatch')
  evidence={'project_ref':REF,'schema_rehearsal_passed':True,'rollback_verified':True,'hosted_jwt_behavior_verified':False,'production_changed':False,'hosted_user_rows_written':False,'new_payment_settings_and_bucket_rolled_back':True,'sql_sha256':manifest,'catalog_fingerprint':before[0]['fingerprint']}
  path=ROOT/'docs/review/market-test-rollback.json';path.write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence))
 except urllib.error.HTTPError as e:print(f'Test rehearsal stopped: Management HTTP {e.code}; no response body logged',file=sys.stderr);return 1
 except Exception as e:
  print('Test rehearsal stopped safely: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__),file=sys.stderr);return 1
 return 0
if __name__=='__main__':raise SystemExit(main())
