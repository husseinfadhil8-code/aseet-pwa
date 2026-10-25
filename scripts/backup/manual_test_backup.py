"""Manual Waseet-Test PostgreSQL export. All command errors and row data stay private."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
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
BOOTSTRAP = 'waseet_isolated_restore'
LABEL = 'dev.waseet.manual-backup'


class BackupError(Exception):
    pass


def source_config(value):
    try:
        p = urlsplit(value)
        q = parse_qs(p.query, strict_parsing=True)
        if (p.scheme not in ('postgres', 'postgresql') or p.hostname != TEST_HOST
                or (p.port or 5432) != 5432 or unquote(p.username or '') != 'postgres.' + TEST_REF
                or p.path != '/postgres' or p.fragment or not p.password
                or set(q) - {'sslmode'} or ('sslmode' in q and q['sslmode'] not in (['require'], ['verify-full']))):
            raise ValueError()
        password = unquote(p.password)
        if any(ord(c) < 32 for c in password):
            raise ValueError()
        return dict(host=TEST_HOST, port=5432, user='postgres.' + TEST_REF,
                    password=password, dbname='postgres', sslmode='verify-full',
                    sslrootcert='/etc/ssl/certs/ca-certificates.crt', connect_timeout=15,
                    options='-c default_transaction_read_only=on -c statement_timeout=300000')
    except (TypeError, ValueError):
        raise BackupError('Invalid or non-allowlisted Test connection; no network request made') from None


def restore_image(value):
    value = value or CLIENT_IMAGE
    if value != CLIENT_IMAGE and not re.fullmatch(r'supabase/postgres@sha256:[0-9a-f]{64}', value):
        raise BackupError('Restore image must be a digest-pinned official Supabase PostgreSQL image')
    return value


def run(args, *, output=None, data=None, timeout=600):
    try:
        result = subprocess.run(args, input=data, stdout=output or subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise BackupError('A private subprocess failed or timed out') from None
    if result.returncode:
        # Never print stderr: SQL errors, CLI diagnostics and GPG output can contain secrets.
        raise BackupError('A private subprocess failed; raw output intentionally withheld')
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


def inventory(conn):
    from psycopg2 import sql
    result = {'tables': [], 'sequences': [], 'roles': [], 'memberships': [], 'large_objects': []}
    with conn.cursor() as c:
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
        command = ('initdb -D /tmp/db -U ' + bootstrap + ' --auth-local=trust --auth-host=reject >/tmp/init.log 2>&1 && '
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
        # Password remains in a private service file, never a command argument.
        service.write_text('[source]\n' + '\n'.join(f'{k}={v}' for k,v in config.items() if k != 'password') + '\n')
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
        target, target_config = self.start_database(image, 'restore', BOOTSTRAP)
        self.docker('exec', target, 'psql','-X','-h','/socket','-U',BOOTSTRAP,'-d','template1',
                    '-v','ON_ERROR_STOP=1','-f','/restore/roles.sql')
        self.docker('exec', target, 'psql','-X','-h','/socket','-U',BOOTSTRAP,'-d','template1',
                    '-v','ON_ERROR_STOP=1','-c','DROP DATABASE postgres;')
        self.docker('exec', target, 'pg_restore','-h','/socket','-U',BOOTSTRAP,'-d','template1',
                    '--exit-on-error','--create','/restore/database.dump')
        restored = connection(target_config)
        try:
            if inventory(restored) != before:
                raise BackupError('Restored rows, sequences, roles, grants or large objects differ')
        finally:
            restored.close()
        with (self.restored/'restored-schema.sql').open('wb') as dest:
            self.docker('exec',target,'pg_dump','-h','/socket','-U',BOOTSTRAP,'--create','--schema-only','-d','postgres',output=dest)
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
    parser.add_argument('mode',choices=['backup','rehearsal'])
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
        if args.mode=='backup':
            if (args.confirm!=TEST_REF or os.environ.get('GITHUB_REPOSITORY')!=REPOSITORY
                    or os.environ.get('GITHUB_REF')!='refs/heads/main'
                    or os.environ.get('GITHUB_EVENT_NAME')!='workflow_dispatch'):
                raise BackupError('Real backup requires an explicit manual main-branch Test confirmation')
            config=source_config(os.environ.pop('WASEET_TEST_DATABASE_URL',''))
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
                              INSERT INTO public.items(label) VALUES('SYNTHETIC REHEARSAL ONLY');""",(TEST_REF,))
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
        detail = str(error) if isinstance(error, BackupError) else 'Database or tool error; raw details withheld'
        print('Backup stopped safely at '+(backup.stage if backup else 'preflight')+'. '+detail+'. No verified artifact is available.',file=sys.stderr)
        if output.exists():
            shutil.rmtree(output)
        return 1


if __name__=='__main__':
    raise SystemExit(main())
