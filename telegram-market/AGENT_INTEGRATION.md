# Agent drafts and services readiness — 28 October 2026

The existing named Mini App is `https://t.me/WaseetIraqMarketBot/market`.
`search_<UTF8-base64url>` opens search, and `draft_<32 hex>` opens a new
listing editor after Telegram authentication. Drafts never carry an owner ID,
phone, source Facebook URL or Telegram identity. Clicking a draft grants no
ownership. Save remains the existing authenticated, owner-checked action and
requires the user's preview and final confirmation.

The `AGENT_DRAFTS` service binding reads only `/public-draft/<token>` from
`smart-ad-radar`. The proxy sanitizes a bounded response. Unknown prices and
conditions stay blank. Non-IQD prices are not converted automatically. Drafts
expire after 90 days and contain only whitelisted nonpersonal product facts.

**Services are not enabled in the hosted database.** `SERVICES_READY=false`
keeps the category unavailable for ordinary publication and blocks forged
service save requests on the server. A service draft can be reviewed, but its
publish button is disabled. Do not change the flag before migration and checks.

`db/007_services.sql` is proposed and tested in isolated PostgreSQL only. It
expands the three Telegram category constraints and the notification category
guard, and adds the `service` condition. Hosted rehearsal could not execute DDL:
the connected management identity is `supabase_read_only_user`, not table owner.
No hosted Supabase schema or user data was changed. An authorized migration
credential for these Telegram objects is needed; the main Waseet app is out of
scope. No automatic migration is part of this deployment.

Validation: seven synthetic intent cases in Agent tests; local editor/search,
preview and save fixtures; isolated PostgreSQL service publishing, searching,
conversations and ownership denial. Hosted draft proxy returned HTTP 200 for a
real user-supplied post. Production editor rendering used a local identity stub
intercepted in the browser, never sent to the server. No real Telegram account,
iPhone, WhatsApp Business launch, live publication or message send was tested.
