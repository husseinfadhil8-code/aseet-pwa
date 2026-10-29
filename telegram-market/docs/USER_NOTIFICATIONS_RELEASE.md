This release uses the owner's confirmed live Supabase project
`beyrctbxojpuvhevfyok` (display name `Waseet-Test`) and the existing
`waseet-telegram-bot` Worker. It creates no project and moves no users.

Run the existing `manual-test-upgrade-rollback.yml` workflow from
`feature/user-notifications`, with `confirm_test_ref=beyrctbxojpuvhevfyok`:

1. `scope=user-notifications-rehearsal` takes an encrypted full PostgreSQL backup,
   restores it into an isolated digest-pinned database, retains recovery
   ciphertext for 30 days, applies SQL 013 and 014 inside a transaction, verifies
   privileges and unchanged original business/queue rows, and rolls back. Its
   artifact `user-notifications-proof-<run_id>` is required for application.
2. Before applying, independently verify the deployed Worker's Supabase binding,
   pause the existing writer gate, and wait for its writer leases to drain.
   `scope=user-notifications-apply` requires that concrete verification through
   `worker_binding_verified=true`, `writers_paused=true`, and a successful
   `rehearsal_run_id`. It validates the downloaded same-SQL rehearsal, takes and
   restores a fresh backup again, then applies both migrations atomically.
3. Deploy the reviewed compatible Worker and resume the existing gate. Run
   `scope=user-notifications-verify` to read live schema, RLS/grants, enabled
   capture triggers and queue counts without writing any business rows.

The script `scripts/user_notifications_release.py` rejects target/branch
mismatches, changed pinned DDL hooks, unsafe top-level transaction controls,
missing full-restore proof, mismatching rehearsal SQL, changed original rows and
unexpected historical delivery fanout. Prior ad-delivery receipts may be copied
into the new deduplication table; this records an existing identity and creates
no delivery. The scripts never create production ads, rewards or test users and
never send Telegram messages.

Before commit, any failure rolls back all schema changes. After commit, preserve
the additive schema and data: disable the new `USER_NOTIFICATIONS` flag and
redeploy the previously verified scheduler Worker while investigating. Do not
drop columns, delete pending events or restore a full database over a live
database as a routine rollback. The encrypted backup is a disaster-recovery
artifact; restoring it to production requires a separately reviewed incident
plan to avoid replacing post-backup user changes. The verification proves
PostgreSQL data/schema/ACL restoration; it does not back up Storage media bytes
or database-role passwords.
