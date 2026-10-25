"""Test-only transactional DDL rehearsal; no COMMIT, fixture rows, messages or sales."""
import hashlib,json,os,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backup.manual_test_backup import BackupError,TEST_REF,source_config,connection,verify_source_identity,safe_error_code
from review.test_security_metadata import require_manual_test,metadata_checks
SOURCE_COMMIT='6087cbddcb760d99f09709137c2492857d939962'
BUNDLE=Path(__file__).with_name('proposals')

def validate_ddl(text):
    from pglast import parse_sql
    allowed={'CreateFunctionStmt','GrantStmt','CreatePolicyStmt','CommentStmt'}
    nodes=parse_sql(text)
    if not nodes or any(type(raw.stmt).__name__ not in allowed for raw in nodes):
        raise BackupError('The reviewed bundle must contain only approved transactional DDL')

def fingerprint(conn):
    queries=[
      "SELECT c.relname,c.relkind,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY 1,2",
      "SELECT c.relname,a.attname,a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2",
      "SELECT p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid),p.proowner,p.proacl::text,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p') ORDER BY 1,2",
      "SELECT c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY 1,2",
      "SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1,2"
    ]
    rows=[]
    with conn.cursor() as c:
        for query in queries:c.execute(query);rows.append(c.fetchall())
    return hashlib.sha256(json.dumps(rows,default=str,sort_keys=True).encode()).hexdigest()

def forbidden_rpc(conn,query):
    with conn.cursor() as c:
        c.execute('SAVEPOINT deny_check')
        try:c.execute(query)
        except Exception as error:
            code=getattr(error,'pgcode',None)
            c.execute('ROLLBACK TO SAVEPOINT deny_check')
            if code not in ('42501','P0001'):raise BackupError('Unexpected denial result; raw SQL withheld')
            return
        finally:c.execute('RELEASE SAVEPOINT deny_check')
    raise BackupError('Unauthenticated RPC unexpectedly succeeded')

def main():
    conn=None;baseline=None;passed=False
    try:
        require_manual_test(os.environ.get('CONFIRM_TEST_REF',''))
        texts=[(BUNDLE/name).read_text() for name in ('private_contacts_chat_boundaries.sql','direct_chat_pair_lock.sql')]
        manifest=json.loads((BUNDLE/'manifest.json').read_text())
        if manifest['source_commit']!=SOURCE_COMMIT:raise BackupError('Unreviewed proposal source')
        for name,text in zip(manifest['files'],texts):
            if hashlib.sha256(text.encode()).hexdigest()!=manifest['files'][name]:raise BackupError('Reviewed proposal checksum mismatch')
            validate_ddl(text)
        conn=connection(source_config(os.environ.pop('WASEET_TEST_DATABASE_URL','')))
        verify_source_identity(conn);baseline=fingerprint(conn);before=metadata_checks(conn);conn.rollback()
        conn.set_session(readonly=False)
        with conn.cursor() as c:
            c.execute("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s'")
            c.execute('SELECT project_ref FROM waseet_test_ops.target WHERE id=true')
            if c.fetchall()!=[(TEST_REF,)]:raise BackupError('Test identity changed')
            # DDL event hooks must be reviewed, not silently executed if a custom hook exists.
            c.execute("SELECT count(*) FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE e.evtenabled<>'D' AND n.nspname NOT IN ('extensions','graphql','graphql_public','pgrst')")
            if c.fetchone()[0]:raise BackupError('Custom enabled DDL hook needs review; no proposal executed')
            for text in texts:c.execute(text)
        after=metadata_checks(conn)
        if not all(after.values()):raise BackupError('Rehearsed privilege metadata is incomplete')
        with conn.cursor() as c:
            c.execute("SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub','',true); SELECT set_config('request.jwt.claims','{}',true)")
        forbidden_rpc(conn,"SELECT * FROM public.get_good_owner_contact('00000000-0000-0000-0000-000000000001')")
        forbidden_rpc(conn,"SELECT public.create_direct_chat(NULL)")
        with conn.cursor() as c:c.execute('RESET ROLE')
        conn.rollback();conn.set_session(readonly=True)
        if fingerprint(conn)!=baseline:raise BackupError('Catalog rollback could not be verified')
        passed=True
        print(json.dumps(dict(project_ref=TEST_REF,test_transactional_rehearsal=True,proposal_source=SOURCE_COMMIT,
                              baseline_checks=before,rehearsal_checks=after,unauthenticated_rpc_denials_verified=True,
                              rollback_verified=True,user_rows_written=False,production_changed=False,
                              hosted_positive_staff_behavior_verified=False),sort_keys=True))
        return 0
    except Exception as error:
        print('Test rollback rehearsal stopped safely: '+(str(error) if isinstance(error,BackupError) else safe_error_code(error)),file=sys.stderr)
        return 1
    finally:
        if conn:
            try:conn.rollback()
            except Exception:pass
            try:conn.close()
            except Exception:pass
if __name__=='__main__':raise SystemExit(main())
