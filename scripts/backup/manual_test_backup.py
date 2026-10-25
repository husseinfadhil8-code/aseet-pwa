"""Manual Waseet-Test PostgreSQL export. All command errors and row data stay private."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from urllib.parse import parse_qs, unquote, urlsplit

TEST_REF = 'beyrctbxojpuvhevfyok'
TEST_HOST = 'aws-0-ap-northeast-1.pooler.supabase.com'
REPOSITORY = 'husseinfadhil8-code/aseet-pwa'
CLIENT_IMAGE = 'postgres@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe'
SOURCE_CA_CERT = Path(__file__).with_name('supabase-prod-ca-2021.crt')
SOURCE_CA_SHA256 = '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7'
BOOTSTRAP = 'waseet_isolated_restore'
LABEL = 'dev.waseet.manual-backup'


class BackupError(Exception):
    pass


def trusted_source_ca():
    try:
        if hashlib.sha256(SOURCE_CA_CERT.read_bytes()).hexdigest() == SOURCE_CA_SHA256:
            return str(SOURCE_CA_CERT)
    except OSError:
        pass
    raise BackupError('Pinned Supabase CA unavailable or modified; TLS verification remains required')


def source_config(value):
    try:
        # Parse an exactly allowlisted authority before the general URL parser:
        # raw # ? [ ] or @ in a password must never be interpreted as a host,
        # URI fragment or libpq option. Destination and username stay fixed.
        exact = re.fullmatch(
            r'postgres(?:ql)?://postgres\.' + re.escape(TEST_REF) + r':(.+)@'
            + re.escape(TEST_HOST) + r'(?::5432)?/postgres(?:\?sslmode=(?:require|verify-full))?', value)
        if exact:
            password = unquote(exact.group(1))
            if not password or any(ord(c) < 32 for c in password):
                raise BackupError('Password contains unsupported control characters; no values disclosed')
            return dict(host=TEST_HOST, port=5432, user='postgres.' + TEST_REF,
                        password=password, dbname='postgres', sslmode='verify-full',
                        sslrootcert=trusted_source_ca(), connect_timeout=15,
                        options='-c default_transaction_read_only=on -c statement_timeout=300000')
        p = urlsplit(value)
        q = parse_qs(p.query, strict_parsing=True)
        checks = {
            'SCHEME': p.scheme in ('postgres', 'postgresql'),
            'HOST': p.hostname == TEST_HOST,
            'PORT': (p.port or 5432) == 5432,
            'TEST_USER': unquote(p.username or '') == 'postgres.' + TEST_REF,
            'DATABASE': p.path == '/postgres',
            'PASSWORD_PRESENT': bool(p.password),
            'NO_FRAGMENT': not p.fragment,
            'PARAMETERS': not (set(q) - {'sslmode'}) and ('sslmode' not in q or q['sslmode'] in (['require'], ['verify-full'])),
        }
        rejected = [key for key, valid in checks.items() if not valid]
        if rejected:
            raise BackupError('Connection fields rejected: ' + ','.join(rejected) + '; no values disclosed or network request made')
        password = unquote(p.password)
        if any(ord(c) < 32 for c in password):
            raise ValueError()
        return dict(host=TEST_HOST, port=5432, user='postgres.' + TEST_REF,
                    password=password, dbname='postgres', sslmode='verify-full',
                    sslrootcert=trusted_source_ca(), connect_timeout=15,
                    options='-c default_transaction_read_only=on -c statement_timeout=300000')
    except (TypeError, ValueError):
        raise BackupError('Invalid or non-allowlisted Test connection; no network request made') from None


def restore_image(value):
    value = value or CLIENT_IMAGE
    if value != CLIENT_IMAGE and not re.fullmatch(r'supabase/postgres@sha256:[0-9a-f]{64}', value):
        raise BackupError('Restore image must be a digest-pinned official Supabase PostgreSQL image')
    return value


def safe_error_code(error=None, stderr=b''):
    state = getattr(error, 'pgcode', None)
    if isinstance(state, str) and re.fullmatch(r'[0-9A-Z]{5}', state):
        return 'SQLSTATE_' + state
    text = (str(error) if error else stderr.decode(errors='replace')).lower()
    for marker, code in (
        ('certificate verify failed', 'TLS_VERIFY_FAILED'),
        ('password authentication failed', 'AUTHENTICATION_FAILED'),
        ('tenant or user not found', 'TEST_ROUTING_FAILED'),
        ('timeout expired', 'CONNECTION_TIMEOUT'),
        ('connection refused', 'CONNECTION_REFUSED'),
        ('could not translate host name', 'DNS_FAILED'),
        ('permission denied to grant role', 'ROLE_GRANT_AUTHORITY'),
        ('permission denied to grant privileges as role', 'ROLE_GRANTOR_AUTHORITY'),
        ('must be member of role', 'ROLE_MEMBERSHIP_REQUIRED'),
        ('permission denied to change owner of event trigger', 'EVENT_TRIGGER_OWNERSHIP'),
        ('permission denied to change owner', 'ROLE_OWNERSHIP'),
        ('could not open input file', 'RESTORE_INPUT_ACCESS'),
        ('permission denied for schema', 'SCHEMA_ACCESS'),
        ('permission denied', 'PERMISSION_DENIED'),
        ('extension', 'EXTENSION_RESTORE_CHECK_REQUIRED'),
    ):
        if marker in text:
            return code
    return 'UNCLASSIFIED_FAILURE'


def run(args, *, output=None, data=None, timeout=600):
    try:
        result = subprocess.run(args, input=data, stdout=output or subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise BackupError('A private subprocess failed or timed out') from None
    if result.returncode:
        # Never print stderr: SQL errors, CLI diagnostics and GPG output can contain secrets.
        raise BackupError('Tool failure ' + safe_error_code(stderr=result.stderr) + '; raw output withheld')
    return result.stdout if output is None else None


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


class Hasher:
    def __init__(self):
        self.hash = hashlib.sha256()
    def write(self, data):
        self.hash.update(data.encode() if isinstance(data, str) else data)


def connection(config):
    import psycopg2
    conn = psycopg2.connect(**config)
    conn.set_session(isolation_level='REPEATABLE READ', readonly=True)
    with conn.cursor() as cursor:
        cursor.execute("SET timezone='UTC'; SET datestyle='ISO, YMD'; SET extra_float_digits=3;")
    return conn


def verify_source_identity(source):
    with source.cursor() as c:
        c.execute("SELECT current_setting('server_version_num')::integer, current_setting('transaction_read_only'), (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user)")
        version, readonly, bypass = c.fetchone()
        if version // 10000 != 17 or readonly != 'on' or not bypass:
            raise BackupError('PostgreSQL 17 and complete read-only RLS visibility are required')
        c.execute('SELECT project_ref FROM waseet_test_ops.target WHERE id=true')
        if c.fetchall() != [(TEST_REF,)]:
            raise BackupError('Database Test identity marker mismatch; no export attempted')
        c.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (BOOTSTRAP,))
        if c.fetchone():
            raise BackupError('Restore bootstrap role collides with a source role')
    return version


def inventory(conn):
    from psycopg2 import sql
    result = {'tables': [], 'sequences': [], 'roles': [], 'memberships': [], 'large_objects': []}
    with conn.cursor() as c:
        c.execute('SELECT rolname FROM pg_roles WHERE oid=10')
        result['bootstrap_role']=c.fetchone()[0]
        c.execute('SELECT DISTINCT r.rolname COLLATE \"C\" FROM pg_event_trigger e JOIN pg_roles r ON r.oid=e.evtowner WHERE NOT r.rolsuper ORDER BY r.rolname COLLATE \"C\"')
        result['non_superuser_event_trigger_owners']=[r[0] for r in c.fetchall()]
        c.execute("""SELECT n.nspname,c.relname,c.relkind,c.relispopulated FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_'
          AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','m','S','f')
          ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"
