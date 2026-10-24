"""RLS and PR #6 compatibility tests, only in a disposable networkless PostgreSQL.

Requires Docker and the postgres:17 image already pulled.
Run: PYTHONDONTWRITEBYTECODE=1 python3 scripts/integration_rls_privileges.py -v
"""
from pathlib import Path
import unittest
import uuid

import integration_atomic_sales as atomic

ROOT = Path(__file__).resolve().parents[1]


class RlsPrivilegeTests(atomic.AtomicSaleTests):
    """Run all atomic-sale regressions again with hardened RLS, plus attack cases."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.sql("""
            ALTER TABLE public.profiles ADD COLUMN permissions jsonb NOT NULL
                DEFAULT '{"can_add_inquiry":true}'::jsonb;
            ALTER TABLE public.profiles ALTER COLUMN status SET DEFAULT 'pending';
            -- The base fixture IDs share a prefix; give them distinct legacy handles
            -- before exercising the repository's first-16-characters migration.
            ALTER TABLE public.profiles ADD COLUMN username text;
            UPDATE public.profiles SET username='rep_' || right(replace(id::text,'-',''),16)
              WHERE role::text='rep';
        """)
        for name in ["unique_usernames.sql", "lock_usernames.sql"]:
            cls.sql((ROOT / "supabase" / name).read_text())
        # Exercise the actual profile RPCs/triggers; storage itself is outside this test.
        profile_sql = (ROOT / "supabase/profile_and_name_requests.sql").read_text()
        cls.sql(profile_sql.split("INSERT INTO storage.buckets")[0])
        cls.sql((ROOT / "supabase/setup-push-notifications.sql").read_text())
        cls.sql("""
            GRANT INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
            GRANT SELECT, INSERT, UPDATE, DELETE ON public.goods TO authenticated;
            GRANT SELECT, INSERT ON public.notifications TO authenticated;
            -- Reproduce the reported policies, then leave additional broad policies
            -- behind to prove restrictive boundaries cannot be bypassed by OR.
            CREATE POLICY "Enable update for admin" ON public.profiles
                FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
            CREATE POLICY "Enable update for admin" ON public.goods
                FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
            CREATE POLICY "Allow insert goods for authenticated" ON public.goods
                FOR INSERT TO authenticated WITH CHECK (true);
            CREATE POLICY fixture_other_profile_allow_all ON public.profiles
                FOR ALL TO authenticated USING (true) WITH CHECK (true);
            CREATE POLICY fixture_other_goods_allow_all ON public.goods
                FOR ALL TO authenticated USING (true) WITH CHECK (true);
            CREATE FUNCTION public.fixture_legacy_set_role(p_target uuid) RETURNS void
                LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
                UPDATE public.profiles SET role='admin',status='approved' WHERE id=p_target;
            $$;
            GRANT EXECUTE ON FUNCTION public.fixture_legacy_set_role(uuid) TO authenticated;
            GRANT USAGE ON SCHEMA public TO service_role;
            GRANT SELECT, UPDATE ON public.profiles TO service_role;
        """)
        cls.baseline_escalation = cls.sql(f"""BEGIN; SET LOCAL ROLE authenticated;
            SET LOCAL request.jwt.claim.sub='{atomic.REP}';
            UPDATE public.profiles SET role='admin',status='approved',permissions='{{}}'::jsonb
              WHERE id='{atomic.REP}';
            SELECT role::text FROM public.profiles WHERE id='{atomic.REP}'; ROLLBACK;""").stdout.strip()
        cls.baseline_goods_insert = cls.sql(f"""BEGIN; SET LOCAL ROLE authenticated;
            SET LOCAL request.jwt.claim.sub='{atomic.REP}';
            INSERT INTO public.goods(title,asking_price,created_by)
            VALUES ('Legacy unauthorized insertion',100,'{atomic.REP}') RETURNING title;
            ROLLBACK;""").stdout.strip()
        cls.rls_migration = (ROOT / "supabase/harden_profiles_goods_rls.sql").read_text()
        cls.sql(cls.rls_migration)

    def as_user(self, query, actor=atomic.REP, role="authenticated", check=False):
        identity = f"SET LOCAL request.jwt.claim.sub='{actor}';" if actor else ""
        return self.sql(f"BEGIN; SET LOCAL ROLE {role}; {identity} {query} COMMIT;", check=check)

    def profile_authority(self, uid=atomic.REP):
        return self.sql(f"SELECT id,role,status,permissions FROM public.profiles WHERE id='{uid}';").stdout

    def assert_denied(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("42501", result.stderr)

    def new_user(self):
        uid = str(uuid.uuid4())
        self.sql(f"INSERT INTO auth.users(id) VALUES ('{uid}');")
        return uid

    def registration_sql(self, uid, role="rep", status="pending", permissions='{"can_add_inquiry":true}'):
        return f"""INSERT INTO public.profiles(id,full_name,role,status,permissions,username,username_locked,rep_code)
            VALUES ('{uid}','New representative','{role}','{status}','{permissions}'::jsonb,
                    'rep_{uuid.UUID(uid).hex[:12]}',true,'{uid}')
            ON CONFLICT(id) DO UPDATE SET full_name=EXCLUDED.full_name,
              role=EXCLUDED.role,status=EXCLUDED.status,permissions=EXCLUDED.permissions,
              username=EXCLUDED.username,username_locked=EXCLUDED.username_locked,rep_code=EXCLUDED.rep_code;"""

    def test_rls_rep_cannot_change_any_authority_field(self):
        before = self.profile_authority()
        for assignment in ["role='admin'", "status='approved'", "status='banned'",
                           "permissions='{}'::jsonb", "permissions=NULL",
                           "permissions=permissions || '{\"can_manage_users\":true}'::jsonb",
                           "role='admin',status='approved',permissions='{}'::jsonb",
                           f"id='{uuid.uuid4()}'"]:
            with self.subTest(assignment=assignment):
                # status='approved' alone would be a no-op for the approved rep.
                actor = atomic.PENDING if assignment == "status='approved'" else atomic.REP
                original = self.profile_authority(actor)
                self.assert_denied(self.as_user(f"UPDATE public.profiles SET {assignment} WHERE id='{actor}';", actor=actor))
                self.assertEqual(self.profile_authority(actor), original)
        self.assertEqual(self.profile_authority(), before)

    def test_rls_rep_cannot_update_or_delete_other_profiles(self):
        before = self.profile_authority(atomic.ADMIN)
        for query in [f"UPDATE public.profiles SET permissions='{{}}'::jsonb WHERE id='{atomic.ADMIN}';",
                      f"DELETE FROM public.profiles WHERE id='{atomic.REP}';"]:
            self.as_user(query, check=True)  # RLS can safely affect zero rows.
        self.assertEqual(self.profile_authority(atomic.ADMIN), before)
        self.assertTrue(self.profile_authority())

    def test_rls_registration_and_same_payload_upsert_work(self):
        uid = self.new_user()
        query = self.registration_sql(uid)
        self.as_user(query, actor=uid, check=True)
        self.as_user(query, actor=uid, check=True)
        self.assertIn("rep|pending|", self.profile_authority(uid))
        self.assertIn('"can_add_inquiry": true', self.profile_authority(uid))

    def test_rls_auth_signup_trigger_without_jwt_ignores_privileged_metadata(self):
        self.sql("""
            CREATE ROLE supabase_auth_admin NOLOGIN;
            GRANT USAGE ON SCHEMA auth TO supabase_auth_admin;
            GRANT INSERT ON auth.users TO supabase_auth_admin;
            ALTER TABLE auth.users ADD COLUMN raw_user_meta_data jsonb;
            CREATE FUNCTION public.fixture_auth_signup() RETURNS trigger
            LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
            BEGIN
              INSERT INTO public.profiles(id,full_name,role,status,permissions)
              VALUES (NEW.id,'Auth signup',
                (NEW.raw_user_meta_data->>'role')::public.app_role,
                NEW.raw_user_meta_data->>'status',NEW.raw_user_meta_data->'permissions');
              RETURN NEW;
            END; $$;
            CREATE TRIGGER fixture_auth_signup AFTER INSERT ON auth.users
              FOR EACH ROW EXECUTE FUNCTION public.fixture_auth_signup();
        """)
        uid = str(uuid.uuid4())
        try:
            self.as_user(f"""INSERT INTO auth.users(id,raw_user_meta_data)
              VALUES ('{uid}','{{"role":"admin","status":"approved","permissions":{{"is_admin":true}}}}');""",
                         actor=None, role="supabase_auth_admin", check=True)
            authority = self.profile_authority(uid)
            self.assertIn("rep|pending|", authority)
            self.assertIn('"can_add_inquiry": true', authority)
            self.assertNotIn('"is_admin"', authority)
        finally:
            self.sql("DROP TRIGGER fixture_auth_signup ON auth.users; DROP FUNCTION public.fixture_auth_signup();")

    def test_rls_registration_rejects_privilege_injection(self):
        for values in [dict(role="admin"), dict(status="approved"),
                       dict(permissions='{}'), dict(permissions='{"can_add_inquiry":true,"is_admin":true}')]:
            with self.subTest(values=values):
                uid = self.new_user()
                self.assert_denied(self.as_user(self.registration_sql(uid, **values), actor=uid))
                self.assertEqual(self.profile_authority(uid), "")

    def test_rls_registration_cannot_impersonate_another_user(self):
        uid = self.new_user()
        self.assert_denied(self.as_user(self.registration_sql(uid)))
        self.assertEqual(self.profile_authority(uid), "")

    def test_rls_existing_approved_rep_cannot_upsert_back_to_pending(self):
        before = self.profile_authority()
        self.assert_denied(self.as_user(self.registration_sql(atomic.REP)))
        self.assertEqual(self.profile_authority(), before)

    def test_rls_anonymous_cannot_create_profile_or_goods(self):
        uid = self.new_user()
        self.assert_denied(self.as_user(self.registration_sql(uid), actor=None, role="anon"))
        self.assert_denied(self.as_user("INSERT INTO public.goods(title,asking_price) VALUES ('No',100);", actor=None, role="anon"))

    def test_rls_only_active_admin_can_insert_goods(self):
        query = f"INSERT INTO public.goods(title,asking_price,created_by) VALUES ('Admin good',100,'{atomic.ADMIN}');"
        for actor in [atomic.REP, atomic.RESTRICTED, atomic.PENDING, atomic.BANNED,
                      atomic.REMOVED, atomic.INACTIVE_ADMIN]:
            with self.subTest(actor=actor):
                self.assert_denied(self.as_user(query, actor=actor))
        self.as_user(query, actor=atomic.ADMIN, check=True)
        self.assert_denied(self.as_user(
            f"INSERT INTO public.goods(title,asking_price,created_by) VALUES ('Wrong creator',100,'{atomic.REP}');",
            actor=atomic.ADMIN))

    def test_rls_rep_cannot_modify_or_delete_goods(self):
        self.as_user(f"UPDATE public.goods SET asking_price=1 WHERE id='{self.good}';", check=True)
        self.as_user(f"DELETE FROM public.goods WHERE id='{self.good}';", check=True)
        self.assertEqual(self.sql(f"SELECT asking_price FROM public.goods WHERE id='{self.good}';").stdout.strip(), "1000")
        self.as_user(f"UPDATE public.goods SET asking_price=900 WHERE id='{self.good}';", actor=atomic.ADMIN, check=True)
        self.assertEqual(self.sql(f"SELECT asking_price FROM public.goods WHERE id='{self.good}';").stdout.strip(), "900")

    def test_rls_active_reps_can_read_goods_but_pending_and_banned_cannot(self):
        for actor in [atomic.ADMIN, atomic.REP, atomic.RESTRICTED]:
            self.assertEqual(self.as_user(f"SELECT count(*) FROM public.goods WHERE id='{self.good}';", actor=actor, check=True).stdout.strip(), "1")
        for actor in [atomic.PENDING, atomic.BANNED, atomic.REMOVED, atomic.INACTIVE_ADMIN]:
            self.assertEqual(self.as_user(f"SELECT count(*) FROM public.goods WHERE id='{self.good}';", actor=actor, check=True).stdout.strip(), "0")

    def test_rls_profile_reads_preserve_self_and_admin_management(self):
        self.assertEqual(self.as_user(f"SELECT count(*) FROM public.profiles WHERE id='{atomic.REP}';", check=True).stdout.strip(), "1")
        self.assertEqual(self.as_user(f"SELECT count(*) FROM public.profiles WHERE id='{atomic.ADMIN}';", check=True).stdout.strip(), "0")
        self.assertEqual(self.as_user(f"SELECT count(*) FROM public.profiles WHERE id='{atomic.REP}';", actor=atomic.ADMIN, check=True).stdout.strip(), "1")

    def test_rls_admin_can_approve_restrict_ban_and_promote(self):
        uid = self.new_user()
        self.as_user(self.registration_sql(uid), actor=uid, check=True)
        for assignment in ["status='approved'", "status='restricted',permissions='{\"can_add_inquiry\":false}'::jsonb",
                           "status='banned'", "status='approved'", "role='admin'"]:
            self.as_user(f"UPDATE public.profiles SET {assignment} WHERE id='{uid}';", actor=atomic.ADMIN, check=True)
        self.assertIn("admin|approved|", self.profile_authority(uid))

    def test_rls_legacy_security_definer_cannot_elevate_rep(self):
        before = self.profile_authority()
        self.assert_denied(self.as_user(f"SELECT public.fixture_legacy_set_role('{atomic.REP}');"))
        self.assertEqual(self.profile_authority(), before)

    def test_rls_forged_jwt_role_text_does_not_bypass_guard(self):
        self.assert_denied(self.as_user(f"""SET LOCAL request.jwt.claim.role='service_role';
            SELECT public.fixture_legacy_set_role('{atomic.REP}');"""))
        self.assert_denied(self.as_user("SELECT public.rls_is_trusted_backend();"))

    def test_rls_existing_avatar_and_name_change_rpcs_work(self):
        self.as_user("SELECT public.set_my_avatar_url('https://example.invalid/avatar.jpg');", check=True)
        self.assertEqual(self.sql(f"SELECT avatar_url FROM public.profiles WHERE id='{atomic.REP}';").stdout.strip(), "https://example.invalid/avatar.jpg")
        self.as_user("SELECT public.request_my_name_change('Approved display name');", check=True)
        request_id = self.sql(f"SELECT id FROM public.name_change_requests WHERE rep_id='{atomic.REP}' AND status='pending';").stdout.strip()
        self.as_user(f"SELECT public.review_name_change_request('{request_id}',true);", actor=atomic.ADMIN, check=True)
        self.assertEqual(self.sql(f"SELECT full_name FROM public.profiles WHERE id='{atomic.REP}';").stdout.strip(), "Approved display name")

    def test_rls_existing_username_claim_rpc_works(self):
        self.as_user("SELECT public.set_my_username_once('rls_test_handle');", actor=atomic.RESTRICTED, check=True)
        self.assertEqual(self.sql(f"SELECT username FROM public.profiles WHERE id='{atomic.RESTRICTED}';").stdout.strip(), "rls_test_handle")

    def test_rls_admin_goods_insert_still_creates_notifications(self):
        good = str(uuid.uuid4())
        self.as_user(f"INSERT INTO public.goods(id,title,asking_price,created_by) VALUES ('{good}','Notify reps',100,'{atomic.ADMIN}');",
                     actor=atomic.ADMIN, check=True)
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.notifications WHERE metadata->>'goods_id'='{good}' AND category='new_goods';").stdout.strip(), "2")

    def test_rls_push_subscription_and_admin_announcements_work(self):
        self.as_user(f"""INSERT INTO public.push_subscriptions(user_id,endpoint,subscription)
          VALUES ('{atomic.REP}','https://example.invalid/push','{{}}');
          UPDATE public.push_subscriptions SET updated_at=now() WHERE user_id='{atomic.REP}';""", check=True)
        query = f"INSERT INTO public.notifications(recipient_id,created_by,title,body,category) VALUES ('{atomic.REP}','{atomic.ADMIN}','Update','Test','app_update');"
        self.as_user(query, actor=atomic.ADMIN, check=True)
        self.assert_denied(self.as_user(query))

    def test_rls_backend_presence_path_is_preserved(self):
        self.sql("ALTER TABLE public.profiles ADD COLUMN online boolean DEFAULT false;")
        self.as_user(f"UPDATE public.profiles SET online=true WHERE id='{atomic.REP}';", actor=atomic.REP, role="service_role", check=True)
        self.assertEqual(self.sql(f"SELECT online FROM public.profiles WHERE id='{atomic.REP}';").stdout.strip(), "t")

    def test_rls_named_bad_policies_removed_and_unknown_allow_all_is_capped(self):
        names = self.sql("SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename IN ('profiles','goods');").stdout
        self.assertNotIn("Enable update for admin", names)
        self.assertNotIn("Allow insert goods for authenticated", names)
        self.assertIn("fixture_other_profile_allow_all", names)
        self.assertIn("fixture_other_goods_allow_all", names)

    def test_rls_legacy_policy_fixture_reproduces_reported_vulnerabilities(self):
        self.assertEqual(self.baseline_escalation, "admin")
        self.assertEqual(self.baseline_goods_insert, "Legacy unauthorized insertion")

    def test_rls_migration_is_repeatable_and_does_not_modify_accounts(self):
        before = self.sql("SELECT row_to_json(p) FROM public.profiles p ORDER BY id;").stdout
        self.sql(self.rls_migration)
        self.assertEqual(self.sql("SELECT row_to_json(p) FROM public.profiles p ORDER BY id;").stdout, before)
        self.assertEqual(self.sql("SELECT has_table_privilege('authenticated','public.sales','INSERT');").stdout.strip(), "f")


if __name__ == "__main__":
    unittest.main()
