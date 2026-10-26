-- New isolated objects only. Rehearse on Waseet-Test; never auto-migrate production.
create table public.tg_market_users(id uuid primary key default gen_random_uuid(),telegram_id bigint unique not null check(telegram_id>0),display_name text not null,role text not null default 'market' check(role in ('market','rep','admin')),banned boolean not null default false,created_at timestamptz not null default now());
create table public.tg_market_images(id uuid primary key default gen_random_uuid(),owner_id uuid not null references public.tg_market_users(id),path text unique not null,mime text not null check(mime in ('image/jpeg','image/png','image/webp')),ready boolean not null default false,created_at timestamptz not null default now());
create table public.tg_market_listings(id uuid primary key default gen_random_uuid(),owner_id uuid not null references public.tg_market_users(id),title text not null check(length(trim(title)) between 5 and 120),description text not null default '' check(length(description)<=3000),category text not null check(category in ('أثاث','سيارات','عقارات','إلكترونيات','أجهزة منزلية','ملابس','أخرى')),area text not null check(length(trim(area)) between 2 and 100),price bigint not null check(price between 0 and 1000000000000),condition text not null check(condition in ('new','used')),negotiable boolean not null default false,images uuid[] not null default '{}' check(cardinality(images)<=5),status text not null default 'active' check(status in ('active','sold','hidden','deleted')),created_at timestamptz not null default now());
create index tg_market_listing_recent on public.tg_market_listings(created_at desc,id desc) where status='active';
create table public.tg_market_threads(id uuid primary key default gen_random_uuid(),listing_id uuid not null references public.tg_market_listings(id),buyer_id uuid not null references public.tg_market_users(id),seller_id uuid not null references public.tg_market_users(id),created_at timestamptz not null default now(),unique(listing_id,buyer_id),check(buyer_id<>seller_id));
create table public.tg_market_messages(id uuid primary key default gen_random_uuid(),thread_id uuid not null references public.tg_market_threads(id),sender_id uuid not null references public.tg_market_users(id),body text not null check(length(trim(body)) between 1 and 2000),created_at timestamptz not null default now());
create table public.tg_market_favorites(user_id uuid not null references public.tg_market_users(id),listing_id uuid not null references public.tg_market_listings(id),primary key(user_id,listing_id));
create table public.tg_market_reports(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.tg_market_users(id),listing_id uuid not null references public.tg_market_listings(id),reason text not null check(length(reason) between 3 and 500),status text not null default 'open' check(status in ('open','closed')),created_at timestamptz not null default now(),unique(user_id,listing_id));
create table public.tg_market_orders(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.tg_market_users(id),listing_id uuid not null references public.tg_market_listings(id),stars integer not null check(stars between 1 and 100000),currency text not null default 'XTR' check(currency='XTR'),status text not null default 'pending' check(status in ('pending','paid','active','expired','refund_pending','refund_review','refunded')),charge_id text unique,starts_at timestamptz,ends_at timestamptz,created_at timestamptz not null default now(),check(status not in ('paid','active','expired','refund_pending','refund_review','refunded') or charge_id is not null),check(status not in ('active','expired') or (starts_at is not null and ends_at is not null and ends_at=starts_at+interval '7 days')));
create unique index tg_market_one_campaign on public.tg_market_orders(listing_id) where status in ('pending','paid','active');
create table public.tg_market_rep_sales(id uuid primary key default gen_random_uuid(),rep_id uuid not null references public.tg_market_users(id),reference text unique not null check(length(reference) between 3 and 100),sale_iqd bigint not null check(sale_iqd>=0),commission_iqd bigint not null check(commission_iqd>=0 and commission_iqd<=sale_iqd),created_at timestamptz not null default now());
create table public.tg_market_support(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.tg_market_users(id),body text not null check(length(body) between 1 and 2000),created_at timestamptz not null default now());
create table public.tg_market_audit(id bigint generated always as identity primary key,actor uuid references public.tg_market_users(id),action text not null,target text,created_at timestamptz not null default now());
-- RLS and no anon/authenticated direct access. Only narrow service-side RPCs.
DO $$ declare t text; begin
 foreach t in array array['users','images','listings','threads','messages','favorites','reports','orders','rep_sales','support','audit'] loop
  execute format('alter table public.%I enable row level security','tg_market_'||t);
  execute format('revoke all on public.%I from public,anon,authenticated','tg_market_'||t);
 end loop;