""")
        relations = c.fetchall()
        if any(r[2] == 'f' for r in relations):
            raise BackupError('Foreign tables require a separately reviewed data export')
        for schema, table, kind, populated in relations:
            name = sql.Identifier(schema, table)
            if kind == 'S':
                c.execute(sql.SQL('SELECT last_value,is_called FROM {}').format(name))
                result['sequences'].append([schema, table, list(c.fetchone())])
            elif kind == 'm' and not populated:
                result['tables'].append([schema, table, 'unpopulated', None])
            else:
                c.execute(sql.SQL('SELECT count(*) FROM {}').format(name))
                count = c.fetchone()[0]
                sink = Hasher()
                query = sql.SQL('COPY (SELECT row_to_json(t)::text AS v FROM {} t ORDER BY row_to_json(t)::text COLLATE "C") TO STDOUT').format(name)
                c.copy_expert(query.as_string(conn), sink)
                result['tables'].append([schema, table, count, sink.hash.hexdigest()])
        c.execute("""SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
          rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,rolconfig
          FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> %s ORDER BY rolname COLLATE "C"
""", (BOOTSTRAP,))
        result['roles'] = [list(r) for r in c.fetchall()]
        c.execute("""SELECT a.rolname,b.rolname,CASE WHEN a.rolname ~ '^pg_' AND b.rolname ~ '^pg_' THEN '<initdb>' ELSE g.rolname END,m.admin_option,m.inherit_option,m.set_option
          FROM pg_auth_members m JOIN pg_roles a ON a.oid=m.roleid JOIN pg_roles b ON b.oid=m.member
          JOIN pg_roles g ON g.oid=m.grantor ORDER BY 1,2,3""")
        result['memberships'] = [list(r) for r in c.fetchall()]
        c.execute("""SELECT m.oid,r.rolname,m.lomacl::text,encode(sha256(lo_get(m.oid)),'hex')
          FROM pg_largeobject_metadata m JOIN pg_roles r ON r.oid=m.lomowner ORDER BY m.oid""")
        result['large_objects'] = [list(r) for r in c.fetchall()]
    return result


def restore_role_sql(text, bootstrap):
    """Skip exactly the pre-existing initdb role CREATE; preserve every other SQL statement."""
    from pglast import ast, parse_sql
    lines=text.splitlines(keepends=True)
    active=[i for i,line in enumerate(lines) if line.strip() and not line.lstrip().startswith('--')]
    if active and lines[active[0]].startswith('\\restrict '):
        key=lines[active[0]].strip().split(' ',1)[1]
        if not re.fullmatch(r'[A-Za-z0-9]+',key) or lines[active[-1]].strip()!='\\unrestrict '+key:
            raise BackupError('Invalid dump guard envelope')
        lines[active[0]]=lines[active[-1]]=''
    sql_text=''.join(lines)
    data=sql_text
    skipped=[]
    for raw in parse_sql(sql_text):
        if isinstance(raw.stmt,ast.CreateRoleStmt) and raw.stmt.role==bootstrap:
            end=raw.stmt_location+raw.stmt_len if raw.stmt_len else len(data)
            if data[end:end+1]==';':end+=1
            skipped.append((raw.stmt_location,end))
    if len(skipped)!=1:
        raise BackupError('Expected exactly one source bootstrap role declaration')
    start,end=skipped[0]
    return data[:start]+data[end:]


def canonical_schema(path):
    return '\n'.join(line for line in path.read_text().splitlines()
                     if line.strip() and not line.startswith(('--', '\\restrict ', '\\unrestrict ')))


class Backup:
    def __init__(self, root):
        self.root = Path(root)
        self.containers = []
        self.source = self.root / 'source'
        self.restored = self.root / 'restored'
        self.config = self.root / 'config'
        for folder in (self.source, self.restored, self.config):
            folder.mkdir(mode=0o700)
        self.stage = 'preflight'

    def docker(self, *args, **kwargs):
        return run(['docker', '--host=unix:///var/run/docker.sock', *args], **kwargs)

    def start_database(self, image, label, bootstrap):
        name = 'waseet-backup-' + label + '-' + uuid.uuid4().hex[:10]
        socket_dir = self.root / (label + '-socket')
        socket_dir.mkdir(mode=0o777)
        socket_dir.chmod(0o777)
        # No network, Docker socket, source credentials or host ports are exposed.
        self.containers.append(name)
        command = ('initdb -D /tmp/db -U ' + shlex.quote(bootstrap) + ' --auth-local=trust --auth-host=reject >/tmp/init.log 2>&1 && '
                   'exec postgres -D /tmp/db -k /socket -c listen_addresses= -c wal_level=logical '
                   '-c shared_preload_libraries= >/tmp/server.log 2>&1')
        self.docker('run', '-d', '--pull=never', '--name', name, '--label', LABEL,
                    '--network', 'none', '--user', 'postgres', '--cap-drop', 'ALL',
                    '--security-opt', 'no-new-privileges', '--read-only', '--pids-limit', '256',
                    '--memory', '4g', '--shm-size', '256m', '--tmpfs', '/tmp:rw,nosuid,size=4g',
                    '--mount', f'type=bind,src={socket_dir},dst=/socket',
                    '--mount', f'type=bind,src={self.restored},dst=/restore,readonly',
                    '--entrypoint', '/bin/bash', image, '-c', command)
        config = dict(host=str(socket_dir), user=bootstrap, dbname='postgres', connect_timeout=3)
        for _ in range(100):
            try:
                conn = connection(config)
                conn.close()
                return name, config
            except Exception:
                time.sleep(0.2)
        raise BackupError('Isolated PostgreSQL could not start')

    def client(self, config, rehearsal=False):
        name = 'waseet-backup-client-' + uuid.uuid4().hex[:10]
        service = self.config / 'service.conf'
        effective = dict(config)
        if config.get('sslmode') == 'verify-full':
            roots = self.config/'roots.crt'
            shutil.copyfile(config['sslrootcert'], roots)
            roots.chmod(0o600)
            effective['sslrootcert']='/config/roots.crt'
        # Password remains in a private service file, never a command argument.
        service.write_text('[source]\n' + '\n'.join(f'{k}={v}' for k,v in effective.items() if k != 'password') + '\n')
        passfile = self.config/'pgpass'
        escape = lambda value: str(value).replace('\\','\\\\').replace(':','\\:')
        passfile.write_text(':'.join(escape(config.get(k,'')) for k in ('host','port','dbname','user','password'))+'\n')
        passfile.chmod(0o600)
        service.chmod(0o600)
        args = ['run', '-d', '--pull=never', '--name', name, '--label', LABEL,
                '--network', 'none' if rehearsal else 'bridge',
                '--mount', f'type=bind,src={self.config},dst=/config,readonly',
                '--mount', 'type=bind,src=/etc/ssl/certs,dst=/etc/ssl/certs,readonly',
                '-e', 'PGSERVICEFILE=/config/service.conf', '-e', 'PGPASSFILE=/config/pgpass', '-e', 'PGSERVICE=source']
        if rehearsal:
            args.extend(['--mount', f'type=bind,src={config["host"]},dst={config["host"]}'])
        self.containers.append(name)
        self.docker(*args, CLIENT_IMAGE, 'sleep', 'infinity')
        return name

    def dump(self, client, path, snapshot=None, schema_only=False, roles=False):
        args = ['exec', client, 'pg_dumpall' if roles else 'pg_dump']
        if roles:
            args += ['--roles-only', '--no-role-passwords']
        else:
            args += ['--create', '--schema-only'] if schema_only else ['--create', '--format=custom']
            if snapshot:
                args += ['--snapshot', snapshot]
        with path.open('wb') as output:
            self.docker(*args, output=output)
        path.chmod(0o600)

    def export_verify(self, config, passphrase, output, image, rehearsal=False):
        self.stage = 'source identity and snapshot'
        source = connection(config)
        try:
            version=verify_source_identity(source)
            with source.cursor() as c:
                c.execute('SELECT pg_export_snapshot()')
                snapshot = c.fetchone()[0]
            with source.cursor() as c:
                c.execute('SELECT pg_database_size(current_database())')
                database_bytes = c.fetchone()[0]
                if database_bytes > 1024**3 or shutil.disk_usage(self.root).free < 6*database_bytes + 1024**3:
                    raise BackupError('Database exceeds the bounded free-runner rehearsal capacity')
            self.stage = 'full PostgreSQL dump'
            client = self.client(config, rehearsal)
            before = inventory(source)
            self.dump(client, self.source/'database.dump', snapshot)
            self.dump(client, self.source/'schema.sql', snapshot, schema_only=True)
            self.dump(client, self.source/'roles.sql', roles=True)
            from datetime import datetime, timezone
            manifest = dict(project_ref=TEST_REF, postgres_version_num=version,
                            exported_at_utc=datetime.now(timezone.utc).isoformat(),
                            inventory=before, storage_binaries_included=False,
                            role_passwords_included=False, actual_hosted_backup=not rehearsal,
                            snapshot_consistent_tables=True, global_roles_and_sequences_transactional=False)
            (self.source/'manifest.json').write_text(json.dumps(manifest,sort_keys=True))
        finally:
            source.close()
        self.stage = 'encrypt archive'
        archive = self.source/'backup.tar'
        with tarfile.open(archive, 'w') as tar:
            for name in ('database.dump','schema.sql','roles.sql','manifest.json'):
                tar.add(self.source/name, arcname=name)
        output = Path(output)
        output.mkdir(mode=0o700, parents=True, exist_ok=True)
        cipher = output/'Waseet-Test.postgres.tar.gpg'
        gnupg = self.root/'gnupg'
        gnupg.mkdir(mode=0o700)
        common = ['gpg','--homedir',str(gnupg),'--batch','--yes','--pinentry-mode','loopback',
                  '--no-symkey-cache','--passphrase-fd','0']
        run(common + ['--cipher-algo','AES256','--s2k-digest-algo','SHA512',
                      '--s2k-count','65011712','--compress-algo','none',
                      '--output',str(cipher),'--symmetric',str(archive)], data=(passphrase+'\n').encode())
        if cipher.stat().st_size > 100*1024**2:
            raise BackupError('Encrypted artifact exceeds the 100 MiB free-quota safety bound')
        self.stage = 'decrypt and isolated restore'
        decrypted = self.restored/'backup.tar'
        run(common + ['--output',str(decrypted),'--decrypt',str(cipher)], data=(passphrase+'\n').encode())
        if file_hash(archive) != file_hash(decrypted):
            raise BackupError('Encrypted archive round-trip mismatch')
        # Only our fixed four regular files may leave the decrypted tar.
        with tarfile.open(decrypted) as tar:
            members=tar.getmembers()
            if {m.name for m in members} != {'database.dump','schema.sql','roles.sql','manifest.json'} or len(members)!=4 or any(not m.isfile() for m in members):
                raise BackupError('Unsafe archive layout')
            tar.extractall(self.restored, filter='data')
        self.restored.chmod(0o755)
        for name in ('database.dump','schema.sql','roles.sql','manifest.json'):
            (self.restored/name).chmod(0o444)
        target, target_config = self.start_database(image, 'restore', before['bootstrap_role'])
        import psycopg2
        from psycopg2 import sql
        admin=psycopg2.connect(**target_config)
        with admin:
            with admin.cursor() as cursor:
                cursor.execute(sql.SQL('CREATE ROLE {} SUPERUSER LOGIN').format(sql.Identifier(BOOTSTRAP)))
        admin.close()
        target_config['user']=BOOTSTRAP
        prepared=self.restored/'roles-restore.sql'
        prepared.write_text(restore_role_sql((self.restored/'roles.sql').read_text(),before['bootstrap_role']))
        prepared.chmod(0o444)
        self.stage = 'isolated role restore'
        self.docker('exec', target, 'psql','-X','-h','/socket','-U',BOOTSTRAP,'-d','template1',
                    '-v','ON_ERROR_STOP=1','-f','/restore/roles-restore.sql')
        self.stage = 'isolated empty database preparation'
        self.docker('exec', target, 'psql','-X','-h','/socket','-U',BOOTSTRAP,'-d','template1',
                    '-v','ON_ERROR_STOP=1','-c','DROP DATABASE postgres;')
        # Hosted Supabase permits event triggers owned by non-superusers. Stock
        # ALTER EVENT TRIGGER OWNER requires the new owner to be a superuser.
        # Elevate only those isolated roles during restore, then restore attributes
        # before comparing the complete role inventory; never alter the source.
        self.stage = 'isolated event trigger owner preparation'
        admin=psycopg2.connect(**dict(target_config,dbname='template1'))
        with admin:
            with admin.cursor() as cursor:
                for role in before['non_superuser_event_trigger_owners']:
                    cursor.execute(sql.SQL('ALTER ROLE {} SUPERUSER').format(sql.Identifier(role)))
        admin.close()
        self.stage = 'isolated database restore'
        self.docker('exec', target, 'pg_restore','-h','/socket','-U',BOOTSTRAP,'-d','template1',
                    '--exit-on-error','--create','/restore/database.dump')
        self.stage = 'isolated role attribute restoration'
        admin=psycopg2.connect(**target_config)
        with admin:
            with admin.cursor() as cursor:
                for role in before['non_superuser_event_trigger_owners']:
                    cursor.execute(sql.SQL('ALTER ROLE {} NOSUPERUSER').format(sql.Identifier(role)))
        admin.close()
        self.stage = 'isolated inventory verification'
        restored = connection(target_config)
        try:
            if inventory(restored) != before:
                raise BackupError('Restored rows, sequences, roles, grants or large objects differ')
        finally:
            restored.close()
        self.stage = 'isolated schema verification'
        target_client=self.client(target_config,rehearsal=True)
        self.dump(target_client,self.restored/'restored-schema.sql',schema_only=True)
        if canonical_schema(self.restored/'schema.sql') != canonical_schema(self.restored/'restored-schema.sql'):
            raise BackupError('Restored schema, ownership, ACL, policies or settings differ')
        report = dict(project_ref=TEST_REF,actual_hosted_backup=not rehearsal,
                      isolated_postgres_restore_verified=True, source_tls_verified=not rehearsal,
                      storage_binaries_included=False,role_passwords_included=False,
                      client_image=CLIENT_IMAGE,restore_image=image,
                      workflow_commit=os.environ.get('GITHUB_SHA','local-rehearsal'))
        (output/'verification.json').write_text(json.dumps(report,sort_keys=True,indent=2)+'\n')
        (output/'SHA256SUMS').write_text(file_hash(cipher)+'  '+cipher.name+'\n')
        cipher.chmod(0o600)
        return report

    def cleanup(self):
        for name in reversed(self.containers):
            try:
                labels = json.loads(self.docker('inspect','--format','{{json .Config.Labels}}',name))
                if LABEL in labels:
                    self.docker('rm','-f','-v',name)
            except Exception:
                pass


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['backup','rehearsal','check'])
    parser.add_argument('--output',required=True)
    parser.add_argument('--confirm',default='')
    args=parser.parse_args()
    os.umask(0o077)
    output=Path(args.output).resolve()
    backup=None
    if output.exists():
        parser.exit(1, 'Output directory already exists; refusing to overwrite or delete it.\n')
    try:
        image=restore_image(os.environ.get('WASEET_TEST_RESTORE_IMAGE'))
        if args.mode in ('backup','check'):
            if (args.confirm!=TEST_REF or os.environ.get('GITHUB_REPOSITORY')!=REPOSITORY
                    or os.environ.get('GITHUB_REF')!='refs/heads/main'
                    or os.environ.get('GITHUB_EVENT_NAME')!='workflow_dispatch'):
                raise BackupError('Real backup requires an explicit manual main-branch Test confirmation')
            config=source_config(os.environ.pop('WASEET_TEST_DATABASE_URL',''))
            if args.mode=='check':
                source=connection(config)
                try:
                    verify_source_identity(source)
                finally:
                    source.close()
                print(json.dumps(dict(source_tls_verified=True,source_test_identity_verified=True,
                                      read_only=True,export_started=False,actual_hosted_backup=False)))
                return 0
            passphrase=os.environ.pop('WASEET_BACKUP_PASSPHRASE','')
            if len(passphrase)<24 or '\n' in passphrase or '\r' in passphrase:
                raise BackupError('A backup passphrase of at least 24 characters is required')
        with tempfile.TemporaryDirectory(prefix='waseet-backup-') as temp:
            backup=Backup(temp)
            try:
                if args.mode=='rehearsal':
                    _,config=backup.start_database(CLIENT_IMAGE,'fixture','postgres')
                    import psycopg2
                    conn=psycopg2.connect(**config)
                    with conn:
                        with conn.cursor() as c:
                            c.execute("""CREATE SCHEMA waseet_test_ops; CREATE TABLE waseet_test_ops.target(id boolean PRIMARY KEY,project_ref text NOT NULL);
                              INSERT INTO waseet_test_ops.target VALUES(true,%s);
                              CREATE ROLE fixture_reader NOLOGIN; CREATE SCHEMA auth;
                              CREATE TABLE auth.users(id integer PRIMARY KEY, value text);
                              INSERT INTO auth.users VALUES(1,'SYNTHETIC REHEARSAL ONLY');
                              ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY; ALTER TABLE auth.users FORCE ROW LEVEL SECURITY;
                              GRANT USAGE ON SCHEMA auth TO fixture_reader; GRANT SELECT ON auth.users TO fixture_reader;
                              CREATE POLICY rehearsal_policy ON auth.users FOR SELECT TO fixture_reader USING (true);
                              CREATE TABLE public.items(id bigserial PRIMARY KEY, label text);
                              INSERT INTO public.items(label) VALUES('SYNTHETIC REHEARSAL ONLY');
                              GRANT postgres TO fixture_reader WITH INHERIT FALSE;
                              CREATE FUNCTION public.rehearsal_ddl() RETURNS event_trigger LANGUAGE plpgsql AS 'BEGIN END';
                              CREATE EVENT TRIGGER rehearsal_ddl ON ddl_command_end EXECUTE FUNCTION public.rehearsal_ddl();
                              ALTER ROLE fixture_reader SUPERUSER;
                              ALTER EVENT TRIGGER rehearsal_ddl OWNER TO fixture_reader;
                              ALTER ROLE fixture_reader NOSUPERUSER;
""",(TEST_REF,))
                    conn.close()
                    config['options']='-c default_transaction_read_only=on'
                    passphrase='synthetic-rehearsal-only-not-a-real-secret'
                report=backup.export_verify(config,passphrase,output,image,args.mode=='rehearsal')
                print(json.dumps(report,sort_keys=True))
            finally:
                backup.cleanup()
        return 0
    except Exception as error:
        # No traceback, SQL, server messages, subprocess output or credential values.
        detail = str(error) if isinstance(error, BackupError) else 'Database error ' + safe_error_code(error) + '; raw details withheld'
        print('Backup stopped safely at '+(backup.stage if backup else 'preflight')+'. '+detail+'. No verified artifact is available.',file=sys.stderr)
        if output.exists():
            shutil.rmtree(output)
        return 1


if __name__=='__main__':
    raise SystemExit(main())
