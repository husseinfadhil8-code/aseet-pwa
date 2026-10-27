-- Telegram namespace only. Rehearse and back up verified Test before install.
create table public.tg_market_private_identity(user_id uuid primary key references public.tg_market_users(id) on delete cascade,original_name text not null,created_at timestamptz not null default now());
create table public.tg_market_settings(singleton boolean primary key default true check(singleton),channel text,channel_title text,channel_verified boolean not null default false,auto_publish boolean not null default false,purchases_enabled boolean not null default false,payments_verified boolean not null default false,updated_at timestamptz not null default now());
insert into public.tg_market_settings(singleton) values(true);
create table public.tg_market_packages(id uuid primary key default gen_random_uuid(),name text not null check(length(trim(name)) between 2 and 80),description text not null default '' check(length(description)<=500),stars integer check(stars between 1 and 100000),days integer not null check(days between 1 and 365),priority integer not null default 100 check(priority between 0 and 1000),enabled boolean not null default false,version integer not null default 1,updated_at timestamptz not null default now(),check(not enabled or stars is not null));
insert into public.tg_market_packages(name,days) values('ترويج يوم واحد',1),('ترويج 7 أيام',7),('ترويج 14 يوماً',14),('ترويج 30 يوماً',30);
alter table public.tg_market_listings add column approved_at timestamptz,add column approved_by uuid references public.tg_market_users(id);
create function public.tg_market_reset_approval() returns trigger language plpgsql set search_path='' as $$begin
 if row(old.title,old.description,old.price,old.area,old.category,old.images,old.condition,old.negotiable,old.status) is distinct from row(new.title,new.description,new.price,new.area,new.category,new.images,new.condition,new.negotiable,new.status) then new.approved_at:=null;new.approved_by:=null;end if;return new;
end$$;
create trigger tg_market_reset_approval before update on public.tg_market_listings for each row execute function public.tg_market_reset_approval();
create table public.tg_market_publications(id uuid primary key default gen_random_uuid(),listing_id uuid not null references public.tg_market_listings(id),request_key uuid unique not null,channel text not null,approval_time timestamptz not null,state text not null default 'queued' check(state in ('queued','sending','sent','review','cancelled')),message_id bigint,created_at timestamptz not null default now());
create index tg_market_publication_listing on public.tg_market_publications(listing_id,created_at desc);
alter table public.tg_market_orders add column checkout_id text,add column checkout_reserved_at timestamptz,add column package_id uuid references public.tg_market_packages(id),add column snapshot_name text not null default 'ترويج وسيط',add column snapshot_description text not null default '',add column promotion_priority integer not null default 100,add column is_test boolean not null default false;
do $$declare n integer;name text;begin
 select count(*),min(conname) into n,name from pg_constraint where conrelid='public.tg_market_orders'::regclass and contype='c' and pg_get_constraintdef(oid) like '%duration_days%' and pg_get_constraintdef(oid) not like '%ends_at%';if n<>1 then raise exception 'review duration constraint';end if;execute format('alter table public.tg_market_orders drop constraint %I',name);
end$$;
alter table public.tg_market_orders add constraint tg_market_days_bounded check(duration_days between 1 and 365);
do $$declare t text;begin foreach t in array array['private_identity','settings','packages','publications'] loop execute format('alter table public.%I enable row level security','tg_market_'||t);execute format('revoke all on public.%I from public,anon,authenticated','tg_market_'||t);end loop;end$$;
create function public.tg_market_identity(p_user uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select case when exists(select 1 from public.tg_market_root r join public.tg_market_users u on u.id=r.user_id where r.user_id=p_user and u.role='admin' and not u.banned) then jsonb_build_object('name','مدير وسيط','subtitle','الإدارة الرسمية لمنصة وسيط','verified_internal',true,'verification_source','waseet_internal') else jsonb_build_object('name','مستخدم وسيط','subtitle','','verified_internal',false) end;
$$;
create function public.tg_market_offers() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('purchasable',s.purchases_enabled and s.payments_verified) order by p.priority,p.days,p.id),'[]') from public.tg_market_packages p cross join public.tg_market_settings s where p.enabled and p.stars is not null;
$$;
-- Public feed returns only server-derived identity, never Telegram personal names.
create or replace function public.tg_market_public(p_query text default '',p_category text default '',p_min bigint default 0,p_max bigint default 1000000000000,p_offset integer default 0) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(q)),'[]') from(
 select l.*,public.tg_market_identity(l.owner_id) as author,coalesce(p.sponsored,false) as sponsored from public.tg_market_listings l join public.tg_market_users u on u.id=l.owner_id and not u.banned left join lateral(select true as sponsored,o.promotion_priority from public.tg_market_orders o where o.listing_id=l.id and o.status='active' and not o.is_test and o.ends_at>now() and o.starts_at<=now() and not exists(select 1 from public.tg_market_reports r where r.listing_id=l.id and r.status='open') limit 1)p on true
 where l.status='active' and(p_category='' or l.category=p_category) and l.price between greatest(0,p_min) and least(p_max,1000000000000) and(p_query='' or l.title ilike '%'||left(p_query,60)||'%' or l.area ilike '%'||left(p_query,60)||'%') order by coalesce(p.sponsored,false) desc,p.promotion_priority nulls last,l.created_at desc,l.id desc limit 20 offset least(greatest(p_offset,0),10000))q;
