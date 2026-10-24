"""Read-only Waseet-Test readiness audit. No secrets, row data, SQL writes or restore.

The existing apply tool remains separate. This command never applies migrations.
"""
import argparse
import json
import os
import re
import urllib.error
import urllib.request

from waseet_test import (API, TOKEN_NAME, POLICY, ManagementClient, SafetyError,
                         inventory, make_plan, pending_migrations, row, validate_policy)


class ReadOnlyClient(ManagementClient):
    def request(self, suffix='', body=None):
        if suffix not in ('', '/config/auth', '/database/backups', '/database/query'):
            raise SafetyError('Unsupported readiness endpoint')
        if suffix == '/database/query':
            if not isinstance(body, dict) or body.get('read_only') is not True:
                raise SafetyError('Readiness queries must be read-only')
        elif body is not None:
            raise SafetyError('Readiness metadata endpoints are GET-only')
        request = urllib.request.Request(API+'/v1/projects/'+self.ref+suffix,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization':'Bearer '+self.token, 'Content-Type':'application/json'})
        try:
            with self.opener.open(request, timeout=30) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            # Only expose a strictly matched permission identifier, never API bodies.
            scope = ''
            try:
                message = json.loads(error.read(4096)).get('message', '')
                match = re.fullmatch(r'Missing required permission\(s\): ([a-z_]+(?:, [a-z_]+)*)', message)
                if match:
                    scope = '; missing '+match.group(1)
            except (ValueError, TypeError, AttributeError):
                pass
            raise SafetyError(f'Management API HTTP {error.code}{scope}') from None
        except (OSError, ValueError):
            raise SafetyError('Readiness connection or response failure; no retry attempted') from None

    def query(self, sql, read_only=True):
        if read_only is not True:
            raise SafetyError('Readiness cannot execute writable SQL')
        return self.request('/database/query', {'query':sql, 'read_only':True})


def backup_summary(data):
    if not isinstance(data, dict) or not isinstance(data.get('backups'), list):
        raise SafetyError('Unexpected backup response; do not infer readiness')
    return {'listed_backups':len(data['backups']),
            'pitr_enabled':data.get('pitr_enabled') is True,
            'physical_backup_metadata_present':bool(data.get('physical_backup_data')),
            # Listing a backup does not prove that a restore was tested.
            'restoration_verified':False}


def audit_database(client, plan):
    state = inventory(client)
    pending = pending_migrations(plan, state)
    required = {'profiles', 'goods', 'sales', 'notifications'}
    if not required.issubset(state['public_tables']):
        raise SafetyError('Required application tables are missing; no baseline will be applied')
    checks = row(client.query("""SELECT
      NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity) AS public_rls,
      to_regprocedure('public.record_sale(uuid,uuid,numeric,numeric,numeric)') IS NOT NULL AS atomic_sale_rpc,
      NOT has_table_privilege('authenticated','public.sales','INSERT') AS no_direct_sale_insert,
      EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.profiles'::regclass
        AND tgname='a_guard_profile_authority' AND tgenabled='O') AS profile_authority_guard,
      (SELECT count(*)=2 FROM pg_policy WHERE NOT polpermissive
        AND ((polrelid='public.profiles'::regclass AND polname='profiles_update_boundary')
          OR (polrelid='public.goods'::regclass AND polname='goods_insert_boundary'))) AS restrictive_boundaries,
      NOT EXISTS(SELECT 1 FROM public.sales GROUP BY goods_id HAVING count(*)>1) AS no_duplicate_sales,
      NOT has_column_privilege('authenticated','public.goods','owner_phone','SELECT') AS owner_phone_private,
      jsonb_build_object('profiles',(SELECT count(*) FROM public.profiles),
        'goods',(SELECT count(*) FROM public.goods),'sales',(SELECT count(*) FROM public.sales),
        'notifications',(SELECT count(*) FROM public.notifications)) AS row_counts;"""))
    keys = ['public_rls','atomic_sale_rpc','no_direct_sale_insert','profile_authority_guard',
            'restrictive_boundaries','no_duplicate_sales','owner_phone_private']
    if any(not isinstance(checks.get(key), bool) for key in keys):
        raise SafetyError('Unexpected readiness check format')
    counts = checks.get('row_counts')
    if not isinstance(counts,dict) or set(counts) != required or any(type(n) is not int or n<0 for n in counts.values()):
        raise SafetyError('Unexpected row count format')
    return {'public_table_count':len(state['public_tables']),
            'applied_versions':state['versions'],
            'pending_versions':[m['version'] for m in pending], 'checks':checks,
            'schema_checks_passed':not pending and all(checks[key] for key in keys)}


def run(policy, approve, environ=None, factory=ReadOnlyClient):
    ref = validate_policy(policy)
    if approve != ref:
        raise SafetyError('Exact Waseet-Test approval is required before any request')
    token = (os.environ if environ is None else environ).get(TOKEN_NAME,'')
    if not token or token.startswith(('sb_secret_','sb_publishable_','eyJ')):
        raise SafetyError('Secure Management token binding is unavailable; no hosted requests made')
    client = factory(ref,token)
    client.verify_identity()
    report = {'project_ref':ref, 'project_name':'Waseet-Test','status':'ACTIVE_HEALTHY',
              'read_only':True, 'release_ready':False, 'metadata':{}}
    # Independent read-only failures are reported together instead of requesting
    # additional permissions one endpoint at a time across user turns.
    for name, endpoint in [('backups','/database/backups'),('auth','/config/auth')]:
        try:
            data = client.request(endpoint)
            if name == 'backups':
                report['metadata'][name] = backup_summary(data)
            else:
                if not isinstance(data,dict):raise SafetyError('Unexpected Auth response')
                report['metadata'][name] = {'readable':True}
        except SafetyError as error:
            report['metadata'][name] = {'error':str(error)}
    try:
        report['database'] = audit_database(client,make_plan(policy))
    except SafetyError as error:
        report['database'] = {'error':str(error)}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--approve', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(run(json.loads(POLICY.read_text()),args.approve),ensure_ascii=False,indent=2))
    except (SafetyError,OSError,ValueError) as error:
        # Never print arbitrary OS/JSON errors containing file or response contents.
        parser.exit(1, (str(error) if isinstance(error,SafetyError) else 'Readiness setup failed')+'\n')


if __name__ == '__main__':
    main()
