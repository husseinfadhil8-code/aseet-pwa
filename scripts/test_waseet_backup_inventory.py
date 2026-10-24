"""Backup preflight safety: count only, complete visibility, strict identifiers."""
import unittest
from unittest.mock import Mock

from waseet_backup_inventory import inspect_backup_source
from waseet_test import SafetyError


class BackupInventoryTests(unittest.TestCase):
    def client(self, relations, counts=None, visible=True):
        client = Mock()
        client.query.side_effect = [[{'relations':relations,'full_row_visibility':visible}],
                                    [counts or {}]]
        return client

    def test_counts_only_with_quoted_catalog_identifiers_and_no_backup_claim(self):
        client = self.client([{'schema':'public','table':'odd"; SELECT secret;--','selectable':True}], {'c0':4})
        report = inspect_backup_source(client)
        self.assertEqual(report['relations'][0]['rows'],4)
        query = client.query.call_args_list[1].args[0]
        self.assertIn('FROM "public"."odd""; SELECT secret;--"',query)
        self.assertNotIn('SELECT *',query)
        self.assertFalse(report['backup_created'])
        self.assertFalse(report['restoration_verified'])

    def test_rls_filtered_counts_cannot_be_reported_as_complete(self):
        client = self.client([], visible=False)
        with self.assertRaises(SafetyError):inspect_backup_source(client)
        self.assertEqual(client.query.call_count,1)

    def test_inaccessible_relation_is_explicitly_unknown_not_empty(self):
        client = self.client([{'schema':'auth','table':'users','selectable':False}])
        self.assertIsNone(inspect_backup_source(client)['relations'][0]['rows'])
        self.assertEqual(client.query.call_count,1)

    def test_unexpected_schema_and_invalid_counts_fail_closed(self):
        for relation, counts in [({'schema':'private','table':'x','selectable':True},{'c0':0}),
                                 ({'schema':'public','table':'x','selectable':True},{'c0':True})]:
            with self.assertRaises(SafetyError):inspect_backup_source(self.client([relation],counts))


if __name__ == '__main__':unittest.main()
