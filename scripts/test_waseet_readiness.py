"""Offline tests; no real credentials or hosted requests."""
import io
import json
import unittest
import urllib.error
from unittest.mock import Mock, patch

import waseet_readiness as audit
from test_waseet_test import POLICY, REF
from waseet_test import SafetyError, TOKEN_NAME


class ReadinessTests(unittest.TestCase):
    def test_missing_token_or_wrong_approval_prevents_client_creation(self):
        factory=Mock()
        for approve,env in [(REF,{}),('wrong',{TOKEN_NAME:'offline-fixture'})]:
            with self.assertRaises(SafetyError):audit.run(POLICY,approve,env,factory)
        factory.assert_not_called()

    def test_identity_failure_prevents_all_other_requests(self):
        client=Mock();client.verify_identity.side_effect=SafetyError('Identity mismatch')
        with self.assertRaises(SafetyError):
            audit.run(POLICY,REF,{TOKEN_NAME:'offline-fixture'},Mock(return_value=client))
        client.request.assert_not_called();client.query.assert_not_called()

    def test_metadata_and_query_paths_are_strictly_read_only(self):
        client=audit.ReadOnlyClient(REF,'offline-fixture');client.opener=Mock()
        for suffix,body in [('/database/backups',{}),('/config/auth',{}),('/restore',None),
                            ('/database/query',{'query':'SELECT 1','read_only':False})]:
            with self.assertRaises(SafetyError):client.request(suffix,body)
        with self.assertRaises(SafetyError):client.query('SELECT 1',read_only=False)
        client.opener.open.assert_not_called()

    def test_permission_error_exposes_only_scope(self):
        client=audit.ReadOnlyClient(REF,'offline-fixture');client.opener=Mock()
        error=urllib.error.HTTPError('https://api.supabase.com',403,'Forbidden',{},
            io.BytesIO(json.dumps({'message':'Missing required permission(s): database_read',
                                  'other':'offline-fixture'}).encode()))
        client.opener.open.side_effect=error
        with self.assertRaises(SafetyError) as caught:client.query('SELECT 1')
        self.assertIn('database_read',str(caught.exception))
        self.assertNotIn('offline-fixture',str(caught.exception))

    def test_arbitrary_error_body_is_not_disclosed(self):
        client=audit.ReadOnlyClient(REF,'offline-fixture');client.opener=Mock()
        client.opener.open.side_effect=urllib.error.HTTPError('https://api.supabase.com',403,'Forbidden',{},
            io.BytesIO(b'{"message":"offline-fixture is a secret"}'))
        with self.assertRaises(SafetyError) as caught:client.request('/config/auth')
        self.assertEqual(str(caught.exception),'Management API HTTP 403')

    def test_backup_list_never_proves_restoration(self):
        for backups in [[],[{'status':'COMPLETED','sensitive':'not printed'}]]:
            summary=audit.backup_summary({'backups':backups,'pitr_enabled':False})
            self.assertEqual(summary['listed_backups'],len(backups))
            self.assertFalse(summary['restoration_verified'])
            self.assertNotIn('sensitive',str(summary))
        with self.assertRaises(SafetyError):audit.backup_summary({})

    def test_independent_scope_failures_are_collected_without_auth_secrets(self):
        client=Mock()
        client.request.side_effect=[{'backups':[]},{'smtp_pass':'never expose'}]
        with patch.object(audit,'audit_database',side_effect=SafetyError('Missing database_read')):
            report=audit.run(POLICY,REF,{TOKEN_NAME:'offline-fixture'},Mock(return_value=client))
        self.assertTrue(report['metadata']['auth']['readable'])
        self.assertIn('database_read',report['database']['error'])
        self.assertFalse(report['release_ready'])
        self.assertNotIn('never expose',str(report))

    def test_request_uses_fixed_api_origin_no_redirect_transport_and_explicit_read_only(self):
        client=audit.ReadOnlyClient(REF,'offline-fixture')
        response=Mock();response.read.return_value=b'[]'
        response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        client.opener=Mock();client.opener.open.return_value=response
        client.query('SELECT 1')
        request=client.opener.open.call_args.args[0]
        self.assertEqual(request.full_url,'https://api.supabase.com/v1/projects/'+REF+'/database/query')
        self.assertIs(json.loads(request.data)['read_only'],True)
        self.assertNotIn('offline-fixture',request.full_url)


if __name__=='__main__':unittest.main()