$$;
create function public.tg_market_listing(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$ select to_jsonb(l)||jsonb_build_object('author',public.tg_market_identity(l.owner_id)) from public.tg_market_listings l join public.tg_market_users u on u.id=l.owner_id and not u.banned where l.id=p_id and l.status='active';$$;
alter function public.tg_market_action(bigint,text,jsonb,boolean,text) rename to tg_market_action_v2;
revoke all on function public.tg_market_action_v2(bigint,text,jsonb,boolean,text) from service_role;
create function public.tg_market_action(p_actor bigint,p_action text,p_data jsonb default '{}',p_admin boolean default false,p_name text default 'مستخدم') returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.tg_market_users;root_id uuid;result jsonb;cfg public.tg_market_settings;pack public.tg_market_packages;ad public.tg_market_listings;pub public.tg_market_publications;ord public.tg_market_orders;is_owner boolean;key uuid;repost boolean;test_order boolean;
begin
 result:=public.tg_market_action_v2(p_actor,'me','{}',p_admin,p_name);
 select * into u from public.tg_market_users where telegram_id=p_actor;select user_id into root_id from public.tg_market_root where singleton;is_owner:=u.id=root_id and u.role='admin' and not u.banned;
 if is_owner then
  if u.display_name not in ('مدير وسيط','مدير وسيط ✅') then insert into public.tg_market_private_identity(user_id,original_name) values(u.id,u.display_name) on conflict do nothing;end if;
  update public.tg_market_users set display_name='مدير وسيط' where id=u.id and display_name<>'مدير وسيط';
 end if;
 if p_action='me' then return result||case when is_owner then jsonb_build_object('name','مدير وسيط','subtitle','الإدارة الرسمية لمنصة وسيط','verified_internal',true,'verification_source','waseet_internal') else jsonb_build_object('verified_internal',false) end;end if;
 if u.banned and p_action not in ('orders','support') then raise exception 'account unavailable';end if;
 if p_action in ('settings','packages_save','purchases_save','channel_save','admin_listing_approve','publication_queue','publication_claim','publication_finish','publication_resolve','channel_pause','checkout_release') and not coalesce(is_owner,false) then raise exception 'owner required';end if;
 select * into cfg from public.tg_market_settings where singleton;
 if p_action='settings' then return to_jsonb(cfg)||jsonb_build_object('packages',coalesce((select jsonb_agg(to_jsonb(p) order by priority,days,id) from public.tg_market_packages p),'[]'),'publications',coalesce((select jsonb_agg(to_jsonb(q)) from(select * from public.tg_market_publications order by created_at desc limit 50)q),'[]'));end if;
 if p_action='packages_save' then
  if p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'confirmation required';end if;
  if p_data->>'id' is null then insert into public.tg_market_packages(name,description,stars,days,priority,enabled) values(trim(p_data->>'name'),coalesce(p_data->>'description',''),nullif(p_data->>'stars','')::integer,(p_data->>'days')::int,coalesce((p_data->>'priority')::int,100),coalesce((p_data->>'enabled')::boolean,false)) returning * into pack;
  else update public.tg_market_packages set name=trim(p_data->>'name'),description=coalesce(p_data->>'description',''),stars=nullif(p_data->>'stars','')::int,days=(p_data->>'days')::int,priority=(p_data->>'priority')::int,enabled=(p_data->>'enabled')::boolean,version=version+1,updated_at=now() where id=(p_data->>'id')::uuid and version=(p_data->>'version')::int returning * into pack;if not found then raise exception 'package version conflict';end if;end if;
  insert into public.tg_market_audit(actor,action,target) values(u.id,'package_updated',to_jsonb(pack)::text);return to_jsonb(pack);
 end if;
 if p_action='purchases_save' then
  if jsonb_typeof(p_data->'enabled') is distinct from 'boolean' then raise exception 'boolean required';end if;
  if p_data->'enabled'='true'::jsonb and not cfg.payments_verified then raise exception 'payment test required';end if;
  update public.tg_market_settings set purchases_enabled=coalesce((p_data->>'enabled')::boolean,false),updated_at=now() where singleton;return '{}';
 end if;
 -- Internal action: Worker validates Telegram channel permissions before invoking.
 if p_action='channel_pause' then update public.tg_market_settings set auto_publish=false,updated_at=now() where singleton;return '{}';end if;
 if p_action='channel_save' then
  if p_data->>'channel' is null or p_data->>'channel' !~ '^(-100[0-9]+|@[A-Za-z][A-Za-z0-9_]{4,})$' then raise exception 'invalid channel';end if;
  update public.tg_market_settings set channel=p_data->>'channel',channel_title=left(p_data->>'title',200),channel_verified=true,auto_publish=coalesce((p_data->>'auto')::boolean,false),updated_at=now() where singleton;return '{}';
 end if;
 if p_action='admin_listing_approve' then
  select * into ad from public.tg_market_listings where id=(p_data->>'id')::uuid for update;
  if ad.id is null or ad.status<>'active' or exists(select 1 from public.tg_market_users where id=ad.owner_id and banned) or exists(select 1 from public.tg_market_reports where listing_id=ad.id and status='open') then raise exception 'listing unavailable';end if;
  if ad.approved_at is null then update public.tg_market_listings set approved_at=clock_timestamp(),approved_by=u.id where id=ad.id returning * into ad;end if;
  insert into public.tg_market_audit(actor,action,target) values(u.id,'listing_approved',ad.id::text);
  if cfg.auto_publish and cfg.channel_verified then return public.tg_market_action(p_actor,'publication_queue',jsonb_build_object('id',ad.id,'key',gen_random_uuid()),false,p_name);end if;return jsonb_build_object('approved',true);
 end if;
 if p_action='publication_queue' then
  key:=(p_data->>'key')::uuid;if key is null then raise exception 'request key required';end if;
  select * into pub from public.tg_market_publications where request_key=key;
  if pub.id is not null then if pub.listing_id<>(p_data->>'id')::uuid then raise exception 'request conflict';end if;return to_jsonb(pub);end if;
  select * into ad from public.tg_market_listings where id=(p_data->>'id')::uuid for update;
  if not cfg.channel_verified or cfg.channel is null or ad.id is null or ad.status<>'active' or ad.approved_at is null or exists(select 1 from public.tg_market_reports where listing_id=ad.id and status='open') or exists(select 1 from public.tg_market_users where id=ad.owner_id and banned) then raise exception 'approved listing and channel required';end if;
  repost:=coalesce((p_data->>'repost')::boolean,false);
  select * into pub from public.tg_market_publications where listing_id=ad.id and channel=cfg.channel and state<>'cancelled' and (approval_time=ad.approved_at or state in ('sending','review')) order by created_at desc limit 1;
  if pub.id is not null and (not repost or pub.state in ('sending','review','queued')) then return to_jsonb(pub);end if;
  if repost and exists(select 1 from public.tg_market_publications where listing_id=ad.id and created_at>now()-interval '5 minutes') then raise exception 'repost cooldown';end if;
  insert into public.tg_market_publications(listing_id,request_key,channel,approval_time) values(ad.id,key,cfg.channel,ad.approved_at) returning * into pub;return to_jsonb(pub);
 end if;
 if p_action='publication_claim' then
  select * into pub from public.tg_market_publications where id=(p_data->>'id')::uuid for update;
  if pub.id is null then raise exception 'publication unavailable';end if;
  if pub.state<>'queued' then return jsonb_build_object('dispatch',false,'state',pub.state);end if;
  select * into ad from public.tg_market_listings where id=pub.listing_id;
  if ad.status<>'active' or ad.approved_at is distinct from pub.approval_time or cfg.channel is distinct from pub.channel or not cfg.channel_verified or exists(select 1 from public.tg_market_users where id=ad.owner_id and banned) or exists(select 1 from public.tg_market_reports where listing_id=ad.id and status='open') then raise exception 'publication unavailable';end if;
  update public.tg_market_publications set state='sending' where id=pub.id;
  return jsonb_build_object('dispatch',true,'publication',pub.id,'channel',pub.channel,'listing',to_jsonb(ad));
 end if;
 if p_action='publication_resolve' then
  if p_data->'confirmed' is distinct from 'true'::jsonb or p_data->>'resolution' not in ('sent','not_sent') then raise exception 'confirmation required';end if;
  if p_data->>'resolution'='sent' and coalesce((p_data->>'message')::bigint,0)<=0 then raise exception 'message reference required';end if;
  update public.tg_market_publications set state=case when p_data->>'resolution'='sent' then 'sent' else 'cancelled' end,message_id=(p_data->>'message')::bigint where id=(p_data->>'id')::uuid and state in ('review','sending','queued') and (state<>'sending' or created_at<now()-interval '1 minute');if not found then raise exception 'publication still in flight or unavailable';end if;
  insert into public.tg_market_audit(actor,action,target) values(u.id,'publication_resolved',p_data::text);return '{}';
 end if;
 if p_action='publication_finish' then
  if p_data->>'state' not in ('sent','review') then raise exception 'invalid publication state';end if;
  update public.tg_market_publications set state=p_data->>'state',message_id=(p_data->>'message')::bigint where id=(p_data->>'id')::uuid and state='sending';return '{}';
 end if;
 if p_action='checkout_release' then
  if p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'confirmation required';end if;
  update public.tg_market_orders set checkout_id=null,checkout_reserved_at=null where id=(p_data->>'id')::uuid and status='pending' and charge_id is null and checkout_reserved_at<now()-interval '10 minutes';if not found then raise exception 'checkout still in flight or unavailable';end if;
  insert into public.tg_market_audit(actor,action,target) values(u.id,'checkout_reviewed_unpaid',p_data->>'id');return '{}';
 end if;
 if p_action='order_resume' then
  select * into ord from public.tg_market_orders where id=(p_data->>'id')::uuid and user_id=u.id and status='pending';
  if ord.id is null or not exists(select 1 from public.tg_market_listings where id=ord.listing_id and status='active') then raise exception 'order unavailable';end if;
  if (ord.is_test and not coalesce(is_owner,false)) or(not ord.is_test and(not cfg.purchases_enabled or not cfg.payments_verified)) then raise exception 'payment test required';end if;return to_jsonb(ord)-'charge_id';
 end if;
 if p_action='order' then
  test_order:=coalesce((p_data->>'test')::boolean,false);if test_order and not coalesce(is_owner,false) then raise exception 'owner required';end if;
  if not test_order and(not cfg.purchases_enabled or not cfg.payments_verified) then raise exception 'payment test required';end if;
  select * into pack from public.tg_market_packages where id=(p_data->>'package')::uuid and enabled and stars is not null;if pack.id is null then raise exception 'package unavailable';end if;
  select * into ad from public.tg_market_listings where id=(p_data->>'id')::uuid for update;
  if ad.owner_id is distinct from u.id or ad.status<>'active' or exists(select 1 from public.tg_market_reports where listing_id=ad.id and status='open') then raise exception 'listing unavailable';end if;
  update public.tg_market_orders set status='expired' where listing_id=ad.id and status='active' and ends_at<=now();
  select * into ord from public.tg_market_orders where listing_id=ad.id and status in ('pending','paid','active');
  if ord.id is not null then if ord.package_id is distinct from pack.id or ord.is_test<>test_order then raise exception 'existing campaign differs';end if;return to_jsonb(ord)-'charge_id';end if;
  insert into public.tg_market_orders(user_id,listing_id,stars,duration_days,package_id,snapshot_name,snapshot_description,promotion_priority,is_test) values(u.id,ad.id,pack.stars,pack.days,pack.id,pack.name,pack.description,pack.priority,test_order) returning * into ord;return to_jsonb(ord)-'charge_id';
 end if;
 -- Block legacy channel RPCs, whose approval rules predate the current outbox.
 if p_action in ('channel_claim','channel_finish') then raise exception 'retired channel action';end if;
 result:=public.tg_market_action_v2(p_actor,p_action,p_data,p_admin,p_name);
 if p_action in ('messages','send') then return coalesce((select jsonb_agg(value||jsonb_build_object('author',public.tg_market_identity((value->>'sender_id')::uuid)) order by t.seq) from jsonb_array_elements(result) with ordinality t(value,seq)),'[]');end if;
 if p_action in ('mine','favorites') then return coalesce((select jsonb_agg(value||jsonb_build_object('author',public.tg_market_identity((value->>'owner_id')::uuid)) order by t.seq) from jsonb_array_elements(result) with ordinality t(value,seq)),'[]');end if;
 return result;
end$$;
alter function public.tg_market_refund(bigint,uuid,text) rename to tg_market_refund_v2;
revoke all on function public.tg_market_refund_v2(bigint,uuid,text) from service_role;
create function public.tg_market_refund(p_actor bigint,p_order uuid,p_stage text) returns jsonb language plpgsql security definer set search_path='' as $$declare result jsonb;begin
 result:=public.tg_market_refund_v2(p_actor,p_order,p_stage);
 if p_stage='done' and exists(select 1 from public.tg_market_orders o join public.tg_market_root r on r.user_id=o.user_id where o.id=p_order and o.is_test and o.status='refunded' and o.charge_id is not null) then update public.tg_market_settings set payments_verified=true where singleton;end if;return result;
end$$;

create or replace function public.tg_market_payment(p_actor bigint,p_order uuid,p_stars integer,p_currency text,p_charge text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.tg_market_orders; begin
 select * into o from public.tg_market_orders where id=p_order for update;
 if o.id is null or not exists(select 1 from public.tg_market_users where id=o.user_id and telegram_id=p_actor) or p_currency is distinct from 'XTR' or p_stars is distinct from o.stars then raise exception 'payment mismatch';end if;
 if p_charge is null then
  if not o.is_test and not exists(select 1 from public.tg_market_settings where purchases_enabled and payments_verified) then raise exception 'payment test required';end if;
  if exists(select 1 from public.tg_market_users where id=o.user_id and banned) or o.status<>'pending' or not exists(select 1 from public.tg_market_listings where id=o.listing_id and status='active') or exists(select 1 from public.tg_market_reports where listing_id=o.listing_id and status='open') then raise exception 'checkout unavailable';end if;
  return '{"approved":true}';
 end if;
 if length(p_charge) not between 1 and 512 then raise exception 'invalid charge';end if;
 if o.charge_id is not null then if o.charge_id=p_charge then return '{"recorded":true}';else raise exception 'charge mismatch';end if;end if;
 update public.tg_market_orders set charge_id=p_charge,status='paid' where id=o.id;
 if not o.is_test and exists(select 1 from public.tg_market_settings where purchases_enabled and payments_verified) and not exists(select 1 from public.tg_market_users where id=o.user_id and banned) and exists(select 1 from public.tg_market_listings where id=o.listing_id and status='active') and not exists(select 1 from public.tg_market_reports where listing_id=o.listing_id and status='open') then
  update public.tg_market_orders set status='active',starts_at=now(),ends_at=now()+make_interval(days=>o.duration_days) where id=o.id;
 end if;
 insert into public.tg_market_audit(actor,action,target) values(o.user_id,'telegram_payment',o.id::text);return '{"recorded":true}';
end;
$$;

revoke all on function public.tg_market_identity(uuid),public.tg_market_offers(),public.tg_market_listing(uuid),public.tg_market_action(bigint,text,jsonb,boolean,text),public.tg_market_refund(bigint,uuid,text),public.tg_market_reset_approval() from public,anon,authenticated;
grant execute on function public.tg_market_identity(uuid),public.tg_market_offers(),public.tg_market_listing(uuid),public.tg_market_action(bigint,text,jsonb,boolean,text),public.tg_market_refund(bigint,uuid,text) to service_role;

create unique index tg_market_checkout_unique on public.tg_market_orders(checkout_id) where checkout_id is not null;
create function public.tg_market_checkout(p_actor bigint,p_order uuid,p_stars integer,p_currency text,p_checkout text) returns jsonb language plpgsql security definer set search_path='' as $$declare o public.tg_market_orders;begin
 if p_checkout is null or length(p_checkout) not between 1 and 256 then raise exception 'invalid checkout';end if;
 select * into o from public.tg_market_orders where id=p_order for update;
 if o.checkout_id is not null and o.checkout_id<>p_checkout then raise exception 'checkout already reserved';end if;
 perform public.tg_market_payment(p_actor,p_order,p_stars,p_currency,null);
 update public.tg_market_orders set checkout_id=p_checkout,checkout_reserved_at=coalesce(checkout_reserved_at,now()) where id=p_order;return '{"approved":true}';
end$$;
revoke all on function public.tg_market_checkout(bigint,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.tg_market_checkout(bigint,uuid,integer,text,text) to service_role;
