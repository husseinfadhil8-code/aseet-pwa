# Complete account record reads

The previous client fetched sales and inquiries in one request. A server row cap
could therefore silently omit old records and understate commission totals.
This release follows stable `(created_at DESC, id DESC)` keyset pages using only
existing columns. Legacy null dates sort last and receive an explicit null-date
cursor, so they cannot be silently skipped. Every representative sales page retains `rep_id`. RLS remains
the server authority; this does not make an unauthorized table readable.

Pages contain at most 200 requested rows. Exact counts detect server caps smaller
than that; without counts, reads continue until an empty page. Invalid cursors,
duplicate identities, impossible counts, a failed later request or more than 50
pages fail the whole record refresh. Previous sales/inquiries remain intact,
with an explicit retry/error message visible across application tabs. Partial totals are never committed. Ten
thousand rows is a bounded load ceiling, not a claim of unlimited ledger support.

Pending pages stop when the account/role/status validity guard changes. Record
arrays are committed together only after both record reads and linked goods
lookups complete. The existing goods refresh is independently updated, so this
is not an atomic whole-screen refresh. Separate API requests are also not one
PostgreSQL transaction snapshot: concurrent record changes require refreshing.

Verification uses the real vendored SDK with synthetic fetch responses and
browser integration tests for capped pages, failed later pages, representative
filters, logout races and explicit load-limit errors. No hosted account, sale,
Auth or push transaction is simulated as proof of production success. No
migrations, new RPCs, Storage operations or production writes are included.

Backup setup was checked again in this session: the bound environment still
advertises only the existing Management token, and no TCP targets. The owner
confirmed the new fields appear in the published configuration and is rebinding
the task. Do not treat the old runtime as evidence that the supplied password is
wrong, and never substitute the Management token for PostgreSQL authentication.
