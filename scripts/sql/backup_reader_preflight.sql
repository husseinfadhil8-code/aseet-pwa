-- Run with the intended export connection. Read-only: does not grant anything.
-- Scope-specific readiness only; not proof of a full-platform backup or no
-- executable SECURITY DEFINER write paths. Review extra dependencies separately.
BEGIN READ ONLY;
WITH scope(name) AS (VALUES ('public'),('auth'),('storage'),
 ('supabase_migrations'),('waseet_test_ops')),
relations AS (
 SELECT c.oid,n.nspname,c.relname,c.relkind,c.relrowsecurity
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN scope s ON s.name=n.nspname
 WHERE c.relkind IN ('r','p','S','m','f')
), checks AS (
 SELECT jsonb_build_object(
  'schema',nspname,'relation',relname,'kind',relkind,
  'select',CASE WHEN relkind='S' THEN has_sequence_privilege(oid,'SELECT')
                ELSE has_table_privilege(oid,'SELECT') END,
  'rls',relrowsecurity) AS item FROM relations
)
SELECT jsonb_build_object(
 'read_only',current_setting('transaction_read_only')='on',
 'connect',has_database_privilege(current_database(),'CONNECT'),
 'full_rls_visibility',r.rolsuper OR r.rolbypassrls,
 'superuser',r.rolsuper,
 'can_create_database',r.rolcreatedb,
 'can_create_role',r.rolcreaterole,
 'missing_schemas',(SELECT coalesce(jsonb_agg(s.name),'[]'::jsonb) FROM scope s
   WHERE NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=s.name)),
 'missing_schema_usage',(SELECT coalesce(jsonb_agg(n.nspname),'[]'::jsonb)
   FROM pg_namespace n JOIN scope s ON s.name=n.nspname
   WHERE NOT has_schema_privilege(n.oid,'USAGE')),
 'unreadable_relations',(SELECT coalesce(jsonb_agg(item),'[]'::jsonb) FROM checks
   WHERE NOT (item->>'select')::boolean),
 'relations_checked',(SELECT count(*) FROM relations),
 'scope_only',true,
 'hosted_backup_created',false
) FROM pg_roles r WHERE r.rolname=current_user;
ROLLBACK;
