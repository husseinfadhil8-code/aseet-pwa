"""Application-data restore rehearsal in networkless PostgreSQL only.

Not a Supabase platform backup: excludes GoTrue credentials, Storage binaries,
Edge functions and hosted settings. Never accepts a hosted connection or token.
"""
import json
from pathlib import Path
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

if __name__=='__main__':unittest.main()
