-- Telegram-only additive migration. Requires fresh verified backup and rollback rehearsal.
-- Never apply via Worker startup. No user/ad/subscription seed or external offers.
create table public.tg_market_wanted (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.tg_market_users(id),
 title text not null check(length(trim(title)) between 5 and 120), category text not null check(category in ('أثاث','سيارات','عقارات','إلكترونيات','أجهزة منزلية','ملابس','أخرى')),
 governorate text not null check(length(trim(governorate)) between 2 and 40), area text not null check(length(trim(area)) between 2 and 100),
 budget bigint not null check(budget between 0 and 1000000000000), description text not null check(length(trim(description)) between 5 and 3000),
 images uuid[] not null default '{}' check(cardinality(images)<=5),
 status text not null default 'pending' check(status in ('pending','approved','rejected','closed','deleted')),
 expires_at timestamptz not null default now()+interval '30 days', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create unique index tg_market_wanted_duplicate on public.tg_market_wanted(owner_id,lower(regexp_replace(title,'\s+',' ','g')),category,governorate) where status in ('pending','approved');
create index tg_market_wanted_feed on public.tg_market_wanted(created_at desc,id) where status='approved';
create table public.tg_market_wanted_offers(id uuid primary key default gen_random_uuid(),request_id uuid not null references public.tg_market_wanted(id),seller_id uuid not null references public.tg_market_users(id),listing_id uuid not null references public.tg_market_listings(id),created_at timestamptz not null default now(),unique(request_id,seller_id,listing_id));
create table public.tg_market_radars(id uuid primary key default gen_random_uuid(),owner_id uuid not null references public.tg_market_users(id),request_id uuid references public.tg_market_wanted(id),title text not null check(length(trim(title)) between 3 and 120),keywords text not null check(length(trim(keywords)) between 2 and 200),category text not null check(category in ('أثاث','سيارات','عقارات','إلكترونيات','أجهزة منزلية','ملابس','أخرى')),governorate text not null check(length(trim(governorate)) between 2 and 40),area text not null default '' check(length(area)<=100),budget bigint not null check(budget between 0 and 1000000000000),enabled boolean not null default true,notifications boolean not null default false,consent_at timestamptz,scan_after uuid,last_scan_at timestamptz,created_at timestamptz not null default now(),check(not notifications or consent_at is not null));
create index tg_market_radar_scan on public.tg_market_radars(last_scan_at nulls first,id) where enabled;
create table public.tg_market_radar_matches(radar_id uuid not null references public.tg_market_radars(id) on delete cascade,listing_id uuid not null references public.tg_market_listings(id),event_id bigint unique references public.tg_market_notify_events(id),created_at timestamptz not null default now(),primary key(radar_id,listing_id));
create table public.tg_market_wanted_reports(id uuid primary key default gen_random_uuid(),request_id uuid not null references public.tg_market_wanted(id),user_id uuid not null references public.tg_market_users(id),reason text not null check(length(trim(reason)) between 3 and 500),status text not null default 'open' check(status in ('open','closed')),created_at timestamptz not null default now(),unique(request_id,user_id));
do $$declare t text;begin foreach t in array array['wanted','wanted_offers','radars','radar_matches','wanted_reports'] loop execute format('alter table public.%I enable row level security','tg_market_'||t);execute format('revoke all on public.%I from public,anon,authenticated,service_role','tg_market_'||t);end loop;end$$;
-- Conservative literal token matching: every word is required, no wildcard/semantic guesses.
create function public.tg_market_radar_normalize(p_text text) returns text language sql immutable set search_path='' as $$select trim(regexp_replace(translate(regexp_replace(lower(coalesce(p_text,'')),'[ًٌٍَُِّْـ]','','g'),'أإآى','اااي'),'[^[:alnum:]ء-ي]+',' ','g'));$$;
create function public.tg_market_radar_matches_ad(r public.tg_market_radars,l public.tg_market_listings) returns boolean language sql stable security definer set search_path='' as $$
 select r.enabled and (r.request_id is null or exists(select 1 from public.tg_market_wanted req where req.id=r.request_id and req.owner_id=r.owner_id and req.status='approved' and req.expires_at>now() and not exists(select 1 from public.tg_market_wanted_reports rpt where rpt.request_id=req.id and rpt.status='open'))) and l.status='active' and l.approved_at is not null and l.owner_id<>r.owner_id and l.price<=r.budget and l.category=r.category
 and public.tg_market_radar_normalize(l.governorate)=public.tg_market_radar_normalize(r.governorate)
 and (r.area='' or public.tg_market_radar_normalize(l.area)=public.tg_market_radar_normalize(r.area))
 and exists(select 1 from public.tg_market_users where id=l.owner_id and not banned)
 and not exists(select 1 from public.tg_market_reports where listing_id=l.id and status='open')
 and not exists(select 1 from regexp_split_to_table(public.tg_market_radar_normalize(r.keywords),' +') k where length(k)<2 or not k=any(regexp_split_to_array(public.tg_market_radar_normalize(l.title||' '||l.description),' +')));
$$;
create function public.tg_market_wanted_public(p_data jsonb default '{}') returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(q)),'[]') from(select w.id,w.title,w.category,w.governorate,w.area,w.budget,w.description,w.images,w.expires_at,w.status from public.tg_market_wanted w join public.tg_market_users u on u.id=w.owner_id and not u.banned where w.status='approved' and w.expires_at>now() and not exists(select 1 from public.tg_market_wanted_reports where request_id=w.id and status='open') and (coalesce(p_data->>'q','')='' or position(lower(left(p_data->>'q',60)) in lower(w.title||' '||w.description))>0) and (coalesce(p_data->>'category','')='' or w.category=p_data->>'category') and (coalesce(p_data->>'governorate','')='' or w.governorate=p_data->>'governorate') and w.budget<=coalesce((p_data->>'budget')::bigint,1000000000000) order by w.created_at desc,w.id limit 20 offset least(10000,greatest(0,coalesce((p_data->>'offset')::int,0))))q;
$$;
create function public.tg_market_wanted_action(p_actor bigint,p_operation text,p_data jsonb default '{}',p_admin boolean default false,p_name text default 'مستخدم') returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.tg_market_users;w public.tg_market_wanted;r public.tg_market_radars;l public.tg_market_listings;o public.tg_market_wanted_offers;img uuid;key uuid;result jsonb;root boolean;
begin
 perform public.tg_market_action(p_actor,'me','{}',p_admin,p_name);
 select * into u from public.tg_market_users where telegram_id=p_actor for update;
 if u.banned then raise exception 'account unavailable';end if;
 root:=p_admin and u.role='admin' and exists(select 1 from public.tg_market_root where user_id=u.id);
 if p_operation='mine' then return coalesce((select jsonb_agg(to_jsonb(q)) from(select *,case when expires_at<=now() then 'expired' else status end as display_status from public.tg_market_wanted where owner_id=u.id and status<>'deleted' order by created_at desc limit 50)q),'[]');end if;
 if p_operation='save' then
  key:=coalesce((p_data->>'id')::uuid,gen_random_uuid());select * into w from public.tg_market_wanted where id=key for update;
  if w.id is not null and (w.owner_id<>u.id or w.status='deleted') then raise exception 'forbidden';end if;
  if w.id is null and ((select count(*) from public.tg_market_wanted where owner_id=u.id and created_at>now()-interval '1 day')>=5 or (select count(*) from public.tg_market_wanted where owner_id=u.id and status in ('pending','approved') and expires_at>now())>=10) then raise exception 'request quota';end if;
  for img in select jsonb_array_elements_text(coalesce(p_data->'images','[]'))::uuid loop if not exists(select 1 from public.tg_market_images where id=img and owner_id=u.id and ready) then raise exception 'invalid image';end if;end loop;
  insert into public.tg_market_wanted(id,owner_id,title,category,governorate,area,budget,description,images) values(key,u.id,trim(p_data->>'title'),p_data->>'category',trim(p_data->>'governorate'),trim(p_data->>'area'),(p_data->>'budget')::bigint,trim(p_data->>'description'),array(select jsonb_array_elements_text(coalesce(p_data->'images','[]'))::uuid)) on conflict(id) do update set title=excluded.title,category=excluded.category,governorate=excluded.governorate,area=excluded.area,budget=excluded.budget,description=excluded.description,images=excluded.images,status='pending',updated_at=now() returning * into w;
  return to_jsonb(w);
 end if;
 if p_operation in ('close','delete','renew','review') then
  select * into w from public.tg_market_wanted where id=(p_data->>'id')::uuid for update;
  if w.id is null or w.status='deleted' or (p_operation='review' and not root) or (p_operation<>'review' and w.owner_id<>u.id) then raise exception 'forbidden';end if;
  if p_operation='review' and (p_data->>'status' not in ('approved','rejected') or w.status not in ('pending','approved')) then raise exception 'invalid transition';end if;
  if p_operation='renew' and w.expires_at>now() then raise exception 'not expired';end if;
  update public.tg_market_wanted set status=case p_operation when 'close' then 'closed' when 'delete' then 'deleted' when 'renew' then 'pending' else p_data->>'status' end,expires_at=case when p_operation='renew' then now()+interval '30 days' else expires_at end,updated_at=now() where id=w.id returning * into w;
  insert into public.tg_market_audit(actor,action,target) values(u.id,'wanted_'||p_operation,w.id::text);return to_jsonb(w);
 end if;
 if p_operation='offer' then
  select * into w from public.tg_market_wanted where id=(p_data->>'request')::uuid for update;
  select * into l from public.tg_market_listings where id=(p_data->>'listing')::uuid;
  if w.id is null or w.owner_id=u.id or w.status<>'approved' or w.expires_at<=now() or not exists(select 1 from public.tg_market_users where id=w.owner_id and not banned) or exists(select 1 from public.tg_market_wanted_reports where request_id=w.id and status='open') or l.id is null or l.owner_id<>u.id or l.status<>'active' or l.approved_at is null or exists(select 1 from public.tg_market_reports where listing_id=l.id and status='open') then raise exception 'approved offer required';end if;
  if (select count(*) from public.tg_market_wanted_offers where seller_id=u.id and created_at>now()-interval '1 day')>=30 then raise exception 'offer quota';end if;
  insert into public.tg_market_wanted_offers(request_id,seller_id,listing_id) values(w.id,u.id,l.id) on conflict do nothing;
  return jsonb_build_object('saved',true);
 end if;
 if p_operation in ('offers','admin_offers') then
  select * into w from public.tg_market_wanted where id=(p_data->>'id')::uuid;
  if (p_operation='offers' and w.owner_id is distinct from u.id) or (p_operation='admin_offers' and not root) then raise exception 'forbidden';end if;
  return coalesce((select jsonb_agg(to_jsonb(q)) from(select ofr.id,ofr.listing_id,ad.title,ad.price,ad.area,ad.governorate,public.tg_market_identity(ofr.seller_id) as author from public.tg_market_wanted_offers ofr join public.tg_market_listings ad on ad.id=ofr.listing_id join public.tg_market_users s on s.id=ofr.seller_id and not s.banned where ofr.request_id=w.id and ad.status='active' and ad.approved_at is not null and not exists(select 1 from public.tg_market_reports where listing_id=ad.id and status='open') order by ofr.created_at desc limit 100)q),'[]');
 end if;
 if p_operation='contact' then
  select * into o from public.tg_market_wanted_offers where id=(p_data->>'id')::uuid;
  select * into w from public.tg_market_wanted where id=o.request_id;
  if w.owner_id is distinct from u.id or w.status<>'approved' or w.expires_at<=now() or not exists(select 1 from public.tg_market_listings ad join public.tg_market_users seller on seller.id=ad.owner_id and not seller.banned where ad.id=o.listing_id and ad.status='active' and ad.approved_at is not null and not exists(select 1 from public.tg_market_reports where listing_id=ad.id and status='open')) then raise exception 'forbidden';end if;
  return public.tg_market_action(p_actor,'thread',jsonb_build_object('id',o.listing_id),p_admin,p_name);
 end if;
 if p_operation='report' then
  if not exists(select 1 from public.tg_market_wanted where id=(p_data->>'id')::uuid and status='approved' and expires_at>now()) then raise exception 'not found';end if;
  insert into public.tg_market_wanted_reports(request_id,user_id,reason) values((p_data->>'id')::uuid,u.id,p_data->>'reason') on conflict do nothing;return jsonb_build_object('saved',true);
 end if;
 if p_operation='radars' then return coalesce((select jsonb_agg(to_jsonb(q)) from(select * from public.tg_market_radars where owner_id=u.id order by created_at desc limit 20)q),'[]');end if;
 if p_operation='radar_save' then
  key:=coalesce((p_data->>'id')::uuid,gen_random_uuid());select * into r from public.tg_market_radars where id=key for update;
  if r.id is not null and r.owner_id<>u.id then raise exception 'forbidden';end if;
  if r.id is null and (select count(*) from public.tg_market_radars where owner_id=u.id)>=10 then raise exception 'radar quota';end if;
  if p_data->>'request_id' is not null and not exists(select 1 from public.tg_market_wanted where id=(p_data->>'request_id')::uuid and owner_id=u.id and status<>'deleted') then raise exception 'forbidden';end if;
  if coalesce((p_data->>'notifications')::boolean,false) and (p_data->'confirmed'<>'true'::jsonb or p_data->'confirmed' is null) then raise exception 'consent required';end if;
  insert into public.tg_market_radars(id,owner_id,request_id,title,keywords,category,governorate,area,budget,enabled,notifications,consent_at) values(key,u.id,(p_data->>'request_id')::uuid,p_data->>'title',p_data->>'keywords',p_data->>'category',p_data->>'governorate',coalesce(p_data->>'area',''),(p_data->>'budget')::bigint,coalesce((p_data->>'enabled')::boolean,true),coalesce((p_data->>'notifications')::boolean,false),case when (p_data->>'notifications')::boolean then now() end) on conflict(id) do update set request_id=excluded.request_id,title=excluded.title,keywords=excluded.keywords,category=excluded.category,governorate=excluded.governorate,area=excluded.area,budget=excluded.budget,enabled=excluded.enabled,notifications=excluded.notifications,consent_at=excluded.consent_at,scan_after=null,last_scan_at=null returning * into r;
  return to_jsonb(r);
 end if;
 if p_operation='radar_delete' then delete from public.tg_market_radars where id=(p_data->>'id')::uuid and owner_id=u.id;return jsonb_build_object('deleted',found);end if;
 if p_operation='matches' then
  select * into r from public.tg_market_radars where id=(p_data->>'id')::uuid and owner_id=u.id;if r.id is null then raise exception 'forbidden';end if;
  return coalesce((select jsonb_agg(to_jsonb(q)) from(select ad.id,ad.title,ad.price,ad.area,ad.governorate,ad.images from public.tg_market_radar_matches m join public.tg_market_listings ad on ad.id=m.listing_id where m.radar_id=r.id and public.tg_market_radar_matches_ad(r,ad) order by m.created_at desc limit 100)q),'[]');
 end if;
 if p_operation='admin' and root then return jsonb_build_object('requests',coalesce((select jsonb_agg(to_jsonb(q)) from(select * from public.tg_market_wanted where status=p_data->>'status' order by created_at desc limit 50 offset least(10000,greatest(0,coalesce((p_data->>'offset')::int,0))))q),'[]'),'reports',coalesce((select jsonb_agg(to_jsonb(q)) from(select rpt.id,rpt.request_id,rpt.reason,req.title,req.status as request_status from public.tg_market_wanted_reports rpt join public.tg_market_wanted req on req.id=rpt.request_id where rpt.status='open' order by rpt.created_at limit 50)q),'[]'),'offers',(select count(*) from public.tg_market_wanted_offers),'radars',(select count(*) from public.tg_market_radars),'active_radars',(select count(*) from public.tg_market_radars where enabled),'matches',(select count(*) from public.tg_market_radar_matches),'last_scan',(select max(last_scan_at) from public.tg_market_radars));end if;
 if p_operation='report_close' and root then update public.tg_market_wanted_reports set status='closed' where id=(p_data->>'id')::uuid;return '{}';end if;
 raise exception 'unknown operation';
