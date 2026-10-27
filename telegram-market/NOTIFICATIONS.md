# Private Telegram notifications

The Telegram Worker and its own Test namespace deliver these messages independently
of the Mini App. Telegram accepts bot messages even when the webview is closed;
phone banners, sound, Focus mode, mute status and system permissions remain under
the recipient's control. API acceptance is not proof that a phone banner appeared.

## Consent and privacy
`/start` only displays enable/stop callback buttons. It does not subscribe anyone.
The Telegram webhook secret and private-chat/sender binding authenticate callbacks;
update IDs make consent retries idempotent. Existing filters are not reset by a
second enable press. Mini App settings require validated HMAC initData and explicit
consent. Write-access permission is requested where available; users can start the
bot when a client cannot grant it. Marketing and personal operational notifications
both require this subscription. The single root-only delivery test is separately
confirmed and never changes subscription preferences. It may use an existing approved
real advertisement owned by that root account, including its photo and exact deep link;
it never creates a synthetic public advertisement.

Settings support all ads or one structured Iraqi governorate, optional categories,
operational/rep-goods choices, a 24-hour pause, and unsubscribe. Unsubscribe clears
filters and consent and cancels pending messages; /start does not restore them.
Only explicit re-subscription restores delivery. A 403 disables the recipient and
cancels pending delivery. A request already in flight cannot be atomically recalled.

User/rep/admin routing is checked again immediately before Telegram send. Private
chat notices contain no message body or personal names. Authenticated thread links
must pass conversation membership checks. The foreground conversation sends short
server-expiring presence heartbeats; matching visible chat notices are deferred, then cancelled only after a verified message-read watermark. An unread message is delivered after presence expires, including after a force-close.
Rep goods live in a separate Telegram-only table, visible only to approved reps and
the root administrator; legacy goods, commissions and the original PWA are untouched.

## Events and delivery
Incremental004 creates eight RLS-protected tables and a structured listing governorate.
It has no user/ad/subscriber/event seed or historical fanout. Approval creates one
per-listing event. Reapproval, edits and retries do not re-broadcast that listing.
An approval revision must still match at dispatch; hidden/sold/deleted/reported ads
are not eligible. Owner decisions, rep requests/reviews, new rep goods and new
messages create narrowly targeted events. Explicit rejection is an admin action;
a user's own hide action must not impersonate an administrative decision.

Fanout scans at most50 subscriptions per event and is resumable. Subscription time
must precede the event. A minute Cron runs two fanout chunks and sends at most five
messages, under50 outbound subrequests in the worst case. Operational notifications
are prioritized. A DB row serializes claims globally, spacing sends by1.1seconds.
This intentionally conservative free-plan starting capacity is300 sends/hour;
large audiences queue rather than burst. Monitor queue age and free-plan quotas
before raising batch sizes or promising immediate delivery at high volume.

Queue states: pending, sending, sent, failed, review, cancelled. A unique event/user
key, lease-checked ACK and Telegram message ID prevent confirmed sends from retrying.
429 schedules retry_after and a global cooldown; photo-preparation failures can be
retried because no Telegram request was made. Timeouts, HTTP5xx, malformed results,
ACK loss or expired sending leases become review, never automatic resend. Telegram
and PostgreSQL do not share a transaction; do not promise exact-once delivery after
an ambiguous result. Expired events are not delivered; operational data is omitted
from public/admin summaries. Terminal queue records are retained30days, event
idempotency keys remain; stale presence is removed. Raw Bot API URLs, tokens and
private payloads are never logged.

The system starts disabled. A separately consented root test must receive a real
Telegram message ID and a sent ACK before protected activation is allowed. Activation
sets a cutoff so pre-activation events are not broadcast. The root can inspect counts,
last actual Cron timestamp and sanitized recent states from the admin panel.

## Provisioning and release
Use a fresh encrypted Test backup with an actual isolated PostgreSQL restore.
Rehearse004 with rollback and exact catalog/hook/baseline checks, then install once
on verified Waseet-Test. Never replay001/002/003, disable DDL guards, migrate production
or seed fake public advertisements. Deployment gates require matching004 install
proof and exact-head tests. The Worker registers one free-plan minute Cron and adds
callback_query to its existing webhook without discarding pending updates.

Automated fixtures exercise consent, province/category filters, non-subscribers,
revoked eligibility, role boundaries, deduplication, concurrent claims,429/403 and
unknown outcomes. They are not real Telegram delivery proof. Record real test results
separately; a generic owner-only test proves the private send/queue path, not a full
hosted advertisement notification or a physical iPhone/Android banner.
