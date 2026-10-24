"""Explicitly approved, allowlisted Waseet-Test migrations; no production fallback.

plan is offline. check/apply/smoke require approval and a secure Management API
token. Never reads CLI links, database passwords, service-role keys or GitHub secrets.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / 'supabase/waseet-test.json'
PLAN = ROOT / '.local-database/waseet-test-plan.json'
PRODUCTION_REF = 'auqxdtbvfonzrlilygjg'
API = 'https://api.supabase.com'
TOKEN_NAME = 'WASEET_TEST_MANAGEMENT_TOKEN'


class SafetyError(RuntimeError):
    pass


def project_ref_from_url(value):
    if not isinstance(value, str) or any(char.isspace() for char in value):
        raise SafetyError('A verified project URL without whitespace is required; never guess the ref')
    url = urllib.parse.urlsplit(value)
    if url.scheme != 'https' or url.username or url.password or url.query or url.fragment:
        raise SafetyError('Use a credential-free HTTPS Supabase project URL')
    if url.netloc == 'supabase.com':
        match = re.fullmatch(r'/dashboard/project/([a-z]{20})(?:/[a-zA-Z0-9/_-]*)?', url.path)
    else:
        match = re.fullmatch(r'([a-z]{20})\.supabase\.co', url.netloc) if url.path in ('','/') else None
    if not match:
        raise SafetyError('Unsupported project URL or invalid project reference')
    ref = match.group(1)
    if ref == PRODUCTION_REF:
        raise SafetyError('The original Waseet project is explicitly forbidden')
    return ref


def validate_policy(policy):
    ref = project_ref_from_url(policy.get('project_url'))
    if policy.get('project_name') != 'Waseet-Test' or policy.get('project_ref') != ref:
        raise SafetyError('The reviewed Waseet-Test name, URL and ref must match exactly')
    return ref


def make_plan(policy, directory=ROOT/'supabase/migrations'):
    ref = validate_policy(policy)
    migrations = []
    for path in sorted(directory.glob('*.sql')):
        match = re.fullmatch(r'(\d{14})_([a-z0-9_]+)\.sql', path.name)
        if not match or path.is_symlink() or path.resolve().parent != directory.resolve():
            raise SafetyError('Unexpected migration filename or symlink')
        migrations.append({'version':match.group(1), 'name':match.group(2),
                           'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    if not migrations or len({m['version'] for m in migrations}) != len(migrations):
        raise SafetyError('Missing migrations or duplicate versions')
    plan = {'project_name':'Waseet-Test', 'project_ref':ref,
            'project_url':policy['project_url'], 'migrations':migrations}
    digest = hashlib.sha256(json.dumps(plan,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {**plan, 'plan_sha256':digest}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SafetyError('Management API redirects are forbidden')


class ManagementClient:
    def __init__(self, ref, token):
        if not re.fullmatch('[a-z]{20}',ref) or ref == PRODUCTION_REF:
            raise SafetyError('Forbidden hosted target')
        if not isinstance(token,str) or not token or any(ord(char)<33 or ord(char)>126 for char in token):
            raise SafetyError('Invalid secure Management API binding')
        self.ref, self.token = ref, token
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, suffix='', body=None):
        # Origin and path prefix are fixed; credentials never enter URLs or files.
        if suffix not in ('','/database/query'):
            raise SafetyError('Unsupported Management API operation')
        request = urllib.request.Request(API+'/v1/projects/'+self.ref+suffix,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization':'Bearer '+self.token, 'Content-Type':'application/json'})
        try:
            with self.opener.open(request,timeout=90) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            # Never dump response bodies, headers, SQL payloads or tokens.
            raise SafetyError(f'Management API refused the request: HTTP {error.code}') from None
        except (urllib.error.URLError,TimeoutError,OSError,ValueError):
            raise SafetyError('Management API connection failed; no automatic retry was attempted') from None

    def verify_identity(self):
        project = self.request()
        if not isinstance(project,dict) or project.get('ref') != self.ref or project.get('name') != 'Waseet-Test':
            raise SafetyError('Hosted project identity does not match the allowlist')
        if project.get('status') != 'ACTIVE_HEALTHY':
            raise SafetyError('Waseet-Test is not ACTIVE_HEALTHY; no lifecycle changes are allowed')

    def query(self, sql, read_only=True):
        return self.request('/database/query', {'query':sql, 'read_only':read_only})


def row(result):
    if not isinstance(result,list) or len(result) != 1 or not isinstance(result[0],dict):
        raise SafetyError('Unexpected Management API result; stop for review')
    return result[0]


def inventory(client):
    state = row(client.query("""SELECT
      ARRAY(SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n
        ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname) AS public_tables,
      to_regclass('waseet_test_ops.history') IS NOT NULL AS managed,
      to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS cli_history;"""))
    state['hashes'] = {}
    if not isinstance(state.get('managed'),bool) or not isinstance(state.get('cli_history'),bool) \
       or not isinstance(state.get('public_tables'),list) or not all(isinstance(t,str) for t in state['public_tables']):
        raise SafetyError('Unexpected schema inventory format')
    if state['managed']:
        target = row(client.query('SELECT project_ref FROM waseet_test_ops.target WHERE id=true;'))
        if target['project_ref'] != client.ref:
            raise SafetyError('Database migration identity belongs to another project')
        rows = client.query('SELECT version,sha256 FROM waseet_test_ops.history ORDER BY version;')
        if not isinstance(rows,list):
            raise SafetyError('Unexpected migration history')
        state['hashes'] = {r['version']:r['sha256'] for r in rows}
    state['versions'] = []
    if state['cli_history']:
        rows = client.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;')
        if not isinstance(rows,list):
            raise SafetyError('Unexpected CLI migration history')
        state['versions'] = [r['version'] for r in rows]
    return state


def pending_migrations(plan, state):
    expected = {m['version']:m['sha256'] for m in plan['migrations']}
    hashes = state['hashes']
    if state['versions'] != sorted(hashes):
        raise SafetyError('Unmanaged or inconsistent migration history; automatic adoption/repair is forbidden')
    if any(v not in expected or expected[v] != sha for v,sha in hashes.items()):
        raise SafetyError('Unknown versions or migration hash drift')
    if list(expected)[:len(hashes)] != sorted(hashes):
        raise SafetyError('Non-prefix migration history; stop for review')
    if not hashes and state['public_tables']:
        raise SafetyError('Fresh baseline requires an empty public schema; no reset or overwrite is allowed')
    return [m for m in plan['migrations'] if m['version'] not in hashes]


def migration_sql(path):
    text = path.read_text()
    # Standalone reviewed files use outer BEGIN/COMMIT. One enclosing DO statement
    # supplies the transaction for the whole hosted batch, without nested commits.
    controls = re.findall(r'(?m)^(BEGIN|COMMIT|ROLLBACK);\s*$',text)
    if controls:
        if controls != ['BEGIN','COMMIT'] or not re.search(r'COMMIT;\s*\Z',text):
            raise SafetyError('Unsupported transaction controls in migration')
        text = re.sub(r'(?m)^BEGIN;[ \t]*\n','',text,count=1)
        text = re.sub(r'COMMIT;\s*\Z','',text)
    if re.search(r'(?m)^\\',text):
        raise SafetyError('psql metacommands are not accepted')
    return text


def build_apply_sql(plan, state, directory=ROOT/'supabase/migrations'):
    validate_policy(plan)
    pending = pending_migrations(plan,state)
    if not pending:
        return None
    hashes = json.dumps(state['hashes'],sort_keys=True)
    versions = json.dumps(state['versions'])
    parts = ["""DO $waseet_apply$ BEGIN
      IF NOT pg_try_advisory_xact_lock(19780426,7001) THEN
        RAISE EXCEPTION 'Another Waseet-Test migration is running';
      END IF;
      CREATE SCHEMA IF NOT EXISTS waseet_test_ops;
      REVOKE ALL ON SCHEMA waseet_test_ops FROM PUBLIC,anon,authenticated,service_role;
      CREATE TABLE IF NOT EXISTS waseet_test_ops.target(id boolean PRIMARY KEY CHECK(id),project_ref text NOT NULL);
      CREATE TABLE IF NOT EXISTS waseet_test_ops.history(version text PRIMARY KEY,sha256 text NOT NULL);
      REVOKE ALL ON ALL TABLES IN SCHEMA waseet_test_ops FROM PUBLIC,anon,authenticated,service_role;
      CREATE SCHEMA IF NOT EXISTS supabase_migrations;
      CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY,statements text[],name text);
    """, f"""
      INSERT INTO waseet_test_ops.target VALUES(true,'{plan['project_ref']}') ON CONFLICT DO NOTHING;
      IF (SELECT project_ref FROM waseet_test_ops.target WHERE id=true) <> '{plan['project_ref']}' THEN
        RAISE EXCEPTION 'Target identity changed';
      END IF;
      IF (SELECT coalesce(jsonb_object_agg(version,sha256),'{{}}'::jsonb) FROM waseet_test_ops.history) <> '{hashes}'::jsonb
        OR (SELECT coalesce(jsonb_agg(version ORDER BY version),'[]'::jsonb) FROM supabase_migrations.schema_migrations) <> '{versions}'::jsonb THEN
        RAISE EXCEPTION 'Migration state changed; produce a new plan';
      END IF;
    """]
    if not state['hashes']:
        parts.append("""IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p')) THEN
          RAISE EXCEPTION 'Public schema is not empty'; END IF;""")
    for migration in pending:
        path = directory / (migration['version']+'_'+migration['name']+'.sql')
        if hashlib.sha256(path.read_bytes()).hexdigest() != migration['sha256']:
            raise SafetyError('Migration changed after planning')
        sql = migration_sql(path).encode().hex()
        parts.append(f"""EXECUTE convert_from(decode('{sql}','hex'),'UTF8');
          INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
            VALUES('{migration['version']}','{migration['name']}',ARRAY[convert_from(decode('{sql}','hex'),'UTF8')]);
          INSERT INTO waseet_test_ops.history VALUES('{migration['version']}','{migration['sha256']}');""")
    parts.append('END $waseet_apply$;')
    return '\n'.join(parts)


def hosted_operation(command, policy, saved_plan, approve, plan_sha=None, environ=None, factory=ManagementClient):
    if command not in ('check','apply','smoke'):
        raise SafetyError('Unsupported hosted operation')
    current = make_plan(policy)
    if saved_plan != current:
        raise SafetyError('Saved plan does not match the reviewed target and current migrations')
    if approve != current['project_ref']:
        raise SafetyError('Explicit target approval is required BEFORE any hosted request')
    if command == 'apply' and plan_sha != current['plan_sha256']:
        raise SafetyError('Explicit approval of this exact plan SHA-256 is required')
    token = (os.environ if environ is None else environ).get(TOKEN_NAME,'')
    if not token or token.startswith(('sb_secret_','sb_publishable_','eyJ')):
        raise SafetyError('Secure WASEET_TEST_MANAGEMENT_TOKEN binding required; never use database passwords or API keys')
    client = factory(current['project_ref'],token)
    client.verify_identity()  # GET identity must succeed before even read-only SQL.
    state = inventory(client)
    pending = pending_migrations(current,state)
    if command == 'apply':
        sql = build_apply_sql(current,state)
        if sql:
            client.query(sql,read_only=False)  # One atomic DO; never automatically retry.
        state = inventory(client)
        if pending_migrations(current,state):
            raise SafetyError('Hosted outcome is not confirmed; check history before any retry')
    elif command == 'smoke':
        if pending:
            raise SafetyError('Smoke test requires a completely applied, matching migration history')
        result = row(client.query("""SELECT
          (SELECT count(*)=4 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname IN ('profiles','goods','sales','notifications') AND c.relrowsecurity) AS rls,
          to_regprocedure('public.record_sale(uuid,uuid,numeric,numeric,numeric)') IS NOT NULL AS rpc,
          NOT has_table_privilege('authenticated','public.sales','INSERT') AS no_direct_sales_insert,
          EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.profiles'::regclass AND tgname='a_guard_profile_authority' AND tgenabled='O') AS authority_guard,
          (SELECT count(*)=2 FROM pg_policy WHERE NOT polpermissive
            AND ((polrelid='public.profiles'::regclass AND polname='profiles_update_boundary')
              OR (polrelid='public.goods'::regclass AND polname='goods_insert_boundary'))) AS restrictive_boundaries;"""))
        if not all(result.get(key) is True for key in ['rls','rpc','no_direct_sales_insert','authority_guard','restrictive_boundaries']):
            raise SafetyError('Hosted schema smoke test failed')
    return {'project_name':'Waseet-Test','project_ref':current['project_ref'],
            'operation':command,'pending_migrations':len(pending_migrations(current,state))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['plan','check','apply','smoke'])
    parser.add_argument('--approve',help='Explicitly approve contacting this exact test project ref')
    parser.add_argument('--plan-sha',help='Explicitly approve applying this exact offline plan')
    args = parser.parse_args()
    policy = json.loads(POLICY.read_text())
    if args.command == 'plan':
        plan = make_plan(policy)
        PLAN.parent.mkdir(parents=True,exist_ok=True)
        PLAN.write_text(json.dumps(plan,indent=2)+'\n')
        print(json.dumps({**plan,'hosted_requests':0},indent=2))
    else:
        if not PLAN.is_file():
            raise SafetyError('Generate and review the offline plan first')
        print(json.dumps(hosted_operation(args.command,policy,json.loads(PLAN.read_text()),args.approve,args.plan_sha)))


if __name__ == '__main__':
    try:
        main()
    except (SafetyError,ValueError,OSError) as error:
        # Only controlled validation messages; never print request/response bodies.
        raise SystemExit(str(error))
