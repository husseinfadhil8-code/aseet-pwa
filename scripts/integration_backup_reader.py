"""Minimum export grants in networkless synthetic PostgreSQL; never a hosted backup."""
import json
from pathlib import Path
import subprocess
import unittest
from local_database import LocalDatabase
from integration_recovery import first_five
ROOT=Path(__file__).resolve().parents[1]
SCHEMAS=('public','auth','storage','supabase_migrations','waseet_test_ops')
class BackupReaderTests(unittest.TestCase):
    def setUp(self):
        self.db=LocalDatabase().start();self.addCleanup(self.db.stop)
        first_five(self.db)
        self.db.sql("""CREATE ROLE backup_reader LOGIN BYPASSRLS;
          GRANT CONNECT ON DATABASE postgres TO backup_reader;
          ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
          ALTER TABLE auth.users FORCE ROW LEVEL SECURITY;
          INSERT INTO auth.users(id) VALUES ('10000000-0000-0000-0000-000000000001');""")
        for schema in SCHEMAS:
            self.db.sql(f'GRANT USAGE ON SCHEMA {schema} TO backup_reader;'
                        f'GRANT SELECT ON ALL TABLES IN SCHEMA {schema} TO backup_reader;'
                        f'GRANT SELECT ON ALL SEQUENCES IN SCHEMA {schema} TO backup_reader;')
    def report(self):
        sql=(ROOT/'scripts/sql/backup_reader_preflight.sql').read_text()
        result=subprocess.run(['docker','exec','-i',self.db.name,'psql','-X','-qAt',
            '-U','backup_reader','-d','postgres','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True,check=True)
        return json.loads(result.stdout)
    def dump(self):
        self.db.validate()
        args=['docker','exec','-e','PGOPTIONS=-c default_transaction_read_only=on',
              self.db.name,'pg_dump','-U','backup_reader','-Fc','--dbname=postgres']
        for schema in SCHEMAS:args.extend(['--schema',schema])
        return subprocess.run(args,capture_output=True,timeout=60)
    def test_reader_exports_and_strictly_restores_auth_and_acl_without_write_grants(self):
        report=self.report()
        self.assertTrue(report['read_only']);self.assertTrue(report['full_rls_visibility'])
        for key in ('missing_schemas','missing_schema_usage','unreadable_relations'):
            self.assertEqual(report[key],[])
        for key in ('superuser','can_create_database','can_create_role'):
            self.assertFalse(report[key])
        archive=self.dump();self.assertEqual(archive.returncode,0,archive.stderr.decode())
        self.assertTrue(archive.stdout.startswith(b'PGDMP'))
        self.db.sql('CREATE DATABASE waseet_restore_rehearsal TEMPLATE template0;')
        # Scoped pg_dump emits CREATE SCHEMA public; remove only the empty
        # default schema in this newly created isolated target (never CASCADE).
        self.db.sql('DROP SCHEMA public;',database='waseet_restore_rehearsal')
        restored=subprocess.run(['docker','exec','-i',self.db.name,'pg_restore','-U','postgres',
            '--exit-on-error','--single-transaction','--dbname=waseet_restore_rehearsal'],
            input=archive.stdout,capture_output=True,timeout=60)
        self.assertEqual(restored.returncode,0,restored.stderr.decode())
        self.assertEqual(self.db.sql('SELECT count(*) FROM auth.users;',database='waseet_restore_rehearsal').stdout.strip(),'1')
        for database in ('postgres','waseet_restore_rehearsal'):
            self.assertEqual(self.db.sql("SELECT has_table_privilege('backup_reader','auth.users','SELECT');",database=database).stdout.strip(),'t')
            self.assertEqual(self.db.sql("SELECT has_table_privilege('backup_reader','auth.users','INSERT');",database=database).stdout.strip(),'f')
            self.assertEqual(self.db.sql("SELECT relforcerowsecurity FROM pg_class WHERE oid='auth.users'::regclass;",database=database).stdout.strip(),'t')
    def test_read_all_grants_without_bypass_do_not_export_rls_rows(self):
        self.db.sql('ALTER ROLE backup_reader NOBYPASSRLS;')
        self.assertFalse(self.report()['full_rls_visibility'])
        self.assertNotEqual(self.dump().returncode,0)
    def test_missing_auth_select_is_reported_and_dump_fails(self):
        self.db.sql('REVOKE SELECT ON auth.users FROM backup_reader;')
        missing=self.report()['unreadable_relations']
        self.assertTrue(any(x['schema']=='auth' and x['relation']=='users' for x in missing))
        self.assertNotEqual(self.dump().returncode,0)
if __name__=='__main__':unittest.main()
