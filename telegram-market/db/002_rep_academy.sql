alter table public.tg_market_orders add column duration_days integer not null default 7 check(duration_days in (1,7,14,30));
do $$declare name text; n integer;begin
 select count(*),min(conname) into n,name from pg_constraint where conrelid='public.tg_market_orders'::regclass and contype='c' and pg_get_constraintdef(oid) like '%ends_at%';
 if n<>1 then raise exception 'review campaign constraint';end if;
 execute format('alter table public.tg_market_orders drop constraint %I',name);
end$$;
alter table public.tg_market_orders add constraint tg_market_duration_valid check(status not in ('active','expired') or(starts_at is not null and ends_at is not null and ends_at=starts_at+make_interval(days=>duration_days)));
-- Incremental Telegram-only migration. Install on verified Waseet-Test first.
create table public.tg_market_root(singleton boolean primary key default true check(singleton),user_id uuid unique not null references public.tg_market_users(id) on delete cascade);
create table public.tg_market_training(user_id uuid primary key references public.tg_market_users(id) on delete cascade,version integer not null default 1 check(version=1),lessons integer[] not null default '{}',score integer check(score between 0 and 5),passed boolean not null default false,updated_at timestamptz not null default now());
create table public.tg_market_quiz_attempts(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.tg_market_users(id),version integer not null default 1,score integer not null check(score between 0 and 5),created_at timestamptz not null default now());
create table public.tg_market_rep_applications(id uuid primary key default gen_random_uuid(),user_id uuid unique not null references public.tg_market_users(id),full_name text not null check(length(trim(full_name)) between 3 and 120),governorate text not null check(length(trim(governorate)) between 2 and 100),experience text not null default '' check(length(experience)<=500),status text not null default 'pending' check(status in ('pending','approved','rejected')),reason text not null default '' check(length(reason)<=500),reviewer uuid references public.tg_market_users(id),reviewed_at timestamptz,created_at timestamptz not null default now());
create table public.tg_market_payouts(id uuid primary key default gen_random_uuid(),sale_id uuid unique not null references public.tg_market_rep_sales(id),reference text unique not null check(length(reference) between 3 and 100),paid_by uuid not null references public.tg_market_users(id),created_at timestamptz not null default now());
create table public.tg_market_channel_posts(listing_id uuid primary key references public.tg_market_listings(id),state text not null check(state in ('sending','sent','review')),channel text not null,claimed_by uuid not null references public.tg_market_users(id),message_id bigint,created_at timestamptz not null default now());
do $$declare t text;begin foreach t in array array['root','training','quiz_attempts','rep_applications','payouts','channel_posts'] loop execute format('alter table public.%I enable row level security','tg_market_'||t);execute format('revoke all on public.%I from public,anon,authenticated','tg_market_'||t);end loop;end$$;
-- Preserve reviewed v1 behavior behind an owner-only wrapper; no public bypass.
alter function public.tg_market_action(bigint,text,jsonb,boolean,text) rename to tg_market_action_v1;
revoke all on function public.tg_market_action_v1(bigint,text,jsonb,boolean,text) from service_role;
create function public.tg_market_action(p_actor bigint,p_action text,p_data jsonb default '{}',p_admin boolean default false,p_name text default 'مستخدم') returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.tg_market_users; root_id uuid; tr public.tg_market_training; app public.tg_market_rep_applications; sale public.tg_market_rep_sales; ad public.tg_market_listings; result jsonb; answer jsonb; v_score integer:=0; i integer; lesson integer; target uuid; campaign public.tg_market_orders; days integer;
begin
 if p_actor<=0 or p_actor>9007199254740991 then raise exception 'invalid actor';end if;
 if p_admin then perform pg_advisory_xact_lock(724953001);end if;
 insert into public.tg_market_users(telegram_id,display_name) values(p_actor,left(p_name,80)) on conflict(telegram_id) do nothing;
 select * into u from public.tg_market_users where telegram_id=p_actor for update;
 if p_admin then
  -- Serialize bootstrap so two simultaneous trusted identities cannot both win.
  select user_id into root_id from public.tg_market_root where singleton;
  if root_id is null then insert into public.tg_market_root(user_id) values(u.id);root_id:=u.id;
  elsif root_id<>u.id then raise exception 'owner already bound';end if;
  update public.tg_market_users set role='market' where role='admin' and id<>root_id;
 end if;
 select user_id into root_id from public.tg_market_root where singleton;
 if p_action like 'admin%' or p_action in ('rep_review','rep_requests','rep_payout','channel_claim','channel_finish') then
  if u.id is distinct from root_id or (u.banned and not p_admin) then raise exception 'owner required';end if;
 end if;
 result:=public.tg_market_action_v1(p_actor,'me','{}',p_admin,p_name);
 select * into u from public.tg_market_users where telegram_id=p_actor;
 if p_action='me' then return result||jsonb_build_object('role',case when u.role='admin' and u.id is distinct from root_id then 'market' else result->>'role' end);end if;
 if u.banned and p_action not in ('orders','support') then raise exception 'account unavailable';end if;
 if p_action in ('training','lesson','quiz','rep_apply','rep_application') then
  insert into public.tg_market_training(user_id) values(u.id) on conflict do nothing;
  select * into tr from public.tg_market_training where user_id=u.id for update;
  if p_action='lesson' then
   lesson:=(p_data->>'lesson')::integer;if lesson is null or lesson not between 1 and 5 then raise exception 'invalid lesson';end if;
   update public.tg_market_training set lessons=array(select distinct x from unnest(lessons||lesson)x order by x),updated_at=now() where user_id=u.id returning * into tr;
  elsif p_action='quiz' then
   if cardinality(tr.lessons)<>5 or jsonb_typeof(p_data->'answers') is distinct from 'array' or jsonb_array_length(p_data->'answers')<>5 or p_data->'agreed' is distinct from 'true'::jsonb then raise exception 'training incomplete';end if;
   if(select count(*) from public.tg_market_quiz_attempts where user_id=u.id and created_at>now()-interval '1 hour')>=5 then raise exception 'quiz quota';end if;
   for i in 0..4 loop
    answer:=p_data->'answers'->i;if answer not in ('0'::jsonb,'1'::jsonb,'2'::jsonb) then raise exception 'invalid answer';end if;
    if answer='1'::jsonb then v_score:=v_score+1;end if;
   end loop;
   insert into public.tg_market_quiz_attempts(user_id,score) values(u.id,v_score);
   update public.tg_market_training set score=v_score,passed=v_score>=4,updated_at=now() where user_id=u.id returning * into tr;
  elsif p_action='rep_apply' then
   if not tr.passed or tr.version<>1 or cardinality(tr.lessons)<>5 or p_data->'agreed' is distinct from 'true'::jsonb then raise exception 'exam required';end if;
   select * into app from public.tg_market_rep_applications where user_id=u.id;
   if app.status in ('pending','approved') then return to_jsonb(app);end if;
   if app.id is not null and app.created_at>now()-interval '1 hour' then raise exception 'application quota';end if;
   insert into public.tg_market_rep_applications(user_id,full_name,governorate,experience) values(u.id,trim(p_data->>'fullName'),trim(p_data->>'governorate'),coalesce(p_data->>'experience','')) on conflict(user_id) do update set full_name=excluded.full_name,governorate=excluded.governorate,experience=excluded.experience,status='pending',reason='',reviewer=null,reviewed_at=null,created_at=now() returning * into app;
   return to_jsonb(app);
  end if;
  if p_action='rep_application' then select * into app from public.tg_market_rep_applications where user_id=u.id;return jsonb_build_object('training',to_jsonb(tr),'application',case when app.id is null then null else to_jsonb(app) end);end if;
  return to_jsonb(tr);
 end if;
 if p_action='rep_requests' then return coalesce((select jsonb_agg(to_jsonb(q)) from(select a.*,t.score,t.passed from public.tg_market_rep_applications a join public.tg_market_training t on t.user_id=a.user_id order by a.created_at desc limit 30 offset least(greatest(coalesce((p_data->>'offset')::int,0),0),10000))q),'[]');end if;
 if p_action='rep_review' then
  select * into app from public.tg_market_rep_applications where id=(p_data->>'id')::uuid for update;
  if app.id is null or p_data->>'status' not in ('approved','rejected') then raise exception 'invalid review';end if;
  if app.status=p_data->>'status' then return to_jsonb(app);end if;
  if p_data->>'status'='approved' and not exists(select 1 from public.tg_market_training t join public.tg_market_users v on v.id=t.user_id where t.user_id=app.user_id and t.version=1 and t.passed and not v.banned) then raise exception 'exam required';end if;
  if app.user_id=root_id then raise exception 'owner protected';end if;
  update public.tg_market_rep_applications set status=p_data->>'status',reason=left(coalesce(p_data->>'reason',''),500),reviewer=u.id,reviewed_at=now() where id=app.id returning * into app;
  update public.tg_market_users set role=case when app.status='approved' then 'rep' else 'market' end where id=app.user_id;
  insert into public.tg_market_audit(actor,action,target) values(u.id,'rep_'||app.status,app.id::text);return to_jsonb(app);
 end if;
 if p_action='order' then
  days:=coalesce((p_data->>'days')::int,7);if days not in (1,7,14,30) then raise exception 'invalid campaign duration';end if;
  -- Listing lock serializes both plan selection and legacy order creation.
  perform 1 from public.tg_market_listings where id=(p_data->>'id')::uuid for update;
  select * into campaign from public.tg_market_orders where listing_id=(p_data->>'id')::uuid and status in ('pending','paid','active') and (status<>'active' or ends_at>now());
  if campaign.id is not null and (campaign.duration_days<>days or campaign.stars<>(p_data->>'stars')::int) then raise exception 'existing campaign differs';end if;
  result:=public.tg_market_action_v1(p_actor,p_action,p_data,false,p_name);
  if campaign.id is null then update public.tg_market_orders set duration_days=days where id=(result->>'id')::uuid;end if;
  return result||jsonb_build_object('duration_days',days);
 end if;
 if p_action='admin_user' then
  target:=(p_data->>'id')::uuid;if target=root_id or p_data->>'role'='admin' then raise exception 'owner protected';end if;
  if p_data->>'role'='rep' and not exists(select 1 from public.tg_market_rep_applications a join public.tg_market_training t on t.user_id=a.user_id where a.user_id=target and a.status='approved' and t.passed and t.version=1) then raise exception 'approved application required';end if;
 end if;
 if p_action='rep_payout' then
  select * into sale from public.tg_market_rep_sales where id=(p_data->>'id')::uuid for update;
  if sale.id is null then raise exception 'sale unavailable';end if;
  if exists(select 1 from public.tg_market_payouts where sale_id=sale.id) then return '{"paid":true}';end if;
  insert into public.tg_market_payouts(sale_id,reference,paid_by) values(sale.id,p_data->>'reference',u.id);
  insert into public.tg_market_audit(actor,action,target) values(u.id,'rep_payout',sale.id::text);return '{"paid":true}';
 end if;
 if p_action='rep' then
  if u.role not in ('rep','admin') or (u.role='admin' and u.id is distinct from root_id) then raise exception 'staff required';end if;
  result:=public.tg_market_action_v1(p_actor,p_action,p_data,false,p_name);
  return result||jsonb_build_object('paid_iqd',(select coalesce(sum(s.commission_iqd),0) from public.tg_market_rep_sales s join public.tg_market_payouts p on p.sale_id=s.id where s.rep_id=u.id),'sales',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('paid',exists(select 1 from public.tg_market_payouts p where p.sale_id=s.id))) from(select * from public.tg_market_rep_sales where rep_id=u.id order by created_at desc limit 100)s),'[]'));
 end if;
 if p_action='channel_claim' then
  select * into ad from public.tg_market_listings where id=(p_data->>'id')::uuid for update;
  if ad.id is null or ad.status<>'active' or exists(select 1 from public.tg_market_users where id=ad.owner_id and banned) or exists(select 1 from public.tg_market_reports where listing_id=ad.id and status='open') then raise exception 'listing unavailable';end if;
  if exists(select 1 from public.tg_market_channel_posts where listing_id=ad.id) then raise exception 'channel publication already claimed';end if;
  insert into public.tg_market_channel_posts(listing_id,state,channel,claimed_by) values(ad.id,'sending',p_data->>'channel',u.id);
  return to_jsonb(ad);
 end if;
 if p_action='channel_finish' then
  if p_data->>'state' not in ('sent','review') then raise exception 'invalid publication state';end if;
  update public.tg_market_channel_posts set state=p_data->>'state',message_id=(p_data->>'message')::bigint where listing_id=(p_data->>'id')::uuid and state='sending';return '{}';
 end if;
 result:=public.tg_market_action_v1(p_actor,p_action,p_data,false,p_name);
 if p_action='admin' then result:=result||jsonb_build_object('stats',(result->'stats')||jsonb_build_object('sales_iqd',(select coalesce(sum(sale_iqd),0) from public.tg_market_rep_sales),'commissions_iqd',(select coalesce(sum(commission_iqd),0) from public.tg_market_rep_sales),'payouts_iqd',(select coalesce(sum(s.commission_iqd),0) from public.tg_market_rep_sales s join public.tg_market_payouts p on p.sale_id=s.id)),'rep_sales',coalesce((select jsonb_agg(to_jsonb(q)||jsonb_build_object('paid',exists(select 1 from public.tg_market_payouts p where p.sale_id=q.id))) from(select * from public.tg_market_rep_sales order by created_at desc limit 30 offset least(greatest(coalesce((p_data->>'offset')::int,0),0),10000))q),'[]'),'channel_posts',coalesce((select jsonb_agg(to_jsonb(q)) from(select * from public.tg_market_channel_posts order by created_at desc limit 30)q),'[]'));end if;
 return result;
