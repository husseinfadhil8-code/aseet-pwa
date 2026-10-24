"""Waseet-Test backup preflight: catalog metadata and counts only; never a backup.

No row values, Auth config values, object names, passwords or signed URLs leave
the server. Management database_read does not supply a pg_dump connection.
"""
import argparse
import json
import os

from waseet_readiness import ReadOnlyClient
from waseet_test import POLICY, TOKEN_NAME, SafetyError, row, validate_policy


SCHEMAS = ('public', 'auth', 'storage', 'supabase_migrations', 'waseet_test_ops')


def inspect_backup_source(client):
    metadata = row(client.query("""SELECT current_setting('server_version') AS postgres_version,
      current_setting('server_version_num')::integer AS postgres_version_num,
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS full_row_visibility,
      pg_database_size(current_database()) AS database_bytes,
      (SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,
        'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
        'selectable',has_table_privilege(c.oid,'SELECT')) ORDER BY n.nspname,c.relname)
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname IN ('public','auth','storage','supabase_migrations','waseet_test_ops')
         AND c.relkind IN ('r','p')) AS relations,
      (SELECT jsonb_agg(jsonb_build_object('name',extname,'version',extversion) ORDER BY extname)
       FROM pg_extension) AS extensions;"""))
    relations = metadata.get('relations')
    if metadata.get('full_row_visibility') is not True:
        raise SafetyError('Cannot establish complete row visibility for backup counts')
    if not isinstance(relations, list) or len(relations) > 500:
        raise SafetyError('Unexpected backup inventory; no export attempted')
    # Names come from catalogs, but are still validated and quoted as identifiers.
    counts = []
    for relation in relations:
        schema, table = relation.get('schema'), relation.get('table')
        if schema not in SCHEMAS or not isinstance(table, str) or not table or '\x00' in table:
            raise SafetyError('Unexpected backup relation name')
        if relation.get('selectable') is not True:
            relation['rows'] = None
            continue
        identifier = '"' + schema + '"."' + table.replace('"', '""') + '"'
        counts.append((relation, identifier))
    # One statement gives these counts a common snapshot. No table row contents.
    if counts:
        result = row(client.query('SELECT ' + ','.join(
            f'(SELECT count(*) FROM {identifier}) AS c{i}'
            for i, (_, identifier) in enumerate(counts)) + ';'))
        for i, (relation, _) in enumerate(counts):
            value = result.get(f'c{i}')
            if type(value) is not int or value < 0:
                raise SafetyError('Unexpected backup count format')
            relation['rows'] = value
    metadata.update(read_only=True, backup_created=False, restoration_verified=False,
                    storage_binaries_exported=False, auth_service_verified=False,
                    consistent_dump_available=False)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--approve', required=True)
    args = parser.parse_args()
    try:
        ref = validate_policy(json.loads(POLICY.read_text()))
        if args.approve != ref:
            raise SafetyError('Exact Waseet-Test approval is required')
        token = os.environ.get(TOKEN_NAME, '')
        if not token or token.startswith(('sb_secret_', 'sb_publishable_', 'eyJ')):
            raise SafetyError('Secure Management binding unavailable')
        client = ReadOnlyClient(ref, token)
        client.verify_identity()
        print(json.dumps(inspect_backup_source(client), ensure_ascii=False, indent=2))
    except (SafetyError, OSError, ValueError):
        parser.exit(1, 'Backup inventory failed; no backup or hosted writes performed\n')


if __name__ == '__main__':
    main()
