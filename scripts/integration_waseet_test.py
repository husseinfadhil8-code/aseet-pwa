"""Exercise the hosted-batch SQL locally. Never instantiate a network API client."""
from concurrent.futures import ThreadPoolExecutor
import json
import threading
import unittest

from local_database import LocalDatabase
import waseet_test as staging

REF = 't'*20
POLICY = {'project_name':'Waseet-Test','project_ref':REF,
          'project_url':'https://supabase.com/dashboard/project/'+REF}


class DockerOnlyClient:
    def __init__(self,database,ref):
        self.database,self.ref = database,ref
        self.writes=0

    def verify_identity(self):
        pass  # Transport/identity rejection is covered by offline safety tests.

    def query(self,sql,read_only=True):
        if read_only:
            query = 'BEGIN READ ONLY; SELECT coalesce(json_agg(row_to_json(q)),\'[]\'::json) FROM ('+sql.strip().rstrip(';')+') q; COMMIT;'
        else:
            self.writes+=1
            query=sql
        result = self.database.sql(query,check=False)
        if result.returncode:
            raise staging.SafetyError('Local batch failed: '+result.stderr)
        return json.loads(result.stdout.strip()) if read_only else []


class WaseetTestBatchTests(unittest.TestCase):
    def setUp(self):
        self.database=LocalDatabase().start()
        self.addCleanup(self.database.stop)
        self.client=DockerOnlyClient(self.database,REF)
        self.plan=staging.make_plan(POLICY)

    def operation(self,command):
        return staging.hosted_operation(command,POLICY,self.plan,REF,self.plan['plan_sha256'],
            environ={staging.TOKEN_NAME:'offline-fixture'},factory=lambda ref,token:self.client)

    def test_apply_smoke_and_repeat_are_safe(self):
        self.assertEqual(self.operation('check')['pending_migrations'],6)
        self.assertEqual(self.operation('apply')['pending_migrations'],0)
        self.assertEqual(self.operation('smoke')['pending_migrations'],0)
        self.assertEqual(self.operation('apply')['pending_migrations'],0)
        self.assertEqual(self.client.writes,1)

    def test_inventory_array_has_text_type_for_management_api(self):
        queries=[]
        original=self.client.query
        def capture(sql,read_only=True):
            queries.append(sql)
            return original(sql,read_only=read_only)
        self.client.query=capture
        self.assertEqual(staging.inventory(self.client)['public_tables'],[])
        inventory_sql=queries[0].strip().rstrip(';')
        result=original('SELECT pg_typeof(q.public_tables)::text AS array_type FROM ('+inventory_sql+') q;')
        self.assertEqual(result,[{'array_type':'text[]'}])
        self.database.sql('CREATE TABLE public.keep_me(id integer);')
        self.assertEqual(staging.inventory(self.client)['public_tables'],['keep_me'])
        self.assertEqual(self.client.writes,0)

    def test_upgrade_existing_five_migrations_preserves_rows_and_history(self):
        first_five=dict(self.plan,migrations=self.plan['migrations'][:5])
        self.client.query(staging.build_apply_sql(first_five,staging.inventory(self.client)),read_only=False)
        uid='10000000-0000-0000-0000-000000000001'
        gid='20000000-0000-0000-0000-000000000001'
        self.database.sql(f"INSERT INTO auth.users(id) VALUES ('{uid}'); INSERT INTO public.profiles(id,full_name,role,status) VALUES ('{uid}','Existing admin','admin','approved'); INSERT INTO public.goods(id,title,asking_price,owner_name,owner_phone,created_by) VALUES ('{gid}','Existing good',1000,'Private owner','07700000000','{uid}');")
        snapshot="SELECT row_to_json(g) FROM public.goods g ORDER BY id; SELECT row_to_json(p) FROM public.profiles p ORDER BY id;"
        before=self.database.sql(snapshot).stdout
        self.assertEqual(self.operation('check')['pending_migrations'],1)
        self.assertEqual(self.operation('apply')['pending_migrations'],0)
        self.assertEqual(self.database.sql(snapshot).stdout,before)
        state=staging.inventory(self.client)
        self.assertEqual(state['hashes'],{m['version']:m['sha256'] for m in self.plan['migrations']})
        self.assertEqual(self.database.sql("SELECT has_column_privilege('authenticated','public.goods','owner_phone','SELECT');").stdout.strip(),'f')
        self.assertEqual(self.client.writes,2)

    def test_late_failure_rolls_back_entire_chain_and_history(self):
        self.database.sql("""CREATE FUNCTION public.rls_is_active_admin() RETURNS boolean
            LANGUAGE sql AS $$SELECT false;$$;
            ALTER FUNCTION public.rls_is_active_admin() OWNER TO authenticated;""")
        with self.assertRaises(staging.SafetyError):
            self.operation('apply')
        self.assertEqual(self.database.sql("SELECT to_regclass('public.profiles') IS NULL, to_regclass('waseet_test_ops.history') IS NULL;").stdout.strip(),'t|t')

    def test_existing_table_data_is_never_overwritten(self):
        self.database.sql("CREATE TABLE public.keep_me(value text); INSERT INTO public.keep_me VALUES('preserved');")
        with self.assertRaises(staging.SafetyError):
            self.operation('apply')
        self.assertEqual(self.client.writes,0)
        self.assertEqual(self.database.sql('SELECT value FROM public.keep_me;').stdout.strip(),'preserved')

    def test_unmanaged_cli_history_requires_review_not_adoption(self):
        self.database.sql("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text); INSERT INTO supabase_migrations.schema_migrations VALUES('20261024000100');")
        with self.assertRaises(staging.SafetyError):
            self.operation('apply')
        self.assertEqual(self.client.writes,0)

    def test_history_hash_drift_blocks_retry(self):
        self.operation('apply')
        self.database.sql("UPDATE waseet_test_ops.history SET sha256='changed';")
        with self.assertRaises(staging.SafetyError):
            self.operation('apply')
        self.assertEqual(self.client.writes,1)

    def test_schema_change_after_preflight_is_rechecked_in_transaction(self):
        state=staging.inventory(self.client)
        sql=staging.build_apply_sql(self.plan,state)
        self.database.sql('CREATE TABLE public.new_unexpected_table(id integer);')
        result=self.database.sql(sql,check=False)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.database.sql("SELECT to_regclass('waseet_test_ops.history') IS NULL;").stdout.strip(),'t')

    def test_two_stale_plans_cannot_apply_twice(self):
        sql=staging.build_apply_sql(self.plan,staging.inventory(self.client))
        sql=sql.replace('END $waseet_apply$;','PERFORM pg_sleep(0.5); END $waseet_apply$;')
        barrier=threading.Barrier(2)
        def compete(_):
            barrier.wait(timeout=5)
            return self.database.sql(sql,check=False)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(compete,range(2)))
        self.assertEqual(sum(r.returncode==0 for r in results),1,[r.stderr for r in results])
        self.assertEqual(self.database.sql('SELECT count(*) FROM waseet_test_ops.history;').stdout.strip(),'6')

    def test_read_only_smoke_detects_disabled_authority_guard(self):
        self.operation('apply')
        self.database.sql('ALTER TABLE public.profiles DISABLE TRIGGER a_guard_profile_authority;')
        with self.assertRaises(staging.SafetyError):
            self.operation('smoke')
        self.assertEqual(self.client.writes,1)


    def test_readiness_audit_distinguishes_schema_five_and_six_without_writes(self):
        import waseet_readiness as audit
        first_five=dict(self.plan,migrations=self.plan['migrations'][:5])
        self.client.query(staging.build_apply_sql(first_five,staging.inventory(self.client)),read_only=False)
        writes=self.client.writes
        before=audit.audit_database(self.client,self.plan)
        self.assertEqual(self.client.writes,writes)
        self.assertEqual(before['pending_versions'],['20261024000600'])
        self.assertFalse(before['schema_checks_passed'])
        self.assertFalse(before['checks']['owner_phone_private'])
        self.assertTrue(before['checks']['no_duplicate_sales'])
        self.operation('apply')
        writes=self.client.writes
        after=audit.audit_database(self.client,self.plan)
        self.assertEqual(self.client.writes,writes)
        self.assertTrue(after['schema_checks_passed'])
        self.assertTrue(after['checks']['owner_phone_private'])
        self.assertEqual(after['checks']['row_counts'],before['checks']['row_counts'])

    def test_backup_inventory_counts_real_catalog_without_exporting_rows(self):
        from waseet_backup_inventory import inspect_backup_source
        self.operation('apply')
        writes=self.client.writes
        report=inspect_backup_source(self.client)
        self.assertTrue(report['full_row_visibility'])
        relations={(r['schema'],r['table']):r for r in report['relations']}
        self.assertEqual(relations[('auth','users')]['rows'],0)
        self.assertEqual(relations[('storage','buckets')]['rows'],2)
        self.assertFalse(report['backup_created'])
        self.assertEqual(self.client.writes,writes)

if __name__=='__main__':
    unittest.main()
