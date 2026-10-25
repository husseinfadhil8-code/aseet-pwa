-- Public market favorites and abuse reports; apply on Test only after public-market-phase1.sql.
create table if not exists public.market_favorites (
 user_id uuid not null references public.market_members(user_id) on delete cascade,
 listing_id uuid not null references public.market_listings(id) on delete cascade,
 created_at timestamptz not null default now(),
 primary key(user_id,listing_id)
);
create table if not exists public.market_reports (
 id uuid primary key default gen_random_uuid(),
 listing_id uuid not null references public.market_listings(id) on delete cascade,
 reporter_id uuid not null references public.market_members(user_id) on delete cascade,
 reason text not null check(reason in ('scam','wrong_info','prohibited','duplicate','other')),
 notes text not null default '' check(char_length(notes)<=500),
 status text not null default 'open' check(status in ('open','reviewed','closed')),
 created_at timestamptz not null default now(),
 unique(listing_id,reporter_id)
);
create index if not exists market_reports_review_idx on public.market_reports(created_at desc) where status='open';
alter table public.market_favorites enable row level security;
alter table public.market_reports enable row level security;
revoke all on public.market_favorites,public.market_reports from anon,authenticated;
grant select,insert,delete on public.market_favorites to authenticated;
grant select,insert on public.market_reports to authenticated;
drop policy if exists "market favorites owner read" on public.market_favorites;
create policy "market favorites owner read" on public.market_favorites for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists "market favorites owner add" on public.market_favorites;
create policy "market favorites owner add" on public.market_favorites for insert to authenticated with check(user_id=(select auth.uid()));
drop policy if exists "market favorites owner remove" on public.market_favorites;
create policy "market favorites owner remove" on public.market_favorites for delete to authenticated using(user_id=(select auth.uid()));
drop policy if exists "market reports owner and admin read" on public.market_reports;
create policy "market reports owner and admin read" on public.market_reports for select to authenticated using(
 reporter_id=(select auth.uid()) or exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and p.status='approved')
);
drop policy if exists "market reports own insert" on public.market_reports;
create policy "market reports own insert" on public.market_reports for insert to authenticated with check(
 reporter_id=(select auth.uid()) and status='open'
 and exists (
   select 1 from public.market_listings l
   where l.id=listing_id and l.status='active'
 )
);
-- Admin report status moderation requires an audited server-side RPC in next release.

-- The only mutable report attribute is status, and only approved admins pass RLS.
grant update(status) on public.market_reports to authenticated;
drop policy if exists "market reports admin review" on public.market_reports;
create policy "market reports admin review" on public.market_reports for update to authenticated
using(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and p.status='approved'))
with check(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and p.status='approved'));