end$$;
revoke all on function public.tg_market_action(bigint,text,jsonb,boolean,text) from public,anon,authenticated;
grant execute on function public.tg_market_action(bigint,text,jsonb,boolean,text) to service_role;
-- Refunds are restricted to the same bound principal, even if a stale admin row exists.
alter function public.tg_market_refund(bigint,uuid,text) rename to tg_market_refund_v1;
revoke all on function public.tg_market_refund_v1(bigint,uuid,text) from service_role;
create function public.tg_market_refund(p_actor bigint,p_order uuid,p_stage text) returns jsonb language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from public.tg_market_root r join public.tg_market_users u on u.id=r.user_id where u.telegram_id=p_actor and u.role='admin' and not u.banned) then raise exception 'owner required';end if;
 return public.tg_market_refund_v1(p_actor,p_order,p_stage);
end$$;
revoke all on function public.tg_market_refund(bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.tg_market_refund(bigint,uuid,text) to service_role;

create or replace function public.tg_market_payment(p_actor bigint,p_order uuid,p_stars integer,p_currency text,p_charge text default null)
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
  update public.tg_market_orders set status='active',starts_at=now(),ends_at=now()+make_interval(days=>o.duration_days) where id=o.id;
 end if;
 insert into public.tg_market_audit(actor,action,target) values(o.user_id,'telegram_payment',o.id::text);return '{"recorded":true}';
end;
$$;
