"""Networkless security checks; never export a real database."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from backup import manual_test_backup as b


class ManualBackupSafetyTests(unittest.TestCase):
    def url(self, user=None, host=None, query=''):
        return f'postgresql://{user or "postgres."+b.TEST_REF}:private-password@{host or b.TEST_HOST}:5432/postgres'+query

    def test_production_arbitrary_hosts_and_libpq_overrides_are_rejected(self):
        for value in (self.url(user='postgres.auqxdtbvfonzrlilygjg'),
                      self.url(host='db.auqxdtbvfonzrlilygjg.supabase.co'),
                      self.url(query='?host=evil.invalid'),self.url(query='?sslmode=disable'),
                      self.url(query='?options=-c%20default_transaction_read_only=off'),
                      'private-placeholder',self.url()+'#private'):
            with self.assertRaises(b.BackupError) as result:
                b.source_config(value)
            self.assertNotIn('private',str(result.exception))

    def test_reserved_password_delimiters_cannot_change_destination(self):
        from urllib.parse import quote
        password='fixture?hash#brackets[]at@colon:end'
        for encoded in (password,quote(password,safe='')):
            value='postgresql://postgres.'+b.TEST_REF+':'+encoded+'@'+b.TEST_HOST+':5432/postgres?sslmode=require'
            config=b.source_config(value)
            self.assertEqual(config['password'],password)
            self.assertEqual(config['host'],b.TEST_HOST)
            self.assertEqual(config['sslmode'],'verify-full')
        with self.assertRaises(b.BackupError):
            b.source_config(self.url()+'?host=evil.invalid')
        with self.assertRaises(b.BackupError):
            b.source_config(self.url().replace('private-password','bad%0Avalue'))

    def test_diagnostics_name_rejected_fields_without_revealing_values(self):
        with self.assertRaises(b.BackupError) as result:
            b.source_config(self.url(host='private-host.invalid',user='private-user'))
        self.assertIn('HOST,TEST_USER', str(result.exception))
        self.assertNotIn('private-host', str(result.exception))
        self.assertNotIn('private-user', str(result.exception))
        self.assertNotIn('private-password', str(result.exception))

    def test_session_pooler_is_exactly_pinned_and_tls_cannot_be_downgraded(self):
        config=b.source_config(self.url(query='?sslmode=require'))
        self.assertEqual(config['sslmode'],'verify-full')
        self.assertEqual(config['user'],'postgres.'+b.TEST_REF)
        self.assertIn('default_transaction_read_only=on',config['options'])

    def test_database_diagnostics_emit_codes_without_server_or_secret_text(self):
        error=RuntimeError('private-row private-password certificate verify failed')
        self.assertEqual(b.safe_error_code(error),'TLS_VERIFY_FAILED')
        error.pgcode='42501'
        self.assertEqual(b.safe_error_code(error),'SQLSTATE_42501')
        self.assertEqual(b.safe_error_code(stderr=b'private-row permission denied for private-table'),'PERMISSION_DENIED')

    def test_supabase_ca_is_pinned_and_modified_roots_are_rejected(self):
        self.assertEqual(b.file_hash(b.SOURCE_CA_CERT),b.SOURCE_CA_SHA256)
        with tempfile.TemporaryDirectory() as root:
            bad=Path(root)/'ca.crt';bad.write_text('untrusted fixture')
            with patch.object(b,'SOURCE_CA_CERT',bad),self.assertRaises(b.BackupError):
                b.source_config(self.url())

    def test_dump_client_receives_the_same_database_ca_without_secret_arguments(self):
        with tempfile.TemporaryDirectory() as root:
            backup=b.Backup(root)
            config=b.source_config(self.url())
            with patch.object(backup,'docker',return_value=b'client') as docker:
                backup.client(config)
            self.assertEqual(b.file_hash(backup.config/'roots.crt'),b.SOURCE_CA_SHA256)
            self.assertIn('sslrootcert=/config/roots.crt',(backup.config/'service.conf').read_text())
            self.assertNotIn('private-password',str(docker.call_args))

    def test_restore_permission_diagnostics_are_bounded(self):
        for text, code in [('permission denied to grant role private-role','ROLE_GRANT_AUTHORITY'),
                           ('must be member of role private-role','ROLE_MEMBERSHIP_REQUIRED'),
                           ('could not open input file private-path: Permission denied','RESTORE_INPUT_ACCESS'),
                           ('permission denied for schema private-schema','SCHEMA_ACCESS'),
                           ('permission denied to change owner of event trigger private-name','EVENT_TRIGGER_OWNERSHIP')]:
            result=b.safe_error_code(stderr=text.encode())
            self.assertEqual(result,code)
            self.assertNotIn('private',result)

    def test_schema_diagnostics_never_expose_sql_values(self):
        with tempfile.TemporaryDirectory() as root:
            left=Path(root)/'left';right=Path(root)/'right'
            left.write_text("CREATE SCHEMA private_source;")
            right.write_text("CREATE SCHEMA private_target;")
            code=b.schema_difference_code(left,right)
            self.assertIn('missing:CreateSchemaStmt=1',code)
            self.assertNotIn('private',code)
            right.write_text('-- changed header\n'+chr(92)+'connect postgres\nCREATE SCHEMA private_source;')
            self.assertEqual(b.schema_difference_code(left,right),'STATEMENT_ORDER_OR_FORMAT_ONLY')

    def test_role_restore_preserves_bootstrap_attributes_and_quoted_sql(self):
        from pglast import ast, parse_sql
        name='أساس إدارة'
        text='\n'.join(['-- header',chr(92)+'restrict ABC123',
                       f'CREATE ROLE "{name}";',
                       f'ALTER ROLE "{name}" WITH SUPERUSER;',
                       'CREATE ROLE other;',
                       f"""COMMENT ON ROLE other IS 'CREATE ROLE "{name}"; محفوظ';""",
                       chr(92)+'unrestrict ABC123'])+'\n'
        restored=b.restore_role_sql(text,name)
        roles=[x.stmt.role for x in parse_sql(restored) if isinstance(x.stmt,ast.CreateRoleStmt)]
        self.assertEqual(roles,['other'])
        self.assertIn('ALTER ROLE "'+name+'" WITH SUPERUSER;',restored)
        self.assertIn('محفوظ',restored)
        self.assertIn('COMMENT ON ROLE other',restored)

    def test_role_restore_rejects_missing_duplicate_or_mismatched_bootstrap_guards(self):
        for text in ('CREATE ROLE other;', 'CREATE ROLE root; CREATE ROLE root;',
                     chr(92)+'restrict AAA\nCREATE ROLE root;\n'+chr(92)+'unrestrict BBB\n'):
            with self.assertRaises(b.BackupError):b.restore_role_sql(text,'root')

    def test_restore_image_cannot_be_an_unreviewed_repository_or_mutable_tag(self):
        for image in ('evil/image@sha256:'+'a'*64,'supabase/postgres:latest','postgres:17'):
            with self.assertRaises(b.BackupError):b.restore_image(image)

    @patch.object(b.subprocess,'run',return_value=subprocess.CompletedProcess([],1,b'private-row',b'private-password'))
    def test_process_errors_never_surface_raw_credentials_or_rows(self, runner):
        with self.assertRaises(b.BackupError) as result:b.run(['fake'])
        self.assertNotIn('private-password',str(result.exception))
        self.assertNotIn('private-row',str(result.exception))

    def test_backup_refuses_nonmanual_or_nonmain_execution_before_connecting(self):
        with tempfile.TemporaryDirectory() as root:
            output=Path(root)/'artifact'
            with patch.dict(os.environ,{'GITHUB_EVENT_NAME':'push','GITHUB_REF':'refs/heads/main','GITHUB_REPOSITORY':b.REPOSITORY},clear=True), patch.object(b,'connection') as connect, patch.object(b.sys,'argv',['backup','backup','--confirm',b.TEST_REF,'--output',str(output)]), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(b.main(),1)
                connect.assert_not_called()
                self.assertFalse(output.exists())

    def test_check_needs_no_passphrase_and_cannot_start_an_export(self):
        with tempfile.TemporaryDirectory() as root:
            output=Path(root)/'check'
            conn=MagicMock();cursor=conn.cursor.return_value.__enter__.return_value
            cursor.fetchone.side_effect=[(170011,'on',True),None]
            cursor.fetchall.return_value=[(b.TEST_REF,)]
            capture=io.StringIO()
            with patch.dict(os.environ,{'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':'refs/heads/main','GITHUB_REPOSITORY':b.REPOSITORY,'WASEET_TEST_DATABASE_URL':self.url()},clear=True),patch.object(b,'connection',return_value=conn),patch.object(b.Backup,'export_verify') as export,patch.object(b.sys,'argv',['check','check','--confirm',b.TEST_REF,'--output',str(output)]),contextlib.redirect_stdout(capture):
                self.assertEqual(b.main(),0)
            export.assert_not_called()
            conn.close.assert_called_once()
            self.assertFalse(output.exists())
            self.assertIn('"export_started": false',capture.getvalue())
            self.assertNotIn('private-password',capture.getvalue())

    def test_existing_output_is_preserved_on_preflight_failure(self):
        with tempfile.TemporaryDirectory() as root:
            output=Path(root)/'artifact';output.mkdir();(output/'keep').write_text('untouched')
            with patch.object(b.sys,'argv',['backup','backup','--output',str(output)]), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                b.main()
            self.assertEqual((output/'keep').read_text(),'untouched')

    def test_failure_removes_ciphertext_and_does_not_print_internal_error(self):
        with tempfile.TemporaryDirectory() as root:
            output=Path(root)/'artifact'
            def failed(*args,**kwargs):
                output.mkdir();(output/'partial.gpg').write_bytes(b'partial')
                raise RuntimeError('private-password private-row')
            error=io.StringIO()
            with patch.dict(os.environ,{'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':'refs/heads/main','GITHUB_REPOSITORY':b.REPOSITORY,'WASEET_TEST_DATABASE_URL':self.url(),'WASEET_BACKUP_PASSPHRASE':'x'*32},clear=True),patch.object(b.Backup,'export_verify',side_effect=failed),patch.object(b.Backup,'cleanup'),patch.object(b.sys,'argv',['backup','backup','--confirm',b.TEST_REF,'--output',str(output)]),contextlib.redirect_stderr(error):
                self.assertEqual(b.main(),1)
            self.assertNotIn('private',error.getvalue())
            self.assertFalse(output.exists())

    def test_workflow_has_only_manual_trigger_and_only_ciphertext_paths(self):
        workflow=(Path(__file__).resolve().parents[1]/'.github/workflows/manual-waseet-test-backup.yml').read_text()
        self.assertNotIn('schedule:',workflow)
        self.assertNotIn('pull_request:',workflow)
        self.assertNotIn('\n  push:',workflow)
        self.assertIn('workflow_dispatch:',workflow)
        self.assertIn('persist-credentials: false',workflow)
        self.assertIn('contents: read',workflow)
        artifact=workflow.split('name: Upload verified ciphertext only',1)[1].split('- name:',1)[0]
        self.assertNotIn('database.dump',artifact)
        self.assertNotIn('roles.sql',artifact)
        self.assertIn('Waseet-Test.postgres.tar.gpg',artifact)
