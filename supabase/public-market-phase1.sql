-- Public classifieds foundation. REVIEW AND TEST ON WASEET-TEST FIRST; never auto-apply to production.
create extension if not exists pgcrypto;
create table if not exists public.market_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 2 and 80),
  created_at timestamptz not null default now()
);
create table if not exists public.market_listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.market_members(user_id) on delete cascade,
  title text not null check(char_length(trim(title)) between 5 and 120),
  description text not null default '' check(char_length(description)<=3000),
  category text not null check(char_length(trim(category)) between 2 and 50),
  area text not null check(char_length(trim(area)) between 2 and 100),
  price bigint not null check(price>=0 and price<=1000000000000),
  condition text not null default 'used' check(condition in ('new','used')),
  negotiable boolean not null default false,
  image_urls text[] not null default '{}'::text[] check(coalesce(array_length(image_urls,1),0)<=5),
  status text not null default 'active' check(status in ('active','sold','hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists market_listings_public_recent on public.market_listings(created_at desc,id desc) where status='active';
create index if not exists market_listings_seller on public.market_listings(seller_id,created_at desc);
alter table public.market_members enable row level security;
alter table public.market_listings enable row level security;
revoke all on public.market_members, public.market_listings from anon,authenticated;
grant select on public.market_listings to anon,authenticated;
grant insert,update,delete on public.market_listings to authenticated;
grant select,insert,update on public.market_members to authenticated;
drop policy if exists "market members read self" on public.market_members;
create policy "market members read self" on public.market_members for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists "market members insert self" on public.market_members;
create policy "market members insert self" on public.market_members for insert to authenticated with check(user_id=(select auth.uid()));
drop policy if exists "market members update self" on public.market_members;
create policy "market members update self" on public.market_members for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
drop policy if exists "public market active read" on public.market_listings;
create policy "public market active read" on public.market_listings for select to anon,authenticated using(
 status='active' or seller_id=(select auth.uid()) or exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and p.status='approved')
);
drop policy if exists "market own inserts" on public.market_listings;
create policy "market own inserts" on public.market_listings for insert to authenticated with check(
 seller_id=(select auth.uid()) and status='active' and exists(select 1 from public.market_members m where m.user_id=(select auth.uid()))
);
drop policy if exists "market own updates" on public.market_listings;
create policy "market own updates" on public.market_listings for update to authenticated using(
 seller_id=(select auth.uid()) or exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and p.status='approved')
) with check(
 seller_id=(select auth.uid()) or exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and p.status='approved')
);
drop policy if exists "market own deletes" on public.market_listings;
create policy "market own deletes" on public.market_listings for delete to authenticated using(
 seller_id=(select auth.uid()) or exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and p.status='approved')
);
-- Public never receives goods/sales/chat/commissions privileges through this migration.
-- Keep market photos separate from private commissioned-goods storage.
