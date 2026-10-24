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
        self.assertEqual(self.operation('check')['pending_migrations'],5)
        self.assertEqual(self.operation('apply')['pending_migrations'],0)
        self.assertEqual(self.operation('smoke')['pending_migrations'],0)
        self.assertEqual(self.operation('apply')['pending_migrations'],0)
        self.assertEqual(self.client.writes,1)

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
        self.assertEqual(self.database.sql('SELECT count(*) FROM waseet_test_ops.history;').stdout.strip(),'5')

    def test_read_only_smoke_detects_disabled_authority_guard(self):
        self.operation('apply')
        self.database.sql('ALTER TABLE public.profiles DISABLE TRIGGER a_guard_profile_authority;')
        with self.assertRaises(staging.SafetyError):
            self.operation('smoke')
        self.assertEqual(self.client.writes,1)


if __name__=='__main__':
    unittest.main()
