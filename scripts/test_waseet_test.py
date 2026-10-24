"""Offline safety tests: no Supabase network requests or real credentials."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import waseet_test as staging

REF = 't'*20
POLICY = {'project_name':'Waseet-Test','project_ref':REF,
          'project_url':'https://supabase.com/dashboard/project/'+REF}


class WaseetTestSafetyTests(unittest.TestCase):
    def test_valid_dashboard_and_api_urls(self):
        self.assertEqual(staging.project_ref_from_url(POLICY['project_url']),REF)
        self.assertEqual(staging.project_ref_from_url(f'https://{REF}.supabase.co'),REF)

    def test_whitespace_production_and_unsafe_urls_rejected(self):
        values = [None,'https://supabase.com/dashboard/project/beyrctbxojpuvhevf yok',
            'https://supabase.com/dashboard/project/'+staging.PRODUCTION_REF,
            'https://'+staging.PRODUCTION_REF+'.supabase.co',
            'http://'+REF+'.supabase.co','https://attacker.invalid/dashboard/project/'+REF,
            'https://user:password@'+REF+'.supabase.co',POLICY['project_url']+'?token=do-not-log',
            'https://supabase.com:443/dashboard/project/'+REF,'https://'+REF+'.supabase.co.attacker.invalid']
        for value in values:
            with self.subTest(value=value):
                with self.assertRaises(staging.SafetyError):
                    staging.project_ref_from_url(value)

    def test_no_fallback_from_missing_or_mismatched_policy(self):
        for policy in [{},dict(POLICY,project_ref='x'*20),dict(POLICY,project_name='Production')]:
            with self.assertRaises(staging.SafetyError):
                staging.make_plan(policy)

    def test_offline_plan_is_stable(self):
        with patch('urllib.request.OpenerDirector.open',side_effect=AssertionError('Network forbidden')):
            plan = staging.make_plan(POLICY)
            self.assertEqual(plan,staging.make_plan(POLICY))
            self.assertEqual(len(plan['migrations']),5)

    def test_missing_approval_or_token_prevents_client_creation(self):
        plan = staging.make_plan(POLICY)
        cases = [('reset',REF,None,{}),('check',None,None,{}),('check',REF,None,{}),
                 ('apply',REF,'wrong',{staging.TOKEN_NAME:'offline-fixture'}),
                 ('check',staging.PRODUCTION_REF,None,{staging.TOKEN_NAME:'offline-fixture'}),
                 ('apply',REF,plan['plan_sha256'],{})]
        factory = Mock(side_effect=AssertionError('No hosted client should be created'))
        for command,approve,digest,env in cases:
            with self.subTest(command=command,approve=approve,digest=digest):
                with self.assertRaises(staging.SafetyError):
                    staging.hosted_operation(command,POLICY,plan,approve,digest,environ=env,factory=factory)
        factory.assert_not_called()

    def test_service_keys_and_jwts_are_not_management_tokens(self):
        plan = staging.make_plan(POLICY)
        factory = Mock()
        for token in ['sb_secret_offline','sb_publishable_offline','eyJnot-a-real-jwt']:
            with self.assertRaises(staging.SafetyError):
                staging.hosted_operation('check',POLICY,plan,REF,environ={staging.TOKEN_NAME:token},factory=factory)
        factory.assert_not_called()

    def test_changed_saved_plan_rejected_before_network(self):
        plan = staging.make_plan(POLICY)
        plan['migrations'][0]['sha256']='f'*64
        factory = Mock()
        with self.assertRaises(staging.SafetyError):
            staging.hosted_operation('check',POLICY,plan,REF,environ={staging.TOKEN_NAME:'offline-fixture'},factory=factory)
        factory.assert_not_called()

    def test_identity_must_match_before_sql(self):
        client = staging.ManagementClient(REF,'offline-fixture')
        client.request = Mock(return_value={'ref':REF,'name':'Other project','status':'ACTIVE_HEALTHY'})
        with self.assertRaises(staging.SafetyError):
            client.verify_identity()
        client.request.assert_called_once_with()

    def test_original_ref_and_control_char_token_never_reach_transport(self):
        for ref,token in [(staging.PRODUCTION_REF,'offline-fixture'),(REF,'private\nvalue')]:
            with self.assertRaises(staging.SafetyError) as context:
                staging.ManagementClient(ref,token)
            self.assertNotIn(token,str(context.exception))

    def test_redirects_are_never_followed(self):
        with self.assertRaises(staging.SafetyError):
            staging.NoRedirect().redirect_request(None,None,302,'','', 'https://attacker.invalid')

    def test_fixed_origin_token_in_header_only_read_only_explicit(self):
        client = staging.ManagementClient(REF,'offline-fixture')
        response = Mock()
        response.read.return_value=b'[]'
        response.__enter__=Mock(return_value=response)
        response.__exit__=Mock(return_value=False)
        client.opener=Mock()
        client.opener.open.return_value=response
        client.query('SELECT 1',read_only=True)
        request = client.opener.open.call_args.args[0]
        self.assertEqual(request.full_url,'https://api.supabase.com/v1/projects/'+REF+'/database/query')
        self.assertNotIn('offline-fixture',request.full_url)
        self.assertEqual(json.loads(request.data),{'query':'SELECT 1','read_only':True})

    def test_error_does_not_expose_token(self):
        client = staging.ManagementClient(REF,'offline-fixture')
        client.opener=Mock()
        client.opener.open.side_effect=ValueError('header contains offline-fixture')
        with self.assertRaises(staging.SafetyError) as context:
            client.request()
        self.assertNotIn('offline-fixture',str(context.exception))

    def test_inventory_uses_api_supported_text_array(self):
        for tables in [[], ['goods', 'profiles']]:
            with self.subTest(tables=tables):
                client = staging.ManagementClient(REF,'offline-fixture')
                def api_response(suffix, body):
                    self.assertEqual(suffix,'/database/query')
                    self.assertIs(body['read_only'],True)
                    # The hosted API returns name[] as a PostgreSQL array literal;
                    # text[] is decoded as JSON. Keep this wire-format difference.
                    value = tables if 'c.relname::text' in body['query'] else '{'+','.join(tables)+'}'
                    return [{'public_tables':value,'managed':False,'cli_history':False}]
                client.request = Mock(side_effect=api_response)
                state = staging.inventory(client)
                self.assertEqual(state['public_tables'],tables)
                client.request.assert_called_once()
                if tables:
                    with self.assertRaises(staging.SafetyError):
                        staging.pending_migrations(staging.make_plan(POLICY),state)

    def test_inventory_keeps_rejecting_ambiguous_or_malformed_arrays(self):
        for value in ['{}','{profiles}',None,{},[1],['profiles',None]]:
            with self.subTest(value=value):
                client = Mock()
                client.query.return_value = [{'public_tables':value,'managed':False,'cli_history':False}]
                with self.assertRaises(staging.SafetyError):
                    staging.inventory(client)

    def test_nonempty_unmanaged_drifted_and_nonprefix_states_blocked(self):
        plan = staging.make_plan(POLICY)
        a,b = plan['migrations'][:2]
        states = [dict(hashes={},versions=[],public_tables=['profiles']),
                  dict(hashes={},versions=[a['version']],public_tables=[]),
                  dict(hashes={a['version']:'bad'},versions=[a['version']],public_tables=[]),
                  dict(hashes={b['version']:b['sha256']},versions=[b['version']],public_tables=[])]
        for state in states:
            with self.assertRaises(staging.SafetyError):
                staging.build_apply_sql(plan,state)

    def test_transaction_wrappers_and_post_plan_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'20261024000100_example.sql'
            path.write_text('BEGIN;\nSELECT 1;\nCOMMIT;\n')
            self.assertEqual(staging.migration_sql(path),'SELECT 1;\n')
            plan = staging.make_plan(POLICY,Path(directory))
            path.write_text('SELECT 2;')
            with self.assertRaises(staging.SafetyError):
                staging.build_apply_sql(plan,dict(hashes={},versions=[],public_tables=[]),Path(directory))
            path.write_text('BEGIN;\nROLLBACK;\nCOMMIT;')
            with self.assertRaises(staging.SafetyError):
                staging.migration_sql(path)


if __name__=='__main__':
    unittest.main()
