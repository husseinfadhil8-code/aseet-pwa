# Preserve the PostgreSQL bootstrap role during isolated recovery

PostgreSQL gives the original initdb role OID 10 special grantor semantics.
Supabase can legitimately contain grants made by that role without ordinary
ADMIN membership chains. Recreating its name under another OID can make
pg_dumpall role replay fail even under a newly created superuser.

The source inventory records the role at OID 10. A fresh, networkless target is
initialized with that exact role name, then a separate temporary restore
administrator is created. pglast's PostgreSQL parser removes exactly one CREATE
ROLE statement for the already-existing bootstrap role; all ALTER, COMMENT,
configuration and GRANT statements are preserved. Unexpected/missing/duplicate
bootstrap declarations or malformed dump guards fail closed. Source text inside
quoted identifiers, comments and literals is not replaced by regex.

The original roles.sql remains in the encrypted archive. The prepared SQL exists
only in the isolated restore workspace. Final comparison includes the bootstrap
identity, role attributes/configuration and memberships/grantors as well as the
existing schema/ACL/RLS/data checks. No hosted roles or grants are modified.

A new synthetic regression gives the initdb role membership to another role.
The previous restore fails at role replay; the corrected restore passes. This
validates the fix, not a hosted backup. The hosted workflow must still succeed.
