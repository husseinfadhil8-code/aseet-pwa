"""Real PostgreSQL tests in a NEW, network-isolated disposable Docker container.

Requires Docker and a pre-pulled official postgres:17 image. Never accepts a DSN,
mounts files, publishes ports, or connects to a hosted database.
Run: PYTHONDONTWRITEBYTECODE=1 python3 scripts/integration_atomic_sales.py -v
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import threading
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
ADMIN = "10000000-0000-0000-0000-000000000001"
ADMIN2 = "10000000-0000-0000-0000-000000000002"
REP = "20000000-0000-0000-0000-000000000001"
RESTRICTED = "20000000-0000-0000-0000-000000000002"
PENDING = "20000000-0000-0000-0000-000000000003"
BANNED = "20000000-0000-0000-0000-000000000004"
REMOVED = "20000000-0000-0000-0000-000000000005"
INACTIVE_ADMIN = "10000000-0000-0000-0000-000000000003"
HISTORICAL = "30000000-0000-0000-0000-000000000001"


class AtomicSaleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = "aseet-sales-test-" + uuid.uuid4().hex[:12]
        subprocess.run(["docker", "run", "--pull=never", "--detach", "--rm",
                        "--name", cls.container, "--network", "none",
                        "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17"],
                       check=True, capture_output=True, text=True)
        cls.addClassCleanup(lambda: subprocess.run(
            ["docker", "rm", "--force", cls.container], check=True, capture_output=True))
        for _ in range(150):
            # The image briefly starts a temporary server during initdb. Wait for
            # PID 1 to become the final postgres server before trusting pg_isready.
            process = subprocess.run(["docker", "exec", cls.container, "cat", "/proc/1/comm"],
                                     capture_output=True, text=True)
            ready = subprocess.run(["docker", "exec", cls.container, "pg_isready", "-U", "postgres"],
                                   capture_output=True)
            if process.stdout.strip() == "postgres" and ready.returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("Disposable PostgreSQL did not start")
        cls.sql("""
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN BYPASSRLS;
            CREATE SCHEMA auth;
            CREATE TABLE auth.users (id uuid PRIMARY KEY);
            CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
              SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
            $$;
            GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
        """)
        cls.sql((ROOT / "supabase-schema.sql").read_text())
        # Explicit fixture delta: status is used by the app but absent from its initial schema.
        cls.sql("ALTER TABLE public.profiles ADD COLUMN status text;")
        for uid, role, status in [(ADMIN, "admin", "approved"), (ADMIN2, "admin", "approved"),
                                  (INACTIVE_ADMIN, "admin", "banned"), (REP, "rep", "approved"),
                                  (RESTRICTED, "rep", "restricted"), (PENDING, "rep", "pending"),
                                  (BANNED, "rep", "banned"), (REMOVED, "rep", "removed")]:
            cls.sql(f"INSERT INTO auth.users VALUES ('{uid}'); "
                    f"INSERT INTO public.profiles(id,full_name,role,status) "
                    f"VALUES ('{uid}','Fixture','{role}','{status}');")
        cls.sql(f"""
            INSERT INTO public.goods(id,title,asking_price,status)
            VALUES ('{HISTORICAL}','Legacy duplicate sales',1000,'available');
            INSERT INTO public.sales(goods_id,rep_id,final_price,total_commission,manager_share,rep_share)
            VALUES ('{HISTORICAL}','{REP}',1000,100,40,60),
                   ('{HISTORICAL}','{REP}',900,90,30,60);
        """)
        for name in ["fix_sales_permissions.sql", "commission_payouts.sql", "notifications.sql",
                     "sale_notifications.sql", "commission_payout_notifications.sql"]:
            cls.sql((ROOT / "supabase" / name).read_text())
        # Reproduce the repository's admin sales-delete policy without unrelated tables.
        delete_sql = (ROOT / "supabase/admin_delete_records.sql").read_text()
        cls.sql(delete_sql[delete_sql.index("alter table public.sales enable"):])
        cls.sql("""
            ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
            CREATE POLICY fixture_self_profile ON public.profiles FOR SELECT
              TO authenticated USING (id = auth.uid());
            GRANT SELECT ON public.profiles TO authenticated;
            ALTER TABLE public.goods ENABLE ROW LEVEL SECURITY;
            GRANT SELECT ON public.goods TO authenticated;
            CREATE POLICY fixture_read_goods ON public.goods FOR SELECT TO authenticated USING (true);
            GRANT INSERT (id) ON public.sales TO authenticated;
        """)
        cls.historical_before = cls.sql(f"SELECT row_to_json(s) FROM public.sales s WHERE goods_id='{HISTORICAL}' ORDER BY id;").stdout
        cls.migration = (ROOT / "supabase/atomic_sales.sql").read_text()
        cls.sql(cls.migration)

    @classmethod
    def sql(cls, query, check=True):
        result = subprocess.run(["docker", "exec", "-i", cls.container, "psql", "-X", "-qAt",
                                 "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
                                input=query, capture_output=True, text=True, timeout=20)
        if check and result.returncode:
            raise AssertionError(result.stderr)
        return result

    def setUp(self):
        self.good = str(uuid.uuid4())
        self.sql(f"INSERT INTO public.goods(id,title,asking_price,status) VALUES ('{self.good}','Test good',1000,'available');")

    def rpc(self, actor=ADMIN, rep=REP, price="1000", total="100", share="60", good=None,
            role="authenticated", tail="", isolation="READ COMMITTED"):
        uid = f"SET LOCAL request.jwt.claim.sub='{actor}';" if actor else ""
        query = f"""BEGIN ISOLATION LEVEL {isolation}; SET LOCAL ROLE {role}; {uid}
            SELECT public.record_sale('{good or self.good}','{rep}',{price},{total},{share});
            {tail} COMMIT;"""
        return self.sql(query, check=False)

    def state(self):
        return self.sql(f"""SELECT status::text,
            (SELECT count(*) FROM public.sales WHERE goods_id=g.id),
            (SELECT count(*) FROM public.sale_goods_registry WHERE goods_id=g.id),
            (SELECT count(*) FROM public.notifications WHERE category='sale' AND metadata->>'goods_id'=g.id::text)
            FROM public.goods g WHERE id='{self.good}';""").stdout.strip()

    def assert_rejected(self, result, code):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(code, result.stderr)
        self.assertEqual(self.state(), "available|0|0|0")

    def test_success_derives_manager_share_and_verifier(self):
        result = self.rpc()
        self.assertEqual(result.returncode, 0, result.stderr)
        uuid.UUID(result.stdout.strip())
        self.assertEqual(self.state(), "sold|1|1|2")
        self.assertEqual(self.sql(f"SELECT final_price,total_commission,manager_share,rep_share,verified_by,verified_at IS NOT NULL FROM public.sales WHERE goods_id='{self.good}';").stdout.strip(),
                         f"1000|100|40|60|{ADMIN}|t")

    def test_restricted_rep_and_zero_commission(self):
        result = self.rpc(rep=RESTRICTED, total="0", share="0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state(), "sold|1|1|2")

    def test_all_commission_can_go_to_rep(self):
        result = self.rpc(total="100", share="100")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.sql(f"SELECT manager_share FROM public.sales WHERE goods_id='{self.good}';").stdout.strip(), "0")

    def test_unauthenticated_and_non_admin_callers(self):
        for actor in [None, REP, INACTIVE_ADMIN, str(uuid.uuid4())]:
            with self.subTest(actor=actor):
                self.assert_rejected(self.rpc(actor=actor), "42501")
        self.assert_rejected(self.rpc(actor=None, role="anon"), "42501")

    def test_ineligible_representatives(self):
        for rep in [PENDING, BANNED, REMOVED, ADMIN, str(uuid.uuid4())]:
            with self.subTest(rep=rep):
                self.assert_rejected(self.rpc(rep=rep), "22023")

    def test_invalid_numeric_inputs(self):
        cases = [dict(price="0"), dict(price="-1"), dict(price="1.5"), dict(price="NULL"),
                 dict(price="9007199254740992"), dict(price="'NaN'"), dict(price="'Infinity'"),
                 dict(total="-1"), dict(total="0.1"), dict(total="NULL"),
                 dict(total="'NaN'"), dict(total="9007199254740992"),
                 dict(share="-1"), dict(share="101"), dict(share="0.5"), dict(share="NULL"),
                 dict(share="'NaN'"), dict(share="'Infinity'")]
        for values in cases:
            with self.subTest(values=values):
                self.assert_rejected(self.rpc(**values), "22023")

    def test_unknown_or_unavailable_good(self):
        self.assert_rejected(self.rpc(good=str(uuid.uuid4())), "55000")
        for status in ["reserved", "sold", "archived"]:
            self.sql(f"UPDATE public.goods SET status='{status}' WHERE id='{self.good}';")
            result = self.rpc()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("55000", result.stderr)
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.sales WHERE goods_id='{self.good}';").stdout.strip(), "0")

    def test_repeat_sale_is_rejected(self):
        self.assertEqual(self.rpc().returncode, 0)
        result = self.rpc()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("55000", result.stderr)
        self.assertEqual(self.state(), "sold|1|1|2")

    def test_legacy_duplicates_are_preserved_and_cannot_be_sold_again(self):
        self.assertEqual(self.sql(f"SELECT row_to_json(s) FROM public.sales s WHERE goods_id='{HISTORICAL}' ORDER BY id;").stdout,
                         self.historical_before)
        self.assert_rejected(self.rpc(good=HISTORICAL), "55000")

    def test_direct_insert_and_registry_access_are_denied(self):
        for statement in ["INSERT INTO public.sales DEFAULT VALUES;",
                          "INSERT INTO public.sales(id) VALUES (gen_random_uuid());",
                          "DELETE FROM public.sale_goods_registry;",
                          "SELECT * FROM public.sale_goods_registry;"]:
            result = self.sql("SET ROLE authenticated; " + statement, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("42501", result.stderr)

    def test_goods_update_failure_rolls_back_sale_registry_and_notifications(self):
        self.sql(f"""CREATE FUNCTION public.fixture_fail_goods() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.id='{self.good}'::uuid THEN RAISE EXCEPTION 'fixture goods failure'; END IF; RETURN NEW; END; $$;
          CREATE TRIGGER fixture_fail_goods BEFORE UPDATE ON public.goods
          FOR EACH ROW EXECUTE FUNCTION public.fixture_fail_goods();""")
        try:
            self.assert_rejected(self.rpc(), "fixture goods failure")
        finally:
            self.sql("DROP TRIGGER fixture_fail_goods ON public.goods; DROP FUNCTION public.fixture_fail_goods();")
        self.assertEqual(self.rpc().returncode, 0)

    def test_notification_failure_rolls_back_everything(self):
        self.sql(f"""CREATE FUNCTION public.fixture_fail_sale() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.goods_id='{self.good}'::uuid THEN RAISE EXCEPTION 'fixture notification failure'; END IF; RETURN NEW; END; $$;
          CREATE TRIGGER zz_fixture_fail_sale AFTER INSERT ON public.sales
          FOR EACH ROW EXECUTE FUNCTION public.fixture_fail_sale();""")
        try:
            self.assert_rejected(self.rpc(), "fixture notification failure")
        finally:
            self.sql("DROP TRIGGER zz_fixture_fail_sale ON public.sales; DROP FUNCTION public.fixture_fail_sale();")

    def test_two_admins_competing_only_one_commits(self):
        barrier = threading.Barrier(2)
        def compete(actor):
            barrier.wait(timeout=5)
            # Keep the winning transaction open so the other really contends for its lock.
            return self.rpc(actor=actor, tail="SELECT pg_sleep(1);")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(compete, [ADMIN, ADMIN2]))
        self.assertEqual(sorted(r.returncode for r in results), [0, 3], [r.stderr for r in results])
        self.assertIn("55000", next(r.stderr for r in results if r.returncode))
        self.assertEqual(self.state(), "sold|1|1|2")

    def test_repeatable_read_competitors_cannot_double_sell(self):
        barrier = threading.Barrier(2)
        def compete(actor):
            barrier.wait(timeout=5)
            return self.rpc(actor=actor, isolation="REPEATABLE READ", tail="SELECT pg_sleep(1);")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(compete, [ADMIN, ADMIN2]))
        self.assertEqual(sum(r.returncode == 0 for r in results), 1, [r.stderr for r in results])
        failure = next(r.stderr for r in results if r.returncode)
        self.assertTrue("40001" in failure or "55000" in failure, failure)
        self.assertEqual(self.state(), "sold|1|1|2")

    def test_suppressed_insert_cannot_mark_good_sold(self):
        self.sql(f"""CREATE FUNCTION public.fixture_skip_sale() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.goods_id='{self.good}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END; $$;
          CREATE TRIGGER zz_fixture_skip_sale BEFORE INSERT ON public.sales
          FOR EACH ROW EXECUTE FUNCTION public.fixture_skip_sale();""")
        try:
            self.assert_rejected(self.rpc(), "P0001")
        finally:
            self.sql("DROP TRIGGER zz_fixture_skip_sale ON public.sales; DROP FUNCTION public.fixture_skip_sale();")

    def test_suppressed_goods_update_rolls_back_sale(self):
        self.sql(f"""CREATE FUNCTION public.fixture_skip_update() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.id='{self.good}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END; $$;
          CREATE TRIGGER fixture_skip_update BEFORE UPDATE ON public.goods
          FOR EACH ROW EXECUTE FUNCTION public.fixture_skip_update();""")
        try:
            self.assert_rejected(self.rpc(), "P0001")
        finally:
            self.sql("DROP TRIGGER fixture_skip_update ON public.goods; DROP FUNCTION public.fixture_skip_update();")

    def test_profile_status_cannot_change_during_sale(self):
        # Hold a completed RPC open, then a NOWAIT status change must fail.
        proc = subprocess.Popen(["docker", "exec", "-i", self.container, "psql", "-X", "-qAt", "-U", "postgres", "-v", "ON_ERROR_STOP=1"],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            proc.stdin.write(f"BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='{ADMIN}'; SELECT public.record_sale('{self.good}','{REP}',1000,100,60);\n")
            proc.stdin.flush()
            uuid.UUID(proc.stdout.readline().strip())
            result = self.sql(f"BEGIN; SELECT id FROM public.profiles WHERE id='{REP}' FOR UPDATE NOWAIT;", check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("55P03", result.stderr)
            proc.stdin.write("COMMIT;\n")
            proc.stdin.flush()
            proc.communicate(timeout=10)
            self.assertEqual(proc.returncode, 0)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate()

    def test_payout_delete_and_immutable_goods_link(self):
        self.assertEqual(self.rpc().returncode, 0)
        sale_id = self.sql(f"SELECT id FROM public.sales WHERE goods_id='{self.good}';").stdout.strip()
        result = self.sql(f"UPDATE public.sales SET goods_id='{HISTORICAL}' WHERE id='{sale_id}';", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("22023", result.stderr)
        self.sql(f"SET ROLE authenticated; SET request.jwt.claim.sub='{ADMIN}'; SELECT public.mark_sale_commission_paid('{sale_id}');")
        self.assertEqual(self.sql(f"SELECT commission_paid_at IS NOT NULL FROM public.sales WHERE id='{sale_id}';").stdout.strip(), "t")
        self.sql(f"SET ROLE authenticated; SET request.jwt.claim.sub='{ADMIN}'; DELETE FROM public.sales WHERE id='{sale_id}';")
        self.sql(f"UPDATE public.goods SET status='available' WHERE id='{self.good}';")
        result = self.rpc()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("55000", result.stderr)

    def test_registry_guard_covers_privileged_inserts(self):
        # Even a trusted service path cannot insert the same good twice.
        insert = f"INSERT INTO public.sales(goods_id,rep_id,final_price,total_commission,manager_share,rep_share) VALUES ('{self.good}','{REP}',1000,100,40,60);"
        self.sql(insert)
        result = self.sql(insert, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("55000", result.stderr)

    def test_migration_is_repeatable_without_changing_history(self):
        before = self.sql("SELECT row_to_json(s) FROM public.sales s ORDER BY id;").stdout
        self.sql(self.migration)
        self.assertEqual(self.sql("SELECT row_to_json(s) FROM public.sales s ORDER BY id;").stdout, before)

    def test_preflight_rejects_initial_schema_without_partial_migration(self):
        self.sql("CREATE DATABASE fixture_initial_schema;")
        command = ["docker", "exec", "-i", self.container, "psql", "-X", "-qAt", "-U", "postgres",
                   "-d", "fixture_initial_schema", "-v", "ON_ERROR_STOP=1"]
        setup = "CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);\n" + (ROOT / "supabase-schema.sql").read_text()
        result = subprocess.run(command, input=setup, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(command, input=self.migration, text=True, capture_output=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("profiles.status", result.stderr)
        result = subprocess.run(command, input="SELECT to_regclass('public.sale_goods_registry') IS NULL;", text=True, capture_output=True, timeout=20)
        self.assertEqual(result.stdout.strip(), "t")


if __name__ == "__main__":
    unittest.main()