end $$;
-- Private bucket: hidden/removed ad media cannot be fetched by a public Storage URL.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('waseet-telegram-images','waseet-telegram-images',false,5242880,array['image/jpeg','image/png','image/webp']);

create function public.tg_market_public(p_query text default '',p_category text default '',p_min bigint default 0,p_max bigint default 1000000000000,p_offset integer default 0)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) from (
 select l.*,exists(select 1 from public.tg_market_orders o where o.listing_id=l.id and o.status='active' and o.starts_at<=now() and o.ends_at>now()) as sponsored
 from public.tg_market_listings l join public.tg_market_users u on u.id=l.owner_id and not u.banned
 where l.status='active' and (p_category='' or l.category=p_category) and l.price between greatest(0,p_min) and least(p_max,1000000000000)
 and (p_query='' or l.title ilike '%'||left(p_query,60)||'%' or l.area ilike '%'||left(p_query,60)||'%')
 and not exists(select 1 from public.tg_market_reports r where r.listing_id=l.id and r.status='open')
 order by sponsored desc,l.created_at desc,l.id desc limit 20 offset least(greatest(p_offset,0),10000)
 ) q;
$$;
create function public.tg_market_media(p_image uuid,p_actor bigint default 0)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('path',i.path,'mime',i.mime) from public.tg_market_images i
 where i.id=p_image and i.ready and (exists(select 1 from public.tg_market_users u where u.id=i.owner_id and u.telegram_id=p_actor and not u.banned)
 or exists(select 1 from public.tg_market_listings l join public.tg_market_users u on u.id=l.owner_id and not u.banned where i.id=any(l.images) and l.status='active' and not exists(select 1 from public.tg_market_reports r where r.listing_id=l.id and r.status='open')));
$$;

