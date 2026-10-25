"""Read-only, Test-only metadata audit. Never migrate, read user rows or print SQL."""
import json,os,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backup.manual_test_backup import (BackupError,REPOSITORY,TEST_REF,source_config,
                                      connection,verify_source_identity,safe_error_code)

def require_manual_test(confirm):
    if (confirm!=TEST_REF or os.environ.get('GITHUB_REPOSITORY')!=REPOSITORY
        or os.environ.get('GITHUB_REF')!='refs/heads/main'
        or os.environ.get('GITHUB_EVENT_NAME')!='workflow_dispatch'):
        raise BackupError('This read-only review requires a confirmed manual main-branch Test run')

def metadata_checks(conn):
    with conn.cursor() as c:
        c.execute("SELECT count(*)=3 AND bool_and(c.relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('chat_conversations','chat_members','chat_messages')")
        rls=c.fetchone()[0]
        c.execute("SELECT to_regclass('public.chat_members') IS NOT NULL AND to_regclass('public.goods') IS NOT NULL")
        if not c.fetchone()[0]:raise BackupError('Expected Test schema is missing; no changes made')
        c.execute("SELECT NOT bool_or(has_column_privilege('authenticated','public.chat_members',column_name,'UPDATE')) FROM (VALUES ('conversation_id'),('user_id'),('joined_at')) AS columns(column_name)")
        member_columns=c.fetchone()[0]
        c.execute("SELECT NOT has_table_privilege('authenticated','public.chat_members','INSERT,DELETE') AND NOT has_table_privilege('authenticated','public.chat_conversations','INSERT,DELETE')")
        direct_writes=c.fetchone()[0]
        c.execute("SELECT NOT bool_or(has_column_privilege('authenticated','public.goods',column_name,'SELECT')) FROM (VALUES ('owner_name'),('owner_phone')) AS columns(column_name)")
        contacts=c.fetchone()[0]
        c.execute("SELECT pg_get_functiondef(to_regprocedure('public.create_direct_chat(uuid)'))")
        definition=c.fetchone()[0] or ''
        c.execute("SELECT to_regprocedure('public.rls_is_active_staff()') IS NOT NULL, to_regprocedure('public.get_good_owner_contact(uuid)') IS NOT NULL")
        active_helper,contact_rpc=c.fetchone()
    return dict(chat_tables_have_rls=bool(rls),membership_identity_columns_protected=bool(member_columns),
                            direct_chat_table_writes_restricted=bool(direct_writes),owner_contact_columns_restricted=bool(contacts),
                            direct_chat_lock_present_in_definition='pg_advisory_xact_lock' in definition,
                            active_staff_helper_present=bool(active_helper),guarded_contact_rpc_present=bool(contact_rpc))

def audit(conn):
    verify_source_identity(conn)
    return dict(project_ref=TEST_REF,read_only_metadata_review=True,user_rows_exported=False,hosted_behavior_verified=False,production_reviewed=False,checks=metadata_checks(conn))

def main():
    conn=None
    try:
        require_manual_test(os.environ.get('CONFIRM_TEST_REF',''))
        config=source_config(os.environ.pop('WASEET_TEST_DATABASE_URL',''))
        conn=connection(config)
        print(json.dumps(audit(conn),sort_keys=True))
    except Exception as error:
        code=str(error) if isinstance(error,BackupError) else safe_error_code(error)
        print('Test metadata review stopped safely: '+code,file=sys.stderr);return 1
    finally:
        if conn:conn.close()
    return 0
if __name__=='__main__':raise SystemExit(main())
