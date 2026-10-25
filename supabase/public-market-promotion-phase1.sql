-- DRAFT ONLY. Dependency: public-market-phase1.sql. Not applied to hosted databases.
-- Manual SuperQi merchant QR; no gateway/API assumptions or client payment authority.
create or replace function public.market_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.profiles where id=auth.uid() and role='admin' and status='approved');
$$;
revoke all on function public.market_is_admin() from public;
grant execute on function public.market_is_admin() to anon,authenticated;
create table public.market_payment_settings (
 id boolean primary key default true check(id),
 enabled boolean not null default false,
 merchant_name text not null default '' check(length(merchant_name)<=120),
 qr_url text not null default '' check(qr_url='' or qr_url ~ '^https://'),
 instructions text not null default '' check(length(instructions)<=1000)
);
alter table public.market_payment_settings enable row level security;
revoke all on public.market_payment_settings from public,anon,authenticated;
grant select on public.market_payment_settings to anon,authenticated;
grant insert,update on public.market_payment_settings to authenticated;
create policy "market payment settings read" on public.market_payment_settings for select using(true);
create policy "market payment settings admin insert" on public.market_payment_settings for insert to authenticated with check(public.market_is_admin());
create policy "market payment settings admin update" on public.market_payment_settings for update to authenticated using(public.market_is_admin()) with check(public.market_is_admin());
insert into public.market_payment_settings(id) values(true);
create table public.market_promotions (
 id uuid primary key default gen_random_uuid(),
 listing_id uuid not null references public.market_listings(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,
 amount_iqd integer not null default 5000 check(amount_iqd=5000),
 currency text not null default 'IQD' check(currency='IQD'),
 status text not null default 'awaiting_payment' check(status in ('awaiting_payment','awaiting_verification','paid','active','expired','rejected')),
 provider text not null default 'manual_qr' check(provider in ('manual_qr','qi_gateway')),
 provider_transaction_id text unique,
 payment_confirmed_at timestamptz,
 confirmed_by uuid references auth.users(id),
 starts_at timestamptz,
 ends_at timestamptz,
 created_at timestamptz not null default now(),
 check(status not in ('paid','active','expired') or (payment_confirmed_at is not null and provider_transaction_id is not null and confirmed_by is not null)),
 check(status not in ('active','expired') or (starts_at is not null and ends_at is not null and ends_at = starts_at + interval '7 days'))
);
create unique index market_one_open_promotion on public.market_promotions(listing_id)
 where status in ('awaiting_payment','awaiting_verification','paid','active');
create index market_promotions_buyer on public.market_promotions(buyer_id,created_at desc);
create table public.market_promotion_events (
 id bigint generated always as identity primary key,
 promotion_id uuid not null references public.market_promotions(id),
 actor_id uuid not null references auth.users(id),
 action text not null,
 created_at timestamptz not null default now()
);
alter table public.market_promotions enable row level security;
alter table public.market_promotion_events enable row level security;
revoke all on public.market_promotions,public.market_promotion_events from public,anon,authenticated;
grant select on public.market_promotions,public.market_promotion_events to authenticated;
create policy "market promotion private read" on public.market_promotions for select to authenticated using(buyer_id=auth.uid() or public.market_is_admin());
create policy "market promotion audit admin" on public.market_promotion_events for select to authenticated using(public.market_is_admin());
-- All mutations through narrow, audited functions. No direct client INSERT/UPDATE.
create or replace function public.market_request_promotion(p_listing uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
 if auth.uid() is null then raise exception 'authentication required'; end if;
 if not public.market_member_can_write() then raise exception 'market account unavailable'; end if;
 -- Listing lock serializes requests, moderation and activation in the same order.
 perform 1 from public.market_listings where id=p_listing and seller_id=auth.uid() and status='active' for update;
 if not found then raise exception 'listing unavailable'; end if;
 if not exists(select 1 from public.market_payment_settings where id and enabled and qr_url<>'' and merchant_name<>'') then raise exception 'payment unavailable'; end if;
 update public.market_promotions set status='expired' where listing_id=p_listing and status='active' and ends_at<=now();
 select id into result from public.market_promotions where listing_id=p_listing and status in ('awaiting_payment','awaiting_verification','paid','active');
 if result is not null then return result; end if;
 insert into public.market_promotions(listing_id,buyer_id) values(p_listing,auth.uid()) returning id into result;
 insert into public.market_promotion_events(promotion_id,actor_id,action) values(result,auth.uid(),'requested');
 return result;
end;
$$;
create or replace function public.market_submit_payment(p_order uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
 update public.market_promotions set status='awaiting_verification' where id=p_order and buyer_id=auth.uid() and status='awaiting_payment';
 if found then insert into public.market_promotion_events(promotion_id,actor_id,action) values(p_order,auth.uid(),'submitted_for_verification'); end if;
end;
$$;
create or replace function public.market_review_promotion(p_order uuid,p_action text,p_reference text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.market_promotions; target uuid;
begin
 if not public.market_is_admin() then raise exception 'admin required'; end if;
 select listing_id into target from public.market_promotions where id=p_order;
 perform 1 from public.market_listings where id=target for update;
 select * into r from public.market_promotions where id=p_order for update;
 if r.id is null then raise exception 'order unavailable'; end if;
 if p_action='confirm' then
  if r.status in ('paid','active','expired') then return; end if;
  if r.status<>'awaiting_verification' or length(trim(coalesce(p_reference,''))) not between 3 and 120 then raise exception 'verified merchant transaction required'; end if;
  -- A unique merchant transaction reference cannot pay two orders.
  update public.market_promotions set status='paid',provider_transaction_id=trim(p_reference),payment_confirmed_at=now(),confirmed_by=auth.uid() where id=p_order;
 elsif p_action='activate' then
  if r.status='active' then return; end if;
  if r.status<>'paid' then raise exception 'confirmed payment required'; end if;
  if not exists(select 1 from public.market_listings where id=r.listing_id and status='active') then raise exception 'listing unavailable'; end if;
  if exists(select 1 from public.market_reports where listing_id=r.listing_id and status='open') then raise exception 'unreviewed report'; end if;
  update public.market_promotions set status='active',starts_at=now(),ends_at=now()+interval '7 days' where id=p_order;
 elsif p_action='reject' then
  if r.status='rejected' then return; end if;
  if r.status not in ('awaiting_payment','awaiting_verification') then raise exception 'paid orders require separate financial review'; end if;
  update public.market_promotions set status='rejected' where id=p_order;
 else raise exception 'unsupported action'; end if;
 insert into public.market_promotion_events(promotion_id,actor_id,action) values(p_order,auth.uid(),p_action);
end;
$$;
-- Safe public projection: no buyer, payment reference or financial records exposed.
create or replace function public.market_promoted_listings()
returns table(listing_id uuid,promoted_until timestamptz) language sql stable security definer set search_path = '' as $$
 select p.listing_id,max(p.ends_at) from public.market_promotions p
 join public.market_listings l on l.id=p.listing_id and l.status='active'
 where p.status='active' and p.payment_confirmed_at is not null and p.starts_at<=now() and p.ends_at>now()
 and not exists(select 1 from public.market_reports r where r.listing_id=p.listing_id and r.status='open')
 group by p.listing_id;
$$;
revoke all on function public.market_request_promotion(uuid),public.market_submit_payment(uuid),public.market_review_promotion(uuid,text,text),public.market_promoted_listings() from public;
grant execute on function public.market_request_promotion(uuid),public.market_submit_payment(uuid),public.market_review_promotion(uuid,text,text) to authenticated;
grant execute on function public.market_promoted_listings() to anon,authenticated;
-- No automatic schedule or payment webhook is enabled. Future Qi gateway must verify
-- signed server callbacks and unique transaction IDs before sharing this ledger.
-- Invoker view preserves listing RLS. Server time determines promotion visibility.
create view public.market_browse with (security_invoker=true) as
 select l.*,exists(select 1 from public.market_promoted_listings() p where p.listing_id=l.id) as is_promoted
 from public.market_listings l;
grant select on public.market_browse to anon,authenticated;
-- Market account moderation stays separate from staff roles/permissions.
alter table public.market_members add column suspended boolean not null default false;
revoke insert,update on public.market_members from authenticated;
grant insert(user_id,display_name),update(display_name) on public.market_members to authenticated;
create policy "market members admin read" on public.market_members for select to authenticated using(public.market_is_admin());
create or replace function public.market_member_can_write()
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.market_members where user_id=auth.uid() and not suspended)
 and not exists(select 1 from public.profiles where id=auth.uid() and status in ('banned','removed'));
$$;
revoke all on function public.market_member_can_write() from public;
grant execute on function public.market_member_can_write() to authenticated;
create or replace function public.market_require_writable_member()
returns trigger language plpgsql set search_path='' as $$
begin
 if not public.market_is_admin() then
  if not public.market_member_can_write() then raise exception 'market account unavailable'; end if;
  -- One per-account transaction lock closes concurrent quota bypasses. Client
  -- column grants prevent falsifying timestamps to evade these windows.
  if TG_OP='INSERT' then
   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,714));
   if TG_TABLE_NAME='market_listings' then
    if (select count(*) from public.market_listings where seller_id=auth.uid() and created_at>now()-interval '1 hour')>=10 then raise exception 'listing rate limit'; end if;
   elsif TG_TABLE_NAME='market_threads' then
    if (select count(*) from public.market_threads where buyer_id=auth.uid() and created_at>now()-interval '1 hour')>=20 then raise exception 'conversation rate limit'; end if;
   elsif TG_TABLE_NAME='market_messages' then
    if (select count(*) from public.market_messages where sender_id=auth.uid() and created_at>now()-interval '1 minute')>=40 then raise exception 'message rate limit'; end if;
   elsif TG_TABLE_NAME='market_reports' then
    if (select count(*) from public.market_reports where reporter_id=auth.uid() and created_at>now()-interval '1 hour')>=10 then raise exception 'report rate limit'; end if;
   end if;
  end if;
 end if;
 return new;
end;
$$;
create trigger market_listing_member_guard before insert or update on public.market_listings for each row execute function public.market_require_writable_member();
create trigger market_thread_member_guard before insert on public.market_threads for each row execute function public.market_require_writable_member();
create trigger market_message_member_guard before insert on public.market_messages for each row execute function public.market_require_writable_member();
create trigger market_report_member_guard before insert on public.market_reports for each row execute function public.market_require_writable_member();
create trigger market_favorite_member_guard before insert on public.market_favorites for each row execute function public.market_require_writable_member();
create table public.market_moderation_events (
 id bigint generated always as identity primary key,
 actor_id uuid not null references auth.users(id),
 member_id uuid not null references auth.users(id),
 suspended boolean not null,
 created_at timestamptz not null default now()
);
alter table public.market_moderation_events enable row level security;
revoke all on public.market_moderation_events from public,anon,authenticated;
grant select on public.market_moderation_events to authenticated;
create policy "market moderation audit admin" on public.market_moderation_events for select to authenticated using(public.market_is_admin());
create or replace function public.market_suspend_member(p_user uuid,p_suspended boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.market_is_admin() or p_user=auth.uid() then raise exception 'admin moderation required'; end if;
 update public.market_members set suspended=p_suspended where user_id=p_user;
 if not found then raise exception 'member unavailable'; end if;
 if p_suspended then update public.market_listings set status='hidden' where seller_id=p_user and status='active'; end if;
 -- Unblocking never automatically restores a moderated listing or its promotion.
 insert into public.market_moderation_events(actor_id,member_id,suspended) values(auth.uid(),p_user,p_suspended);
end;
$$;
revoke all on function public.market_suspend_member(uuid,boolean) from public;
grant execute on function public.market_suspend_member(uuid,boolean) to authenticated;

-- Removing an ad preserves immutable financial/report history instead of breaking
-- the foreign key or deleting a paid transaction. Removed ads cannot be restored by sellers.
create or replace function public.market_delete_listing(p_listing uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r public.market_listings;
begin
 select * into r from public.market_listings where id=p_listing for update;
 if r.id is null or (r.seller_id is distinct from auth.uid() and not public.market_is_admin()) then raise exception 'listing unavailable'; end if;
 if r.status='deleted' then return; end if;
 if r.status='hidden' and not public.market_is_admin() then raise exception 'moderation review required'; end if;
 update public.market_listings set status='deleted' where id=p_listing;
end;
$$;
revoke all on function public.market_delete_listing(uuid) from public;
grant execute on function public.market_delete_listing(uuid) to authenticated;
-- Full market totals, not an inference from the current page. No public financial RPC.
create or replace function public.market_admin_statistics()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.market_is_admin() then raise exception 'admin required'; end if;
 return jsonb_build_object(
  'members',(select count(*) from public.market_members),
  'suspended_members',(select count(*) from public.market_members where suspended),
  'active_listings',(select count(*) from public.market_listings where status='active'),
  'sold_listings',(select count(*) from public.market_listings where status='sold'),
  'hidden_listings',(select count(*) from public.market_listings where status='hidden'),
  'open_reports',(select count(*) from public.market_reports where status='open'),
  'payment_review',(select count(*) from public.market_promotions where status='awaiting_verification'),
  'paid_orders',(select count(*) from public.market_promotions where payment_confirmed_at is not null),
  'confirmed_gross_iqd',(select coalesce(sum(amount_iqd),0) from public.market_promotions where payment_confirmed_at is not null),
  'active_promotions',(select count(*) from public.market_promoted_listings())
 );
end;
$$;
revoke all on function public.market_admin_statistics() from public;
grant execute on function public.market_admin_statistics() to authenticated;