create function public.tg_market_action(p_actor bigint,p_action text,p_data jsonb default '{}'::jsonb,p_admin boolean default false,p_name text default 'مستخدم')
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.tg_market_users; v_listing public.tg_market_listings; o public.tg_market_orders; tid uuid; iid uuid; target uuid; n integer; result jsonb; img uuid; own boolean; act text;
begin
 if p_actor<=0 or p_actor>9007199254740991 then raise exception 'invalid actor'; end if;
 insert into public.tg_market_users(telegram_id,display_name) values(p_actor,left(p_name,80)) on conflict(telegram_id) do nothing;
 select * into u from public.tg_market_users where telegram_id=p_actor for update;
 if p_admin and u.role<>'admin' then update public.tg_market_users set role='admin' where id=u.id;u.role:='admin';end if;
 if u.banned and p_action not in ('me','orders','support') then raise exception 'account unavailable';end if;
 if p_action='me' then return jsonb_build_object('id',u.id,'name',u.display_name,'role',case when u.banned then 'market' else u.role end,'banned',u.banned);end if;
 if p_action='mine' then return coalesce((select jsonb_agg(to_jsonb(q)) from(select * from public.tg_market_listings where owner_id=u.id and status<>'deleted' order by created_at desc,id desc limit 50 offset least(greatest(coalesce((p_data->>'offset')::int,0),0),10000))q),'[]');end if;
 if p_action='image_intent' then
  if (select count(*) from public.tg_market_images where owner_id=u.id)>=100 or (select count(*) from public.tg_market_images where owner_id=u.id and created_at>now()-interval '1 hour')>=30 then raise exception 'upload quota';end if;
  iid:=gen_random_uuid();insert into public.tg_market_images(id,owner_id,path,mime) values(iid,u.id,u.id::text||'/'||iid::text,p_data->>'mime');return jsonb_build_object('id',iid,'path',u.id::text||'/'||iid::text);
 end if;
 if p_action='image_ready' then update public.tg_market_images set ready=true where id=(p_data->>'id')::uuid and owner_id=u.id;return '{}'::jsonb;end if;
 if p_action='save' then
  if (select count(*) from public.tg_market_listings where owner_id=u.id and created_at>now()-interval '1 hour')>=10 and p_data->>'id' is null then raise exception 'listing quota';end if;
  if jsonb_array_length(coalesce(p_data->'images','[]'))>5 then raise exception 'photo limit';end if;
  for img in select jsonb_array_elements_text(coalesce(p_data->'images','[]'))::uuid loop
   if not exists(select 1 from public.tg_market_images where id=img and owner_id=u.id and ready) then raise exception 'invalid photo owner';end if;
  end loop;
  if p_data->>'id' is null then
   insert into public.tg_market_listings(owner_id,title,description,category,area,price,condition,negotiable,images) values(u.id,trim(p_data->>'title'),coalesce(p_data->>'description',''),p_data->>'category',trim(p_data->>'area'),(p_data->>'price')::bigint,p_data->>'condition',coalesce((p_data->>'negotiable')::boolean,false),array(select jsonb_array_elements_text(coalesce(p_data->'images','[]'))::uuid)) returning id into target;
  else
   select * into v_listing from public.tg_market_listings where id=(p_data->>'id')::uuid for update;
   if v_listing.owner_id is distinct from u.id or v_listing.status in ('hidden','deleted') then raise exception 'listing unavailable';end if;
   update public.tg_market_listings set title=trim(p_data->>'title'),description=coalesce(p_data->>'description',''),category=p_data->>'category',area=trim(p_data->>'area'),price=(p_data->>'price')::bigint,condition=p_data->>'condition',negotiable=coalesce((p_data->>'negotiable')::boolean,false),images=array(select jsonb_array_elements_text(coalesce(p_data->'images','[]'))::uuid) where id=v_listing.id;target:=v_listing.id;
  end if;return jsonb_build_object('id',target);
 end if;
 if p_action='status' then
  act:=p_data->>'status';if act not in ('sold','active','deleted') then raise exception 'invalid status';end if;
  update public.tg_market_listings set status=act where id=(p_data->>'id')::uuid and owner_id=u.id and status not in ('hidden','deleted');if not found then raise exception 'listing unavailable';end if;return '{}';
 end if;
 if p_action='favorite' then
  if not exists(select 1 from public.tg_market_listings where id=(p_data->>'id')::uuid and status='active') then raise exception 'listing unavailable';end if;
  delete from public.tg_market_favorites where user_id=u.id and listing_id=(p_data->>'id')::uuid;
  if not found then insert into public.tg_market_favorites values(u.id,(p_data->>'id')::uuid);end if;return '{}';
 end if;
 if p_action='favorites' then return coalesce((select jsonb_agg(to_jsonb(ad)) from public.tg_market_listings ad join public.tg_market_favorites f on f.listing_id=ad.id where f.user_id=u.id and ad.status='active'),'[]');end if;
 if p_action='report' then
  if (select count(*) from public.tg_market_reports where user_id=u.id and created_at>now()-interval '1 hour')>=10 then raise exception 'report quota';end if;
  insert into public.tg_market_reports(user_id,listing_id,reason) select u.id,id,p_data->>'reason' from public.tg_market_listings where id=(p_data->>'id')::uuid and status='active' on conflict(user_id,listing_id) do nothing;return '{}';
 end if;
 if p_action='thread' then
  select * into v_listing from public.tg_market_listings where id=(p_data->>'id')::uuid and status='active';if v_listing.id is null or v_listing.owner_id=u.id then raise exception 'listing unavailable';end if;
  insert into public.tg_market_threads(listing_id,buyer_id,seller_id) values(v_listing.id,u.id,v_listing.owner_id) on conflict(listing_id,buyer_id) do nothing;
  select id into tid from public.tg_market_threads where listing_id=v_listing.id and buyer_id=u.id;return jsonb_build_object('id',tid,'title',v_listing.title);
 end if;
 if p_action='inbox' then return coalesce((select jsonb_agg(to_jsonb(q)) from(select t.id,ad.title from public.tg_market_threads t join public.tg_market_listings ad on ad.id=t.listing_id where u.id in(t.buyer_id,t.seller_id) order by t.created_at desc limit 50 offset least(greatest(coalesce((p_data->>'offset')::int,0),0),10000))q),'[]');end if;
 if p_action in ('messages','send') then
  tid:=(p_data->>'id')::uuid;if not exists(select 1 from public.tg_market_threads where id=tid and u.id in(buyer_id,seller_id)) then raise exception 'conversation unavailable';end if;
  if p_action='send' then
   if not exists(select 1 from public.tg_market_threads t join public.tg_market_listings ad on ad.id=t.listing_id where t.id=tid and ad.status='active') then raise exception 'listing unavailable';end if;
   if (select count(*) from public.tg_market_messages where sender_id=u.id and created_at>now()-interval '1 minute')>=40 then raise exception 'message quota';end if;
   insert into public.tg_market_messages(thread_id,sender_id,body) values(tid,u.id,trim(p_data->>'body'));
  end if;
  return coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at,q.id) from(select id,sender_id,body,created_at from public.tg_market_messages where thread_id=tid order by created_at desc,id desc limit 100 offset least(greatest(coalesce((p_data->>'offset')::int,0),0),10000))q),'[]');
 end if;
 if p_action='order' then
  select * into v_listing from public.tg_market_listings where id=(p_data->>'id')::uuid for update;
  if v_listing.owner_id is distinct from u.id or v_listing.status<>'active' or exists(select 1 from public.tg_market_reports where listing_id=v_listing.id and status='open') then raise exception 'listing unavailable';end if;
  update public.tg_market_orders set status='expired' where listing_id=v_listing.id and status='active' and ends_at<=now();
  select * into o from public.tg_market_orders where listing_id=v_listing.id and status in ('pending','paid','active');
  if o.id is null then insert into public.tg_market_orders(user_id,listing_id,stars) values(u.id,v_listing.id,(p_data->>'stars')::int) returning * into o;end if;
  return to_jsonb(o)-'charge_id';
 end if;
 if p_action='orders' then return coalesce((select jsonb_agg(to_jsonb(q)-'charge_id') from(select * from public.tg_market_orders where user_id=u.id order by created_at desc limit 50)q),'[]');end if;
 if p_action='support' then
  if(select count(*) from public.tg_market_support where user_id=u.id and created_at>now()-interval '1 hour')>=5 then raise exception 'support quota';end if;
  insert into public.tg_market_support(user_id,body) values(u.id,left(p_data->>'body',2000));return '{}';
 end if;
 if p_action='rep' then
  if u.role not in ('rep','admin') then raise exception 'staff required';end if;
  return jsonb_build_object('sales',coalesce((select jsonb_agg(to_jsonb(q)) from(select * from public.tg_market_rep_sales where rep_id=u.id order by created_at desc limit 100)q),'[]'),'commission_iqd',(select coalesce(sum(commission_iqd),0) from public.tg_market_rep_sales where rep_id=u.id));
 end if;
 if u.role<>'admin' then raise exception 'admin required';end if;
 if p_action='admin' then
  n:=least(greatest(coalesce((p_data->>'offset')::int,0),0),10000);
  return jsonb_build_object('stats',jsonb_build_object('users',(select count(*) from public.tg_market_users),'listings',(select count(*) from public.tg_market_listings where status='active'),'stars_received',(select coalesce(sum(stars),0) from public.tg_market_orders where charge_id is not null and status<>'refunded')),
   'users',coalesce((select jsonb_agg(to_jsonb(q)-'telegram_id') from(select * from public.tg_market_users order by created_at desc,id desc limit 30 offset n)q),'[]'),
   'listings',coalesce((select jsonb_agg(to_jsonb(q)) from(select * from public.tg_market_listings order by created_at desc,id desc limit 30 offset n)q),'[]'),
   'reports',coalesce((select jsonb_agg(to_jsonb(q)) from(select * from public.tg_market_reports where status='open' limit 30 offset n)q),'[]'),
   'orders',coalesce((select jsonb_agg(to_jsonb(q)-'charge_id') from(select * from public.tg_market_orders order by created_at desc limit 30 offset n)q),'[]'),
   'support',coalesce((select jsonb_agg(to_jsonb(q)) from(select * from public.tg_market_support order by created_at desc limit 30 offset n)q),'[]'));
 end if;
 if p_action='admin_user' then
  if (p_data->>'role') not in ('market','rep','admin') then raise exception 'invalid role';end if;
  update public.tg_market_users set role=p_data->>'role',banned=coalesce((p_data->>'banned')::boolean,false) where id=(p_data->>'id')::uuid and id<>u.id;
 elsif p_action='admin_listing' then
  if p_data->>'status' not in ('active','hidden','deleted') then raise exception 'invalid status';end if;
  update public.tg_market_listings set status=p_data->>'status' where id=(p_data->>'id')::uuid;
 elsif p_action='admin_report' then update public.tg_market_reports set status='closed' where id=(p_data->>'id')::uuid;
 elsif p_action='admin_sale' then
  if not exists(select 1 from public.tg_market_users where id=(p_data->>'rep')::uuid and role='rep' and not banned) then raise exception 'rep required';end if;
  insert into public.tg_market_rep_sales(rep_id,reference,sale_iqd,commission_iqd) values((p_data->>'rep')::uuid,p_data->>'reference',(p_data->>'sale')::bigint,(p_data->>'commission')::bigint);
 else raise exception 'unknown action';end if;
 insert into public.tg_market_audit(actor,action,target) values(u.id,p_action,left(p_data::text,1000));return '{}';
