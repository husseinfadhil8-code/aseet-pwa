"""Application-data restore rehearsal in networkless PostgreSQL only.

Not a Supabase platform backup: excludes GoTrue credentials, Storage binaries,
Edge functions and hosted settings. Never accepts a hosted connection or token.
"""
import json
import hashlib
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from local_database import LocalDatabase
from integration_waseet_test import DockerOnlyClient, POLICY, REF
import waseet_test as staging

TABLES=['profiles','goods','inquiries','external_listings','external_listing_claims',
        'name_change_requests','push_subscriptions','sales','sale_goods_registry',
        'notifications','chat_conversations','chat_members','chat_messages']

def first_five(database):
    client=DockerOnlyClient(database,REF)
    plan=staging.make_plan(POLICY)
    baseline=dict(plan,migrations=plan['migrations'][:5])
    client.query(staging.build_apply_sql(baseline,staging.inventory(client)),read_only=False)
    return client,plan

def snapshot(database):
    result={}
    for table in TABLES:
        result[table]=json.loads(database.sql(
            f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM public.{table} t;").stdout)
    return result

def restore_rows(database, data):
    # Local trusted owner only. Disable application triggers to avoid regenerating
    # notifications/registry rows already present in the snapshot; keep FK checks.
    if set(data)!=set(TABLES):raise ValueError('Unexpected backup table set')
    parts=['BEGIN;']
    for table in TABLES:
        parts.append(f'ALTER TABLE public.{table} DISABLE TRIGGER USER;')
        for row in data[table]:
            value=json.dumps(row,ensure_ascii=False).encode().hex()
            parts.append(f"INSERT INTO public.{table} SELECT * FROM jsonb_populate_record(NULL::public.{table},convert_from(decode('{value}','hex'),'UTF8')::jsonb);")
        parts.append(f'ALTER TABLE public.{table} ENABLE TRIGGER USER;')
    parts.append('COMMIT;')
    database.sql('\n'.join(parts))

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.source=LocalDatabase().start();self.addCleanup(self.source.stop)
        self.target=LocalDatabase().start();self.addCleanup(self.target.stop)
        self.client,self.plan=first_five(self.source)
        self.restored,_=first_five(self.target)
        admin='10000000-0000-0000-0000-000000000001'
        rep='20000000-0000-0000-0000-000000000001'
        good='30000000-0000-0000-0000-000000000001'
        for db in [self.source,self.target]:
            db.sql(f"INSERT INTO auth.users(id) VALUES ('{admin}'),('{rep}');")
        self.source.sql(f"""INSERT INTO public.profiles(id,full_name,role,status) VALUES
          ('{admin}','Synthetic admin','admin','approved'),('{rep}','Synthetic rep','rep','approved');
          INSERT INTO public.goods(id,title,asking_price,created_by,owner_phone)
            VALUES ('{good}','Backup fixture',1000,'{admin}','07700000000');
          BEGIN;SET LOCAL request.jwt.claim.sub='{admin}';
          SELECT public.record_sale('{good}','{rep}',1000,100,60);COMMIT;
          INSERT INTO public.inquiries(goods_id,rep_id,buyer_name) VALUES ('{good}','{rep}','Synthetic buyer');
        """)
        group=self.source.sql(f"SET request.jwt.claim.sub='{rep}';SELECT public.ensure_chat_ready();").stdout.strip()
        self.source.sql(f"INSERT INTO public.chat_messages(conversation_id,sender_id,body) VALUES ('{group}','{rep}','Synthetic history');")
        self.backup=snapshot(self.source)
        restore_rows(self.target,self.backup)

    def test_restore_preserves_all_application_rows_and_initial_history(self):
        self.assertEqual(snapshot(self.target),self.backup)
        self.assertEqual(staging.inventory(self.client)['hashes'],staging.inventory(self.restored)['hashes'])
        self.assertGreater(len(self.backup['notifications']),0)
        self.assertEqual(len(self.backup['chat_messages']),1)
        self.assertEqual(len(self.backup['sales']),1)

    def test_restored_data_survives_exact_sixth_migration(self):
        state=staging.inventory(self.restored)
        self.assertEqual(len(staging.pending_migrations(self.plan,state)),1)
        self.restored.query(staging.build_apply_sql(self.plan,state),read_only=False)
        self.assertEqual(snapshot(self.target),self.backup)
        self.assertEqual(staging.pending_migrations(self.plan,staging.inventory(self.restored)),[])
        self.assertEqual(self.target.sql("SELECT has_column_privilege('authenticated','public.goods','owner_phone','SELECT');").stdout.strip(),'f')

    def test_custom_pg_dump_restores_schema_acl_auth_fixture_and_history_before_upgrade(self):
        # A real pg_dump/pg_restore archive, but still SYNTHETIC local source data.
        # No claim of a hosted backup or a working GoTrue/Storage service.
        self.source.validate(); self.target.validate()
        archive = subprocess.run(['docker','exec',self.source.name,'pg_dump','-U','postgres',
            '--format=custom','--dbname=postgres'], check=True, capture_output=True, timeout=60).stdout
        digest = hashlib.sha256(archive).hexdigest()
        self.assertTrue(archive.startswith(b'PGDMP'))
        self.assertEqual(len(digest),64)
        self.target.sql('CREATE DATABASE waseet_restore_rehearsal TEMPLATE template0;')
        restored = SimpleNamespace(sql=lambda query,check=True:self.target.sql(
            query,check=check,database='waseet_restore_rehearsal'))
        result = subprocess.run(['docker','exec','-i',self.target.name,'pg_restore','-U','postgres',
            '--exit-on-error','--single-transaction','--dbname=waseet_restore_rehearsal'],
            input=archive,capture_output=True,timeout=60)
        self.assertEqual(result.returncode,0,result.stderr.decode())
        self.assertEqual(snapshot(restored),self.backup)
        self.assertEqual(restored.sql('SELECT count(*) FROM auth.users;').stdout.strip(),'2')
        client = DockerOnlyClient(restored,REF)
        self.assertEqual(staging.inventory(client),staging.inventory(self.client))
        catalog = """SELECT n.nspname,c.relname,c.relrowsecurity,
          (SELECT string_agg(grantee::text||':'||privilege_type||':'||is_grantable::text,','
            ORDER BY grantee,privilege_type,is_grantable)
           FROM aclexplode(coalesce(c.relacl,acldefault(
             CASE WHEN c.relkind='S' THEN 'S'::\"char\" ELSE 'r'::\"char\" END,c.relowner))))
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('public','auth','storage','waseet_test_ops','supabase_migrations')
          AND c.relkind IN ('r','p','S') ORDER BY 1,2;"""
        self.assertEqual(restored.sql(catalog).stdout,self.source.sql(catalog).stdout)
        definitions = """SELECT 'function',n.nspname||'.'||p.oid::regprocedure::text,pg_get_functiondef(p.oid)
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname IN ('public','auth','storage','waseet_test_ops') AND p.prokind='f'
          UNION ALL SELECT 'policy',pol.polrelid::regclass::text||'.'||pol.polname,
            concat_ws('|',pol.polcmd::text,pol.polpermissive::text,
              ARRAY(SELECT CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid)::text END
                FROM unnest(pol.polroles) role_oid ORDER BY 1)::text,
              pg_get_expr(pol.polqual,pol.polrelid),pg_get_expr(pol.polwithcheck,pol.polrelid))
          FROM pg_policy pol
          UNION ALL SELECT 'constraint',con.conrelid::regclass::text||'.'||con.conname,pg_get_constraintdef(con.oid)
          FROM pg_constraint con JOIN pg_namespace n ON n.oid=con.connamespace
          WHERE n.nspname IN ('public','auth','storage','waseet_test_ops','supabase_migrations')
          UNION ALL SELECT 'trigger',t.tgrelid::regclass::text||'.'||t.tgname,pg_get_triggerdef(t.oid)
          FROM pg_trigger t WHERE NOT t.tgisinternal
          ORDER BY 1,2;"""
        self.assertEqual(restored.sql(definitions).stdout,self.source.sql(definitions).stdout)
        client.query(staging.build_apply_sql(self.plan,staging.inventory(client)),read_only=False)
        self.assertEqual(snapshot(restored),self.backup)
        import waseet_readiness as audit
        self.assertTrue(audit.audit_database(client,self.plan)['schema_checks_passed'])
        admin='10000000-0000-0000-0000-000000000001'
        rep='20000000-0000-0000-0000-000000000001'
        good='30000000-0000-0000-0000-000000000001'
        for actor,allowed in [(admin,True),(rep,False)]:
            result=restored.sql(f"BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='{actor}';"
                f"SELECT * FROM public.get_good_owner_contact('{good}');COMMIT;",check=False)
            self.assertEqual(result.returncode==0,allowed)

if __name__=='__main__':unittest.main()
