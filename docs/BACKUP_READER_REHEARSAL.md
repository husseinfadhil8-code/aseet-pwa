# Backup connection readiness — isolated rehearsal

`scripts/sql/backup_reader_preflight.sql` is read-only and returns permission
booleans and names, never connection strings or table contents. Run it using the
intended export connection after independently confirming the Test project
identity. It checks five explicit schemas and reports missing schemas, USAGE,
SELECT and full RLS visibility. It does not grant privileges, prove dependency
completeness, audit all executable functions, or create a hosted backup.

`python scripts/integration_backup_reader.py -v` runs only against labeled
networkless disposable PostgreSQL containers. A local non-superuser export role
has CONNECT, schema USAGE, table/sequence SELECT and BYPASSRLS, without
CREATEDB/CREATEROLE or direct table writes. Its real custom pg_dump is restored
with ACLs, fail-on-error and a single transaction into a separate empty database.
Auth fixture rows, forced RLS and reader grants must survive. Negative cases
remove BYPASSRLS or Auth SELECT and require pg_dump to fail, preventing a partial
RLS view from being accepted as a complete export.

The prior application restore and sixth-migration tests remain in
`integration_recovery.py`; this adds export-role coverage without changing them.
Synthetic fixtures do not model full hosted Auth, Storage binaries, platform
extensions or SMTP/OAuth/JWT settings. Supabase may prohibit creation of
BYPASSRLS roles by project administrators; no hosted role is created here.

Actual Test backup is still blocked until a private PostgreSQL connection,
approved TCP route and secret encryption passphrase are configured. Management
API access is not PostgreSQL authentication. The user selected encrypted archive
download to Files/iCloud Drive; only an independently saved and read-back verified
archive can satisfy that part of the backup gate. Production needs its own
backup and restore evidence before any production migration.
