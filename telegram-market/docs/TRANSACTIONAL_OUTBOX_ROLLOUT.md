# Production transactional notification outbox

Production target explicitly confirmed by the owner on 2026-10-29:
Supabase `beyrctbxojpuvhevfyok` (official name `Waseet-Test`), Worker
`waseet-telegram-bot`, bot `@WaseetIraqMarketBot`. No user/database migration.
Base source: `c31a1b8bb66ca2e4fb3e3b2b25831c3bd238b915`.

## Verified production rollout

- Fresh encrypted database backup, TLS-verified export and full isolated PostgreSQL
  restore: [40835422435](https://github.com/husseinfadhil8-code/aseet-pwa/actions/runs/40835422435).
  Ciphertext checksum verified after download. A verified copy is retained for 30 days in [40838238923](https://github.com/husseinfadhil8-code/aseet-pwa/actions/runs/40838238923). Roles/ACL/schema/data restore tested;
  login passwords and Storage binary objects are intentionally outside this database
  archive. No Storage or credential changes are part of this rollout.
- D1 encrypted export, decryption roundtrip and isolated SQLite restore verified for
  55 existing tables; foreign-key check passed. Private artifacts stay outside Git.
- Exact SQL rollback rehearsal on the live schema:
  [40836466697](https://github.com/husseinfadhil8-code/aseet-pwa/actions/runs/40836466697).
- Additive production installation:
  [40836888543](https://github.com/husseinfadhil8-code/aseet-pwa/actions/runs/40836888543).
  Verified 15 capture triggers, enforced RLS, revoked ordinary-user grants and zero
  historical events. A D1 barrier drained writers before migration; browsing remained
  available. New POST writes briefly received retryable 503s; Telegram retries them.
  Barrier was released to `enabled` immediately after independent catalog checks.
- Live temporary-clone tests:
  [40836968469](https://github.com/husseinfadhil8-code/aseet-pwa/actions/runs/40836968469).
  Registration origin, listing insert, rapid reverting updates, eight concurrent
  transactions and ordinary-role denial tested in the production database without
  touching public business rows. These fixtures roll back. One tagged audit probe
  persisted to the actual outbox and was delivered automatically by Cron: Telegram
  message **104**, database state **sent**.
- Live recovery:
  [40837440174](https://github.com/husseinfadhil8-code/aseet-pwa/actions/runs/40837440174).
  A second tagged probe began with an expired processing lease; the real bridge
  recovered it (attempts=2). A one-shot test-only failure before HTTP produced a
  retained retry, then real Telegram acceptance **105**, delivery attempts=2.
  Reprocessing preserved message 105 without a second send. Telegram was never
  disabled for real users. This is an isolated transport-failure simulation, not
  an actual Telegram provider outage.

Machine-readable evidence is in `telegram-market/evidence/outbox-*.json`.

## Storage, capture and delivery

`db/011_notification_outbox.sql` adds `notification_outbox`, three indexes,
`capture_notification_outbox`, and the claim/ack/queued/delivery/health RPCs.
Capture is in the same PostgreSQL transaction on the following `tg_market_` tables:
users, listings, rep_applications, publications, wanted, wanted_offers, reports,
wanted_reports, support, audit, settings, intelligence_settings, packages, payouts,
rep_goods. No historical backfill. Column guards reject schema drift. Direct reads
and writes, including direct service-role access, are revoked; only server RPCs can
claim and acknowledge. An event UUID identifies each committed mutation.

`db/012_outbox_bridge_d1.sql` adds `tg_n_outbox` and `tg_n_outbox_events`, plus
`tg_n_admin_audit`, and replaces `tg_n_claim_changed` so repeated transitions back
to a previous state and payment-reference changes are preserved. No financial rows
or reward terms are modified. Existing D1 triggers preserve bot starts, qualified
referrals, the milestone, campaign enrollment, withdrawals and status changes.
A shared link to the existing `tg_n_events`/`tg_n_delivery` queue is used; there is
no second Telegram sender. Legacy administrative forwarding reuses captured events.

The D1 `tg_n_meta.outbox_cutover=enabled` marker supplies NOTIFICATION_OUTBOX=true
to mutating requests and scheduled jobs. Periodic Supabase snapshot observers are
then disabled. `src/notification-cutover.js` tracks writers and provides the brief
rollout barrier. Static browsing/read endpoints remain available. An actual account
INSERT with server-set Mini App origin is a registration; a reopening is not.
Sharing a referral link never qualifies a referral.

`src/notification-outbox.js` claims with SKIP LOCKED and tokenized two-minute
leases, replays deterministic D1 keys after bridge crashes, acknowledges queued
records, reconciles accepted message IDs and monitors stalled/repeated failures.
D1 dispatcher ownership is renewed and released with compare-and-set, including a
last ownership check before sending. A stale worker cannot unlock its replacement.
Pre-send crashes retry; interrupted in-flight sends require review. Telegram 429
respects retry_after; known failures use bounded backoff and remain stored.

Administrator status exposes outbox health in the existing notification center.
Persistent problems generate throttled important-error events. An outage of Telegram
also delays alerts sent through Telegram; inspect the durable backlog/health when
that transport is down. The temporary-key verification endpoint is unusable after
its deployment secret is removed; it never accepts a public caller without the key.

## Guarantee boundaries

A persisted event, an accepted Telegram message and an iPhone notification are three
different facts. `sent` requires Telegram message IDs. Bot API has no exactly-once
idempotency key: an accepted send followed by a lost response/ack remains reviewable,
not blindly retried. Review/failed events are never deleted. Manual retry warns
about possible duplication. No iPhone receipt or user reading is claimed.

Scope is the current bot/Mini App and the specified tables and D1 operational
sources. Unrelated legacy PWA tables, arbitrary new future tables and ordinary
private chat content are not captured by this migration. Relevant support/reports
are captured; public business rows were not manufactured during testing.

## Forward-safe rollback

Drain writers with `outbox_cutover=paused`. Stop the new consumer and, only if needed,
disable the newly named capture triggers in a transaction. Retain the outbox, D1
mapping/delivery ledger, event IDs and message IDs. Do not drop tables/events or
restore a whole database over newer business writes. Resolve the cutover boundary
before returning to the old observer. Existing sent Telegram messages cannot be
undone by a database rollback. Cloudflare's previous Worker version remains available
for rollback, but an old version alone does not understand the new cutover marker.
Restoration credentials and Storage binaries remain separately managed.