end;
$$;

-- Called only for secret-verified Telegram Bot API updates, never browser requests.
create function public.tg_market_payment(p_actor bigint,p_order uuid,p_stars integer,p_currency text,p_charge text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.tg_market_orders; begin
 select * into o from public.tg_market_orders where id=p_order for update;
 if o.id is null or not exists(select 1 from public.tg_market_users where id=o.user_id and telegram_id=p_actor) or p_currency is distinct from 'XTR' or p_stars is distinct from o.stars then raise exception 'payment mismatch';end if;
 if p_charge is null then
  if exists(select 1 from public.tg_market_users where id=o.user_id and banned) or o.status<>'pending' or not exists(select 1 from public.tg_market_listings where id=o.listing_id and status='active') or exists(select 1 from public.tg_market_reports where listing_id=o.listing_id and status='open') then raise exception 'checkout unavailable';end if;
  return '{"approved":true}';
 end if;
 if length(p_charge) not between 1 and 512 then raise exception 'invalid charge';end if;
 if o.charge_id is not null then if o.charge_id=p_charge then return '{"recorded":true}';else raise exception 'charge mismatch';end if;end if;
 update public.tg_market_orders set charge_id=p_charge,status='paid' where id=o.id;
 if not exists(select 1 from public.tg_market_users where id=o.user_id and banned) and exists(select 1 from public.tg_market_listings where id=o.listing_id and status='active') and not exists(select 1 from public.tg_market_reports where listing_id=o.listing_id and status='open') then
  update public.tg_market_orders set status='active',starts_at=now(),ends_at=now()+interval '7 days' where id=o.id;
 end if;
 insert into public.tg_market_audit(actor,action,target) values(o.user_id,'telegram_payment',o.id::text);return '{"recorded":true}';
end;
$$;
-- Private service functions only. Browser anon/authenticated cannot forge actor/admin.
revoke all on function public.tg_market_public(text,text,bigint,bigint,integer),public.tg_market_media(uuid,bigint),public.tg_market_action(bigint,text,jsonb,boolean,text),public.tg_market_payment(bigint,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.tg_market_public(text,text,bigint,bigint,integer),public.tg_market_media(uuid,bigint),public.tg_market_action(bigint,text,jsonb,boolean,text),public.tg_market_payment(bigint,uuid,integer,text,text) to service_role;

create function public.tg_market_refund(p_actor bigint,p_order uuid,p_stage text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.tg_market_orders; begin
 if not exists(select 1 from public.tg_market_users where telegram_id=p_actor and role='admin' and not banned) then raise exception 'admin required';end if;
 select * into o from public.tg_market_orders where id=p_order for update;
 if p_stage='claim' then
  if o.status not in ('paid','active','expired') then raise exception 'refund review required';end if;
  update public.tg_market_orders set status='refund_pending' where id=o.id;
  return jsonb_build_object('charge',o.charge_id,'telegram_id',(select telegram_id from public.tg_market_users where id=o.user_id));
 elsif p_stage in ('done','uncertain') then
  update public.tg_market_orders set status=case when p_stage='done' then 'refunded' else 'refund_review' end where id=p_order and status='refund_pending';
 else raise exception 'invalid refund stage';end if;
 insert into public.tg_market_audit(actor,action,target) select id,'refund_'||p_stage,p_order::text from public.tg_market_users where telegram_id=p_actor;
 return '{}';end;
$$;
revoke all on function public.tg_market_refund(bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.tg_market_refund(bigint,uuid,text) to service_role;

revoke all on sequence public.tg_market_audit_id_seq from public,anon,authenticated;
