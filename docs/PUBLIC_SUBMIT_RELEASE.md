# Public submission safety — 2026-10-25-public-submit-7

Prevent concurrent submissions from duplicating public-listing uploads/inserts; validate positive safe integer IQD prices instead of silently rounding fractional values. Failed submission preserves the existing form and shows a neutral message without raw database errors or migration instructions. A refresh failure after successful insertion is handled separately and does not claim that submission failed.

Four intercepted browser cases cover double calls, upload failure/manual retry and redaction, rejected prices before uploads, and successful insertion followed by failed refresh. This is a client guard, not server idempotency or a guarantee against retries after unknown network results. No database, RLS, Storage deletion or migration changes. Images uploaded before a later failure can remain unreferenced; automatic cleanup is outside this release.
