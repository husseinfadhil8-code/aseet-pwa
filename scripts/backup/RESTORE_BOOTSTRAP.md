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

Supabase also permits a non-superuser to own event triggers. PostgreSQL's
ALTER EVENT TRIGGER OWNER requires the recipient to be a superuser even when
the restore administrator is already a superuser. The read-only inventory
records these owners. Only their isolated copies are elevated during restore,
then demoted before any verification. Exact role attributes and event-trigger
ownership must still match the source; failed restores publish no archive.
A synthetic non-superuser event-trigger owner covers this compatibility case.
Both schema comparisons now use the same pinned pg_dump client.

Extensions cannot be reassigned with ALTER EXTENSION OWNER. Recovery now replays
only the archive's database/schema definitions first (including database
properties and comments), then creates extensions in dependency order under
the exact source owners and versions. The remaining unmodified archive TOC is
restored normally. Extension owners temporarily elevated inside the networkless
target are demoted before strict validation. Extension version/owner/schema and
dependencies are now included in the inventory. A synthetic postgres_fdw owned
by a non-superuser reproduces the old mismatch and passes staged recovery.
No source permissions or schemas are changed.

pg_dump emits policy role lists in role-OID order, which can differ in a fresh
cluster. Schema comparison parses CREATE POLICY statements and sorts only their
TO role list; it keeps policy name, table, command, permissiveness, USING and
WITH CHECK expressions exact. All other SQL remains under the prior comparison.
Regression checks accept reordered roles and reject changed conditions, missing
roles, restrictive/permissive changes, and unrelated ACL changes. No source RLS
policy is altered or omitted.

Policy definitions are also compared independent of pg_dump output order.
Every complete normalized policy definition is retained with its table and name;
only the order of independent policy declarations and their TO role lists may
differ. Non-policy DDL remains under the existing textual comparison.

Schema verification now compares every parsed PostgreSQL statement structurally
instead of slicing/reformatting policy text. It preserves statement counts,
connection phase, all AST semantic fields, and the active SET/search_path context
for each definition. It omits only parser source positions, SQL formatting,
independent declaration order and policy TO-role ordering. Function body strings,
including comments inside them, remain exact. SET context changes, ACL changes,
and policy changes fail regression tests. Dump guard envelopes are validated;
the fixed postgres connection separates phases. No source SQL is printed.
