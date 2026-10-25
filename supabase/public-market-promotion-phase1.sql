-- Paid listing promotion foundation. Not applied to any database.
-- Checkout and activation require an approved merchant gateway and verified server-side webhook.
create table if not exists public.market_promotions (
 id uuid primary key default gen_random_uuid(),
 listing_id uuid not null references public.market_listings(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,
 amount_iqd integer not null default 5000 check(amount_iqd=5000),
 currency text not null default 'IQD' check(currency='IQD'),
 status text not null default 'pending' check(status in ('pending','paid','active','expired','failed','refunded')),
 provider text,
 provider_transaction_id text unique,
 payment_confirmed_at timestamptz,
 starts_at timestamptz,
 ends_at timestamptz,
 created_at timestamptz not null default now(),
 check (status not in ('paid','active','expired') or payment_confirmed_at is not null),
 check (status <> 'active' or (starts_at is not null and ends_at is not null and ends_at > starts_at))
);
create index if not exists market_promotions_listing on public.market_promotions(listing_id,status,ends_at);
create index if not exists market_promotions_buyer on public.market_promotions(buyer_id,created_at desc);
alter table public.market_promotions enable row level security;
revoke all on public.market_promotions from anon,authenticated;
grant select,insert on public.market_promotions to authenticated;
drop policy if exists "market promotions buyer read" on public.market_promotions;
create policy "market promotions buyer read" on public.market_promotions
for select to authenticated using (buyer_id=(select auth.uid()) or exists(
 select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and p.status='approved'
));
drop policy if exists "market promotions buyer request" on public.market_promotions;
create policy "market promotions buyer request" on public.market_promotions
for insert to authenticated with check (
 buyer_id=(select auth.uid()) and status='pending' and amount_iqd=5000
 and provider is null and provider_transaction_id is null
 and payment_confirmed_at is null and starts_at is null and ends_at is null
 and exists (select 1 from public.market_listings l where l.id=listing_id
   and l.seller_id=(select auth.uid()) and l.status='active')
);
-- Deliberately NO authenticated UPDATE permission or policy.
-- Only a trusted server handler may verify payment through the gateway and activate promotion.
-- Never trust a browser redirect or user-provided card data as evidence of payment.

-- Publicly readable view exposes only paid, currently active campaigns;
-- it does not expose the buyer or payment transaction.
create or replace view public.market_active_promotions
with (security_invoker = true) as
select listing_id, max(ends_at) as promoted_until
from public.market_promotions
where status = 'active' and payment_confirmed_at is not null
  and starts_at <= now() and ends_at > now()
group by listing_id;
-- Do not grant SELECT on this view to anonymous clients until a trusted
-- read-only projection is provided: security_invoker honors the private
-- promotion table RLS and therefore would not show other users' promotions.
revoke all on public.market_active_promotions from public, anon, authenticated;
