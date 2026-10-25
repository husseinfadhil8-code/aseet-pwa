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

-- Lock conversation identity to the original listing/seller even if a future
-- privileged migration introduces broader INSERT permissions.
create or replace function public.market_validate_thread_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
 if not exists (
   select 1 from public.market_listings l
   where l.id = new.listing_id and l.seller_id = new.seller_id
     and l.status = 'active'
 ) then
   raise exception 'invalid public market conversation';
 end if;
 return new;
end;
$$;
drop trigger if exists market_thread_identity_guard on public.market_threads;
create trigger market_thread_identity_guard before insert on public.market_threads
for each row execute function public.market_validate_thread_identity();

-- Conversation membership and listing identity are immutable after creation.
-- No client UPDATE grant is issued today; this guard protects future changes too.
create or replace function public.market_prevent_thread_reassignment()
returns trigger language plpgsql set search_path = '' as $$
begin
 if new.listing_id is distinct from old.listing_id
    or new.buyer_id is distinct from old.buyer_id
    or new.seller_id is distinct from old.seller_id then
   raise exception 'market conversation participants cannot be changed';
 end if;
 return new;
end;
$$;
drop trigger if exists market_thread_reassignment_guard on public.market_threads;
create trigger market_thread_reassignment_guard
before update on public.market_threads
for each row execute function public.market_prevent_thread_reassignment();
