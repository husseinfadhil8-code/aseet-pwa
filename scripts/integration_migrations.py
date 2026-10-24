"""Test the actual versioned migrations using the pinned CLI, with no hosted access."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
import unittest
import uuid

from local_database import LocalDatabase

ROOT = Path(__file__).resolve().parents[1]


class MigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = LocalDatabase().start()
        cls.addClassCleanup(cls.database.stop)
        cls.database.migrate()

    def setUp(self):
        self.admin, self.rep, self.other = [str(uuid.uuid4()) for _ in range(3)]
        self.good = str(uuid.uuid4())
        for uid, role in [(self.admin, 'admin'), (self.rep, 'rep'), (self.other, 'rep')]:
            self.sql(f"""INSERT INTO auth.users(id) VALUES ('{uid}');
                INSERT INTO public.profiles(id,full_name,role,status,username)
                VALUES ('{uid}','Local fixture','{role}','approved','u_{uuid.UUID(uid).hex[:12]}');""")
        self.sql(f"INSERT INTO public.goods(id,title,asking_price,created_by) VALUES ('{self.good}','Local good',1000,'{self.admin}');")

    def sql(self, query, check=True):
        return self.database.sql(query, check=check)

    def as_user(self, query, actor=None):
        return self.sql(f"BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='{actor or self.rep}'; {query} COMMIT;", check=False)

    def sale(self, actor=None):
        return self.as_user(f"SELECT public.record_sale('{self.good}','{self.rep}',1000,100,60);", actor or self.admin)

    def test_cli_history_and_repeat_application(self):
        expected = [path.name.split('_')[0] for path in sorted((ROOT/'supabase/migrations').glob('*.sql'))]
        actual = self.sql("SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;").stdout.splitlines()
        self.assertEqual(actual, expected)
        before = self.sql("SELECT row_to_json(p) FROM public.profiles p ORDER BY id;").stdout
        self.database.migrate()
        self.assertEqual(self.sql("SELECT row_to_json(p) FROM public.profiles p ORDER BY id;").stdout, before)
        listing = self.database.cli('migration','list')
        for version in expected:
            self.assertIn(version, listing.stdout)

    def test_isolation_has_no_network_or_host_ports(self):
        self.database.validate()
        with self.assertRaises(RuntimeError):
            self.database.cli('db','push')

    def test_expected_columns_and_rls(self):
        expected = {
            'profiles': ['id','role','status','permissions','username','username_locked','avatar_url','online'],
            'goods': ['id','status','asking_price','agreed_commission','created_by'],
            'sales': ['goods_id','rep_id','final_price','manager_share','rep_share','verified_by','verified_at','commission_paid_at'],
            'notifications': ['recipient_id','category','metadata'],
        }
        for table, columns in expected.items():
            found = self.sql(f"SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}';").stdout.splitlines()
            self.assertTrue(set(columns).issubset(found), table)
            self.assertEqual(self.sql(f"SELECT relrowsecurity FROM pg_class WHERE oid='public.{table}'::regclass;").stdout.strip(), 't')

    def test_versioned_security_matches_reviewed_sources(self):
        for source, migration in [('atomic_sales.sql','20261024000300_atomic_sales.sql'),
                                  ('harden_profiles_goods_rls.sql','20261024000400_harden_profiles_goods_rls.sql')]:
            self.assertEqual((ROOT/'supabase'/source).read_text(), (ROOT/'supabase/migrations'/migration).read_text())

    def test_registration_upsert_and_protected_fields(self):
        uid = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users(id) VALUES ('{uid}');")
        insert = f"""INSERT INTO public.profiles(id,full_name,role,status,permissions,username)
            VALUES ('{uid}','New rep','rep','pending','{{"can_add_inquiry":true}}','u_{uuid.UUID(uid).hex[:12]}')
            ON CONFLICT(id) DO UPDATE SET role=EXCLUDED.role,status=EXCLUDED.status,permissions=EXCLUDED.permissions;"""
        for _ in range(2):
            result = self.as_user(insert, uid)
            self.assertEqual(result.returncode, 0, result.stderr)
        for assignment in ["role='admin'", "status='approved'", "permissions='{}'::jsonb"]:
            result = self.as_user(f"UPDATE public.profiles SET {assignment} WHERE id='{uid}';", uid)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('42501', result.stderr)

    def test_unknown_permissive_policies_do_not_reopen_goods_or_profiles(self):
        self.sql("""CREATE POLICY fixture_broad_profiles ON public.profiles FOR UPDATE
            TO authenticated USING(true) WITH CHECK(true);
            CREATE POLICY fixture_broad_goods ON public.goods FOR INSERT
            TO authenticated WITH CHECK(true);""")
        try:
            for query in [f"UPDATE public.profiles SET role='admin' WHERE id='{self.rep}';",
                          f"INSERT INTO public.goods(title,asking_price,created_by) VALUES ('No',1,'{self.rep}');"]:
                result = self.as_user(query)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('42501', result.stderr)
        finally:
            self.sql("DROP POLICY fixture_broad_profiles ON public.profiles; DROP POLICY fixture_broad_goods ON public.goods;")

    def test_admin_goods_and_notifications_remain_available(self):
        good = str(uuid.uuid4())
        result = self.as_user(f"INSERT INTO public.goods(id,title,asking_price,created_by) VALUES ('{good}','Admin good',200,'{self.admin}');", self.admin)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.notifications WHERE recipient_id='{self.rep}' AND metadata->>'goods_id'='{good}' AND category='new_goods';").stdout.strip(), '1')

    def test_atomic_sale_on_complete_migrated_schema(self):
        result = self.sale()
        self.assertEqual(result.returncode, 0, result.stderr)
        sale = result.stdout.strip()
        uuid.UUID(sale)
        self.assertEqual(self.sql(f"SELECT g.status,s.manager_share,s.rep_share,s.verified_by FROM public.goods g JOIN public.sales s ON s.goods_id=g.id WHERE g.id='{self.good}';").stdout.strip(), f'sold|40|60|{self.admin}')
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.notifications WHERE recipient_id='{self.rep}' AND metadata->>'sale_id'='{sale}' AND category='sale';").stdout.strip(), '1')
        self.assertNotEqual(self.sale().returncode, 0)

    def test_transaction_rolls_back_on_goods_failure(self):
        self.sql(f"""CREATE FUNCTION public.fixture_migration_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.id='{self.good}'::uuid THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END; $$;
          CREATE TRIGGER fixture_migration_failure BEFORE UPDATE ON public.goods
          FOR EACH ROW EXECUTE FUNCTION public.fixture_migration_failure();""")
        try:
            result = self.sale()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('fixture failure', result.stderr)
            self.assertEqual(self.sql(f"SELECT status FROM public.goods WHERE id='{self.good}';").stdout.strip(), 'available')
            self.assertEqual(self.sql(f"SELECT count(*) FROM public.sales WHERE goods_id='{self.good}';").stdout.strip(), '0')
            self.assertEqual(self.sql(f"SELECT count(*) FROM public.sale_goods_registry WHERE goods_id='{self.good}';").stdout.strip(), '0')
        finally:
            self.sql("DROP TRIGGER fixture_migration_failure ON public.goods; DROP FUNCTION public.fixture_migration_failure();")

    def test_two_concurrent_migrated_schema_sales_commit_once(self):
        barrier = threading.Barrier(2)
        def compete(_):
            barrier.wait(timeout=5)
            return self.as_user(f"SELECT public.record_sale('{self.good}','{self.rep}',1000,100,60); SELECT pg_sleep(0.5);", self.admin)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(compete, range(2)))
        self.assertEqual(sum(r.returncode == 0 for r in results), 1, [r.stderr for r in results])
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.sales WHERE goods_id='{self.good}';").stdout.strip(), '1')

    def test_inquiry_permissions_and_banned_sale_read(self):
        query = f"INSERT INTO public.inquiries(goods_id,rep_id,buyer_name) VALUES ('{self.good}','{self.rep}','Fixture buyer');"
        self.assertEqual(self.as_user(query).returncode, 0)
        self.sql(f"UPDATE public.profiles SET permissions='{{\"can_add_inquiry\":false}}' WHERE id='{self.rep}';")
        self.assertNotEqual(self.as_user(query).returncode, 0)
        self.assertEqual(self.sale().returncode, 0)
        self.sql(f"UPDATE public.profiles SET status='banned' WHERE id='{self.rep}';")
        result = self.as_user(f"SELECT count(*) FROM public.sales WHERE rep_id='{self.rep}';")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '0')

    def test_chat_functions_compile_and_work(self):
        result = self.as_user('SELECT public.ensure_chat_ready(); SELECT count(*) FROM public.get_chat_people();')
        self.assertEqual(result.returncode, 0, result.stderr)
        uuid.UUID(result.stdout.splitlines()[0])

    def test_fresh_bootstrap_refuses_existing_schema_without_data_loss(self):
        before = self.sql("SELECT row_to_json(s) FROM public.sales s ORDER BY id;").stdout
        bootstrap = (ROOT/'supabase/migrations/20261024000100_fresh_schema.sql').read_text()
        result = self.sql('BEGIN;\n'+bootstrap+'\nCOMMIT;', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.sql("SELECT row_to_json(s) FROM public.sales s ORDER BY id;").stdout, before)


if __name__ == '__main__':
    unittest.main()
