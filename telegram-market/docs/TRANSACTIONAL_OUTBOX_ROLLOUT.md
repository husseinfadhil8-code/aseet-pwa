# Transactional notification outbox — candidate, not deployed

Base: c31a1b8bb66ca2e4fb3e3b2b25831c3bd238b915.

Live inspection on 2026-10-29 established that Cloudflare Worker
`waseet-telegram-bot` uses Supabase `beyrctbxojpuvhevfyok`, whose official
name is **Waseet-Test**. The owner explicitly required a confirmed production
project rather than Test. Do not migrate this target until that discrepancy is
resolved. The project-specific metadata and read-only SQL APIs work; the project
listing endpoint returns 403. No live migration or backup has been performed.

Candidate implementation:

- `011_notification_outbox.sql`: additive table, indexes, protected server RPCs,
  and same-transaction capture on users, listings, rep_applications, publications,
  wanted, wanted_offers, reports, wanted_reports, support, audit, settings,
  intelligence_settings, packages, payouts, and rep_goods. Catalog guards abort
  on drift. RLS plus revoked direct grants deny ordinary users and direct service
  access; only restricted service-role RPCs claim/ack/reconcile events.
- `012_outbox_bridge_d1.sql`: metadata linking the Supabase events to the existing
  `tg_n_events`/`tg_n_delivery` queue. No second Telegram sender. D1 admin audits
  are captured; claim transitions use unique IDs even when returning to an earlier
  state. Existing referral/start/enrollment/claim triggers remain in use.
- `NOTIFICATION_OUTBOX=true` selects the durable source and disables periodic
  snapshot event generation and RPC observers, avoiding two active capture paths.
  Default remains off until coordinated rollout. Mini App registration is derived
  from an actual account INSERT with server-set origin, never a reopening.
- Claim leases use SKIP LOCKED and random tokens; expired bridge jobs replay with
  stable delivery IDs. D1 acknowledgements are idempotent across connection loss.
- Pre-send worker crashes are retryable; interrupted in-flight sends require review.
  429 pauses the existing dispatcher for retry_after. Known rejections retry with
  bounded exponential backoff; uncertain Telegram outcomes remain reviewable.
- Supabase status `queued` means persisted to D1; `sent` requires accepted Telegram
  message IDs for every associated administrator delivery. Cancelled preferences
  produce review, not a false sent status. Review/failed rows are retained.

Before any live migration:

1. Confirm the exact project above is the intended production database, or obtain
   the intended target and re-inspect its schema, policies, functions and triggers.
2. Capture fresh catalog fingerprints and review differences against this candidate.
3. Make encrypted, private, complete Supabase and D1 backups, preserving schema,
   policies, functions, triggers, sequences and data. Verify decryption and restore
   into an isolated database, including counts and constraints. Catalog inspection
   alone is NOT a restorable backup. Never put secrets/backups in Git or public output.
4. Obtain any required database owner approval for the reviewed target/migration.
5. Coordinate a short write/observer drain before installing capture and switching
   modes. In-flight old RPC observers and scanners must finish before writes resume;
   simply enabling both paths concurrently can duplicate cutover events. A rollout
   implementation and verification of this drain is still required. Do not backfill
   historical business rows or replay old D1 raw records.
6. Apply D1 metadata changes atomically, then the PostgreSQL transaction with its
   lock/statement timeouts. Verify exact trigger definitions, grants and RLS before
   enabling NOTIFICATION_OUTBOX. No change to campaign terms or business records.
7. Verify an isolated tagged administrator test passes capture → D1 → Telegram
   message_id → sent acknowledgement. Verify cron, recovery, RLS and existing flows.
   Do not manufacture a real cash entitlement or mutate user listings.

Rollback is forward-safe: stop bridge consumption and disable the newly named
`notification_outbox_capture` triggers in a transaction if necessary; retain the
outbox and D1 delivery ledger, all IDs and message IDs. Do not delete tables/events
or restore the whole production database over newer business writes. Resolve the
capture cutover boundary before re-enabling snapshot observation. Remove the new
D1 audit trigger and restore the prior claim trigger only after workers are drained.
Already accepted Telegram messages cannot be recalled by database rollback.

Telegram Bot API has no exactly-once idempotency key. Success followed by a lost
response/ack cannot be distinguished reliably from failure: the row is retained for
explicit review, not blindly resent. Persisted event ≠ Telegram acceptance ≠ iPhone
notification. If Telegram is unavailable, an alert sent through that same bot is also
blocked; inspect the durable backlog/health API and external service monitoring.

Local evidence: seven isolated PostgreSQL tests (including 40 concurrent inserts,
rollback and permission tests), isolated D1 bridge/replay/failure tests, existing
notification-center/cash/platform tests, 152 JavaScript regression tests, and Worker
dry-run build. These are not production deployment or real Telegram delivery proof.
The new PostgreSQL suite uses a reviewed-column fixture rather than a restored
production backup; a full restored-schema rehearsal is still mandatory.
