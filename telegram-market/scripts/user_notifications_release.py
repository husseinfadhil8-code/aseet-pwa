"""Guarded incremental release for the owner's explicitly confirmed live project.

Backup writes ciphertext only. Rehearsal always rolls back. Apply requires a
successful same-SQL rehearsal and operator evidence that the live writer gate is
paused. No fixtures, business writes, historical fanout or Telegram sends occur.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from datetime import datetime, timezone
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from backup.manual_test_backup import (Backup, BackupError, Hasher, connection,
    file_hash, restore_image, safe_error_code, source_config, verify_source_identity)
from review.test_upgrade_rollback import fingerprint

REF = 'beyrctbxojpuvhevfyok'
REPOSITORY = 'husseinfadhil8-code/aseet-pwa'
BRANCH = 'refs/heads/feature/user-notifications'
WORKFLOW = '.github/workflows/manual-test-upgrade-rollback.yml'
SQL_FILES = ('013_user_notifications.sql', '014_support_replies.sql')
TABLES = ('tg_market_notify_ad_receipts', 'tg_market_support_replies')
RPCS = ('tg_market_notifications(bigint,text,jsonb,boolean,text)',
        'tg_market_notify_worker(text,jsonb)',
        'tg_market_notify_contacts(jsonb)',
        'tg_market_support_action(bigint,text,jsonb,boolean,text)')


def require_target():
    if (os.environ.get('GITHUB_REF') != BRANCH
            or os.environ.get('CONFIRM_TEST_REF') != REF
            or os.environ.get('GITHUB_REPOSITORY') != REPOSITORY
            or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'):
        raise BackupError('Confirmed production project and reviewed manual branch required')


def sql_bundle():
    from pglast import parse_sql
    texts = []
    digests = {}
    allowed = {'VariableSetStmt', 'AlterTableStmt', 'UpdateStmt', 'InsertStmt', 'CreateStmt',
               'IndexStmt', 'GrantStmt', 'CreateFunctionStmt', 'RenameStmt',
               'DoStmt', 'CreateTrigStmt', 'CommentStmt'}
    for name in SQL_FILES:
        text = (ROOT / 'telegram-market/db' / name).read_text()
        nodes = parse_sql(text)
        if not nodes or any(type(n.stmt).__name__ not in allowed for n in nodes):
            raise BackupError('Unreviewed migration statement or transaction control')
        texts.append(text)
        digests[name] = hashlib.sha256(text.encode()).hexdigest()
    return texts, digests


def backup(output):
    require_target()
    if output.exists():
        raise BackupError('Backup output already exists; no overwrite permitted')
    config = source_config(os.environ.pop('WASEET_TEST_DATABASE_URL', ''))
    passphrase = os.environ.pop('WASEET_BACKUP_PASSPHRASE', '')
    if len(passphrase) < 24 or '\n' in passphrase or '\r' in passphrase:
        raise BackupError('Configured encryption passphrase required')
    image = restore_image(os.environ.get('WASEET_TEST_RESTORE_IMAGE'))
    with tempfile.TemporaryDirectory(prefix='waseet-backup-user-release-') as temp:
        operation = Backup(temp)
        try:
            report = operation.export_verify(config, passphrase, output, image, False)
        finally:
            operation.cleanup()
    report.update(verified_at=datetime.now(timezone.utc).isoformat(),
                  run_id=int(os.environ['GITHUB_RUN_ID']),
                  release_branch=BRANCH)
    (output / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, sort_keys=True))


def verified_backup(path):
    proof = json.loads((path / 'verification.json').read_text())
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(proof['verified_at'])).total_seconds()
    if (proof.get('project_ref') != REF or not proof.get('actual_hosted_backup')
            or not proof.get('isolated_postgres_restore_verified')
            or not proof.get('source_tls_verified') or not 0 <= age <= 7200
            or proof.get('workflow_commit') != os.environ['GITHUB_SHA']
            or proof.get('run_id') != int(os.environ['GITHUB_RUN_ID'])):
        raise BackupError('Fresh same-run full PostgreSQL restore proof required')
    sums = (path / 'SHA256SUMS').read_text().splitlines()
    if len(sums) != 1:
        raise BackupError('Unexpected backup archive inventory')
    digest, name = sums[0].split(maxsplit=1)
    if name != 'Waseet-Test.postgres.tar.gpg' or file_hash(path / name) != digest:
        raise BackupError('Encrypted backup checksum differs')
    return proof


def verified_rehearsal(path, digests):
    proof = json.loads(path.read_text())
    run_id = str(proof['run_id'])
    if not run_id.isdecimal():
        raise BackupError('Rehearsal run ID invalid')
    request = urllib.request.Request(
        'https://api.github.com/repos/' + REPOSITORY + '/actions/runs/' + run_id,
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        run = json.load(response)
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(run['updated_at'].replace('Z', '+00:00'))).total_seconds()
    if (run.get('conclusion') != 'success' or run.get('path') != WORKFLOW
            or run.get('head_branch') != BRANCH.removeprefix('refs/heads/')
            or not 0 <= age <= 86400
            or proof.get('project_ref') != REF
            or proof.get('mode') != 'rehearsal'
            or not proof.get('rollback_verified')
            or not proof.get('existing_rows_unchanged')
            or not proof.get('no_historical_notification_fanout')
            or proof.get('sql_sha256') != digests):
        raise BackupError('Successful fresh exact-SQL rollback rehearsal required')
    return proof


def hooks(cursor):
    cursor.execute("""select jsonb_agg(jsonb_build_array(e.evtname,e.evtevent,
      e.evtenabled,n.nspname,p.proname,
      encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'))
      order by e.evtname) from pg_event_trigger e
      join pg_proc p on p.oid=e.evtfoid join pg_namespace n on n.oid=p.pronamespace
      where e.evtenabled<>'D'""")
    pinned = json.loads((ROOT / 'telegram-market/db/test-hooks.json').read_text())
    expected = [[p[k] for k in ('name', 'event', 'enabled', 'schema', 'function', 'definition_sha256')] for p in pinned]
    if cursor.fetchone()[0] != expected:
        raise BackupError('Enabled DDL hooks changed; review required')


def original_rows(conn, layout=None):
    """Digest original columns, so additive defaults cannot hide old-row changes."""
    from psycopg2 import sql
    with conn.cursor() as cursor:
        if layout is None:
            cursor.execute("""select c.relname,array_agg(a.attname order by a.attnum)
              from pg_class c join pg_namespace n on n.oid=c.relnamespace
              join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
              where n.nspname='public' and c.relkind='r'
                and (c.relname like 'tg_market_%' or c.relname='notification_outbox')
              group by c.relname order by c.relname""")
            layout = cursor.fetchall()
        rows = []
        for table, columns in layout:
            projection = sql.SQL(',').join(map(sql.Identifier, columns))
            source = sql.SQL('(select {} from public.{})').format(projection, sql.Identifier(table))
            cursor.execute(sql.SQL('select count(*) from {} t').format(source))
            count = cursor.fetchone()[0]
            sink = Hasher()
            query = sql.SQL('copy (select row_to_json(t)::text from {} t order by row_to_json(t)::text collate "C") to stdout').format(source)
            cursor.copy_expert(query.as_string(conn), sink)
            rows.append((table, count, sink.hash.hexdigest()))
    digest = hashlib.sha256(json.dumps(rows).encode()).hexdigest()
    return layout, rows, digest


def installed_checks(cursor):
    for name in TABLES:
        cursor.execute("select relrowsecurity and relforcerowsecurity from pg_class where oid=%s::regclass", ('public.' + name,))
        row = cursor.fetchone()
        if row != (True,):
            raise BackupError('Private notification table RLS missing')
        for role in ('anon', 'authenticated', 'service_role'):
            cursor.execute("select has_table_privilege(%s,%s,'SELECT,INSERT,UPDATE,DELETE')", (role, 'public.' + name))
            if cursor.fetchone()[0]:
                raise BackupError('Private notification table direct grants unsafe')
    for signature in RPCS:
        for role in ('anon', 'authenticated'):
            cursor.execute("select has_function_privilege(%s,%s,'EXECUTE')", (role, 'public.' + signature))
            if cursor.fetchone()[0]:
                raise BackupError('Private notification RPC grants unsafe')
        cursor.execute("select has_function_privilege('service_role',%s,'EXECUTE')", ('public.' + signature,))
        if not cursor.fetchone()[0]:
            raise BackupError('Service notification RPC grant missing')
    cursor.execute("""select count(*) from pg_trigger where tgname='notification_outbox_capture'
      and not tgisinternal and tgenabled='O'""")
    if cursor.fetchone()[0] != 16:
        raise BackupError('Existing or new outbox capture trigger missing')
    cursor.execute("""select relrowsecurity and relforcerowsecurity from pg_class
      where oid='public.notification_outbox'::regclass""")
    if cursor.fetchone() != (True,):
        raise BackupError('Outbox RLS changed')
    cursor.execute("""select status,count(*) from public.notification_outbox group by status order by status""")
    outbox = dict(cursor.fetchall())
    cursor.execute("select state,count(*) from public.tg_market_notify_queue group by state order by state")
    return {'outbox': outbox, 'user_queue': dict(cursor.fetchall()), 'capture_triggers': 16}


def release(mode, backup_path, rehearsal_path):
    require_target()
    texts, digests = sql_bundle()
    backup_proof = None
    rehearsal_proof = None
    if mode != 'verify':
        backup_proof = verified_backup(backup_path)
    if mode == 'apply':
        if (os.environ.get('WRITERS_PAUSED_CONFIRMED') != 'true'
                or os.environ.get('WORKER_PROJECT_VERIFIED') != 'true'):
            raise BackupError('Live Worker binding, writer pause and drained leases must be verified')
        rehearsal_proof = verified_rehearsal(rehearsal_path, digests)
    conn = None
    try:
        conn = connection(source_config(os.environ.pop('WASEET_TEST_DATABASE_URL', '')))
        verify_source_identity(conn)
        before_catalog = fingerprint(conn)
        if rehearsal_proof and rehearsal_proof.get('baseline_catalog_sha256') != before_catalog:
            raise BackupError('Production schema changed after rehearsal; repeat rehearsal')
        conn.rollback()
        conn.set_session(readonly=(mode == 'verify'))
        with conn.cursor() as cursor:
            cursor.execute("set local lock_timeout='3s';set local statement_timeout='60s'")
            hooks(cursor)
        layout, before_rows, before_digest = original_rows(conn)
        if mode != 'verify':
            with conn.cursor() as cursor:
                # This transaction lock coordinates this guarded migration family.
                cursor.execute("select pg_try_advisory_xact_lock(20261029,13014)")
                if not cursor.fetchone()[0]:
                    raise BackupError('Another notification schema release is running')
                for text in texts:
                    cursor.execute(text)
        with conn.cursor() as cursor:
            state = installed_checks(cursor)
            if mode != 'verify':
                cursor.execute('select count(*) from public.tg_market_support_replies')
                if cursor.fetchone()[0] != 0:
                    raise BackupError('Unexpected historical support reply rows')
                # Receipt bootstrap records prior ad deliveries for deduplication;
                # it must never create a new delivery or marketing event.
                cursor.execute('select count(*) from public.tg_market_notify_ad_receipts')
                state['ad_deduplication_receipts'] = cursor.fetchone()[0]
                cursor.execute("""with expected as (
                  select distinct on(q.user_id,e.listing_id)
                    q.user_id,e.listing_id,q.id as queue_id
                  from public.tg_market_notify_queue q
                  join public.tg_market_notify_events e on e.id=q.event_id
                  where e.kind='listing' and e.listing_id is not null
                    and q.state in('sent','sending','review','pending')
                  order by q.user_id,e.listing_id,
                    case q.state when 'sent' then 0 when 'review' then 1 when 'sending' then 2 else 3 end,
                    q.created_at,q.id
                ), differences as (
                  (select user_id,listing_id,queue_id from public.tg_market_notify_ad_receipts
                   except select user_id,listing_id,queue_id from expected)
                  union all
                  (select user_id,listing_id,queue_id from expected
                   except select user_id,listing_id,queue_id from public.tg_market_notify_ad_receipts)
                ) select count(*) from differences""")
                if cursor.fetchone()[0] != 0:
                    raise BackupError('Historical delivery receipt bootstrap differs')
        _, after_rows, after_digest = original_rows(conn, layout)
        if before_rows != after_rows:
            raise BackupError('Existing business or pending notification rows changed')
        installed_catalog = fingerprint(conn)
        if mode == 'apply':
            conn.commit()
        else:
            conn.rollback()
        rollback_ok = mode != 'rehearsal'
        if mode == 'rehearsal':
            conn.set_session(readonly=True)
            rollback_ok = fingerprint(conn) == before_catalog
            if not rollback_ok:
                raise BackupError('Rehearsal catalog rollback differs')
        report = dict(project_ref=REF, source_sha=os.environ['GITHUB_SHA'],
            run_id=int(os.environ['GITHUB_RUN_ID']), mode=mode,
            sql_sha256=digests, rollback_verified=mode == 'rehearsal' and rollback_ok,
            baseline_catalog_sha256=before_catalog,
            verified_catalog_sha256=installed_catalog,
            production_installed=mode == 'apply', schema_verified=True,
            existing_rows_unchanged=True, existing_rows_sha256=before_digest,
            no_historical_notification_fanout=True, historical_events_sent=False,
            business_tables_checked=len(layout),
            fresh_restore_backup_run_id=backup_proof['run_id'] if backup_proof else None,
            verified_at=datetime.now(timezone.utc).isoformat(), **state)
        (ROOT / 'user-notifications-proof.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, sort_keys=True))
    finally:
        if conn:
            conn.rollback()
            conn.close()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('backup', 'rehearsal', 'apply', 'verify'))
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--rehearsal', type=Path)
    args = parser.parse_args()
    try:
        if args.mode == 'backup':
            backup(args.backup)
        else:
            release(args.mode, args.backup, args.rehearsal)
        return 0
    except Exception as error:
        # Never expose connection strings, customer rows or PostgreSQL diagnostics.
        print('User notification release stopped safely: ' +
            (str(error) if isinstance(error, BackupError) else safe_error_code(error)), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
