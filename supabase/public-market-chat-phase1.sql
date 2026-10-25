-- Market buyer/seller conversations. REVIEW; apply after public-market-phase1.sql on TEST ONLY.
create table if not exists public.market_threads (
 id uuid primary key default gen_random_uuid(),
 listing_id uuid not null references public.market_listings(id) on delete cascade,
 buyer_id uuid not null references public.market_members(user_id) on delete cascade,
 seller_id uuid not null references public.market_members(user_id) on delete cascade,
 created_at timestamptz not null default now(),
 unique(listing_id,buyer_id),
 check(buyer_id<>seller_id)
);
create table if not exists public.market_messages (
 id uuid primary key default gen_random_uuid(),
 thread_id uuid not null references public.market_threads(id) on delete cascade,
 sender_id uuid not null references public.market_members(user_id) on delete cascade,
 body text not null check(char_length(trim(body)) between 1 and 2000),
 created_at timestamptz not null default now()
);
create index if not exists market_threads_buyer_idx on public.market_threads(buyer_id,created_at desc);
create index if not exists market_threads_seller_idx on public.market_threads(seller_id,created_at desc);
create index if not exists market_messages_thread_idx on public.market_messages(thread_id,created_at);
alter table public.market_threads enable row level security;
alter table public.market_messages enable row level security;
revoke all on public.market_threads,public.market_messages from anon,authenticated;
grant select,insert on public.market_threads,public.market_messages to authenticated;
drop policy if exists "market thread participants read" on public.market_threads;
create policy "market thread participants read" on public.market_threads for select to authenticated
using(buyer_id=(select auth.uid()) or seller_id=(select auth.uid()));
drop policy if exists "market buyer starts thread" on public.market_threads;
create policy "market buyer starts thread" on public.market_threads for insert to authenticated
with check(
 buyer_id=(select auth.uid()) and seller_id<>buyer_id and
 exists(select 1 from public.market_listings l where l.id=listing_id and l.seller_id=seller_id and l.status='active')
);
drop policy if exists "market messages participants read" on public.market_messages;
create policy "market messages participants read" on public.market_messages for select to authenticated
using(exists(select 1 from public.market_threads t where t.id=thread_id and (t.buyer_id=(select auth.uid()) or t.seller_id=(select auth.uid()))));
drop policy if exists "market messages sender insert" on public.market_messages;
create policy "market messages sender insert" on public.market_messages for insert to authenticated
with check(sender_id=(select auth.uid()) and exists(select 1 from public.market_threads t where t.id=thread_id
  and (t.buyer_id=(select auth.uid()) or t.seller_id=(select auth.uid()))));
-- No policy exposes legacy chat_* tables to market members.