end$$;
-- Bounded round-robin scanner. Cursor completes old inventory then cycles for edits/new ads.
create function public.tg_market_radar_scan(p_radar uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.tg_market_radars;l public.tg_market_listings;last_id uuid;n int;total int:=0;eid bigint;
begin
 for r in select rr.* from public.tg_market_radars rr join public.tg_market_users u on u.id=rr.owner_id and not u.banned where rr.enabled and (p_radar is null or rr.id=p_radar) and (rr.request_id is null or exists(select 1 from public.tg_market_wanted where id=rr.request_id and status='approved' and expires_at>now())) order by rr.last_scan_at nulls first,rr.id for update of rr skip locked limit 5 loop
  n:=0;last_id:=null;
  for l in select * from public.tg_market_listings where (r.scan_after is null or id>r.scan_after) order by id limit 50 loop
   n:=n+1;last_id:=l.id;
   if public.tg_market_radar_matches_ad(r,l) then
    insert into public.tg_market_radar_matches(radar_id,listing_id) values(r.id,l.id) on conflict do nothing;
    if r.notifications and exists(select 1 from public.tg_market_notify_preferences where user_id=r.owner_id and enabled and not blocked and consent_at is not null and (paused_until is null or paused_until<=now())) then
     eid:=null;
     insert into public.tg_market_notify_events(event_key,kind,listing_id,target_user,revision) values('radar:'||r.id||':'||l.id,'listing',l.id,r.owner_id,l.approved_at) on conflict(event_key) do nothing returning id into eid;
     if eid is not null then update public.tg_market_radar_matches set event_id=eid where radar_id=r.id and listing_id=l.id;end if;
    end if;
    total:=total+1;
   end if;
  end loop;
  update public.tg_market_radars set scan_after=case when n=50 then last_id else null end,last_scan_at=now() where id=r.id;
 end loop;
 return jsonb_build_object('matched',total);
end$$;
-- Preserve the proven queue, rate limiting, leases and uncertain-delivery review.
alter function public.tg_market_notify_eligible(bigint,uuid) rename to tg_market_notify_eligible_v4;
create function public.tg_market_notify_eligible(p_event bigint,p_user uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
declare e public.tg_market_notify_events;
begin
 select * into e from public.tg_market_notify_events where id=p_event;
 if e.event_key like 'radar:%' then
  return e.target_user=p_user and e.expires_at>now() and exists(select 1 from public.tg_market_notify_control where enabled) and exists(select 1 from public.tg_market_users where id=p_user and not banned) and exists(select 1 from public.tg_market_notify_preferences where user_id=p_user and enabled and not blocked and consent_at is not null and consent_at<=e.created_at and (paused_until is null or paused_until<=now())) and exists(select 1 from public.tg_market_radar_matches m join public.tg_market_radars r on r.id=m.radar_id join public.tg_market_listings l on l.id=m.listing_id where m.event_id=e.id and r.owner_id=p_user and r.notifications and r.consent_at<=e.created_at and public.tg_market_radar_matches_ad(r,l) and (r.request_id is null or exists(select 1 from public.tg_market_wanted where id=r.request_id and status='approved' and expires_at>now())));
 end if;
 return public.tg_market_notify_eligible_v4(p_event,p_user);
end$$;
-- Readiness marker is installed only by the gated migration, never by app code.
revoke all on function public.tg_market_radar_normalize(text),public.tg_market_radar_matches_ad(public.tg_market_radars,public.tg_market_listings),public.tg_market_wanted_public(jsonb),public.tg_market_wanted_action(bigint,text,jsonb,boolean,text),public.tg_market_radar_scan(uuid),public.tg_market_notify_eligible(bigint,uuid),public.tg_market_notify_eligible_v4(bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.tg_market_wanted_public(jsonb),public.tg_market_wanted_action(bigint,text,jsonb,boolean,text),public.tg_market_radar_scan(uuid) to service_role;
-- Extend private image visibility to approved requests without making Storage public.
alter function public.tg_market_media(uuid,bigint) rename to tg_market_media_v4;
revoke all on function public.tg_market_media_v4(uuid,bigint) from service_role;
create function public.tg_market_media(p_image uuid,p_actor bigint default 0) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(public.tg_market_media_v4(p_image,p_actor),(select jsonb_build_object('path',i.path,'mime',i.mime) from public.tg_market_images i join public.tg_market_wanted w on i.id=any(w.images) and i.owner_id=w.owner_id join public.tg_market_users u on u.id=w.owner_id and not u.banned where i.id=p_image and i.ready and w.status='approved' and w.expires_at>now() and not exists(select 1 from public.tg_market_wanted_reports where request_id=w.id and status='open') limit 1));
$$;
revoke all on function public.tg_market_media(uuid,bigint),public.tg_market_media_v4(uuid,bigint) from public,anon,authenticated;
grant execute on function public.tg_market_media(uuid,bigint) to service_role;

-- Annotate radar delivery without duplicating the existing queue transport.
alter function public.tg_market_notify_worker(text,jsonb) rename to tg_market_notify_worker_v4;
revoke all on function public.tg_market_notify_worker_v4(text,jsonb) from service_role;
create function public.tg_market_notify_worker(p_operation text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;is_radar boolean;
begin
 result:=public.tg_market_notify_worker_v4(p_operation,p_data);
 if p_operation='claim' and result->>'id' is not null then
  select e.event_key like 'radar:%' into is_radar from public.tg_market_notify_queue q join public.tg_market_notify_events e on e.id=q.event_id where q.id=(result->>'id')::uuid;
  if is_radar then result:=result||jsonb_build_object('kind','radar');end if;
 end if;
 return result;
end$$;
revoke all on function public.tg_market_notify_worker(text,jsonb),public.tg_market_notify_worker_v4(text,jsonb) from public,anon,authenticated;
grant execute on function public.tg_market_notify_worker(text,jsonb) to service_role;
