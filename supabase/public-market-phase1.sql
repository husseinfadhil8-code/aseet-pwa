-- Public classifieds foundation. REVIEW AND TEST ON WASEET-TEST FIRST; never auto-apply to production.
create extension if not exists pgcrypto;
create or replace function public.market_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.profiles where id=auth.uid() and role='admin' and status='approved');
$$;
revoke all on function public.market_is_admin() from public;
grant execute on function public.market_is_admin() to anon,authenticated;

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
  status text not null default 'active' check(status in ('active','sold','hidden','deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists market_listings_public_recent on public.market_listings(created_at desc,id desc) where status='active';
create index if not exists market_listings_seller on public.market_listings(seller_id,created_at desc);
alter table public.market_members enable row level security;
alter table public.market_listings enable row level security;
revoke all on public.market_members, public.market_listings from public,anon,authenticated;
grant select on public.market_listings to anon,authenticated;
grant insert(seller_id,title,description,category,area,price,condition,negotiable,image_urls,status),update(title,description,category,area,price,condition,negotiable,image_urls,status),delete on public.market_listings to authenticated;
grant select,insert,update on public.market_members to authenticated;
drop policy if exists "market members read self" on public.market_members;
create policy "market members read self" on public.market_members for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists "market members insert self" on public.market_members;
create policy "market members insert self" on public.market_members for insert to authenticated with check(user_id=(select auth.uid()));
drop policy if exists "market members update self" on public.market_members;
create policy "market members update self" on public.market_members for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
drop policy if exists "public market active read" on public.market_listings;
create policy "public market active read" on public.market_listings for select to anon,authenticated using(
 status='active' or seller_id=(select auth.uid()) or public.market_is_admin()
);
drop policy if exists "market own inserts" on public.market_listings;
create policy "market own inserts" on public.market_listings for insert to authenticated with check(
 seller_id=(select auth.uid()) and status='active' and exists(select 1 from public.market_members m where m.user_id=(select auth.uid()))
);
drop policy if exists "market own updates" on public.market_listings;
create policy "market own updates" on public.market_listings for update to authenticated using(
 seller_id=(select auth.uid()) or public.market_is_admin()
) with check(
 seller_id=(select auth.uid()) or public.market_is_admin()
);
drop policy if exists "market own deletes" on public.market_listings;
create policy "market own deletes" on public.market_listings for delete to authenticated using(
 seller_id=(select auth.uid()) or public.market_is_admin()
);
-- Prevent reassignment of an existing classified to another account.
-- A user may edit their own listing but must never change seller_id.
create or replace function public.market_prevent_listing_owner_change()
returns trigger language plpgsql set search_path = '' as $$
begin
 if new.seller_id is distinct from old.seller_id then
  raise exception 'listing owner cannot be changed';
 end if;
 return new;
end;
$$;
drop trigger if exists market_listing_owner_guard on public.market_listings;
create trigger market_listing_owner_guard before update on public.market_listings
for each row execute function public.market_prevent_listing_owner_change();

-- A seller cannot unhide a listing that moderation has hidden.
-- Approved staff admins retain authority to restore moderated listings.
create or replace function public.market_guard_moderated_listing()
returns trigger language plpgsql set search_path = '' as $$
begin
 if (old.status = 'hidden' or old.status='deleted')
   and not public.market_is_admin() then
  raise exception 'moderated listing cannot be modified by its seller';
 end if;
 return new;
end;
$$;
drop trigger if exists market_moderation_guard on public.market_listings;
create trigger market_moderation_guard before update on public.market_listings
for each row execute function public.market_guard_moderated_listing();

-- Keep moderated listing evidence available for review: sellers may not delete
-- a hidden listing, because deleting it cascades into its reports.
create or replace function public.market_guard_moderated_listing_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
 if (old.status = 'hidden' or old.status='deleted') and not public.market_is_admin() then
  raise exception 'moderated listing cannot be deleted by its seller';
 end if;
 return old;
end;
$$;
drop trigger if exists market_moderation_delete_guard on public.market_listings;
create trigger market_moderation_delete_guard before delete on public.market_listings
for each row execute function public.market_guard_moderated_listing_delete();

-- Protect seller identity from forged public listing image URLs or owner edits.
-- Uploaded files must belong to the listing owner and the dedicated public bucket.
-- External HTTPS links remain supported by the existing client.
create or replace function public.market_validate_listing_images()
returns trigger language plpgsql set search_path = '' as $$
declare
 image_url text;
 owner_prefix text;
begin
 owner_prefix := '/storage/v1/object/public/market-listing-images/' || new.seller_id::text || '/';
 foreach image_url in array new.image_urls loop
  if image_url !~ '^https://' then
   raise exception 'listing image URL must use HTTPS';
  end if;
  if position('/storage/v1/object/public/market-listing-images/' in image_url) > 0
     and position(owner_prefix in image_url) = 0 then
   raise exception 'listing image belongs to a different seller';
  end if;
 end loop;
 return new;
end;
$$;
drop trigger if exists market_listing_image_guard on public.market_listings;
create trigger market_listing_image_guard before insert or update on public.market_listings
for each row execute function public.market_validate_listing_images();

-- Public never receives goods/sales/chat/commissions privileges through this migration.
-- Keep market photos separate from private commissioned-goods storage.

-- Separate public bucket; commission inventory photos stay isolated.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('market-listing-images','market-listing-images',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
drop policy if exists "market photos publicly read" on storage.objects;
create policy "market photos publicly read" on storage.objects for select to anon,authenticated
using(bucket_id='market-listing-images');
drop policy if exists "market members upload own photos" on storage.objects;
create policy "market members upload own photos" on storage.objects for insert to authenticated
with check(bucket_id='market-listing-images' and (storage.foldername(name))[1]=(select auth.uid())::text
 and exists(select 1 from public.market_members m where m.user_id=(select auth.uid())));
drop policy if exists "market members delete own photos" on storage.objects;
create policy "market members delete own photos" on storage.objects for delete to authenticated
using(bucket_id='market-listing-images' and (storage.foldername(name))[1]=(select auth.uid())::text);
