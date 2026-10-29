-- Incremental user notifications. No new subscriptions, ads, rewards or historical fanout.
set local lock_timeout='3s';
alter table public.tg_market_notify_preferences
 add column welcome_seen_at timestamptz,
 add column welcome_surface text check(welcome_surface in ('bot','miniapp')),
 add column onboarding_state text not null default 'unseen' check(onboarding_state in ('unseen','shown','deferred','configuring','configured')),
 add column onboarding_surface text check(onboarding_surface in ('bot','miniapp')),
 add column onboarding_shown_at timestamptz,
 add column bot_started_at timestamptz,
 add column operational_consent_at timestamptz,
 add column optional_disabled boolean not null default false;
-- Preserve previously explicit operational consent, never infer a new marketing opt-in.
update public.tg_market_notify_preferences set operational_consent_at=consent_at where consent_at is not null and operational;
update public.tg_market_notify_preferences set onboarding_state='configured' where enabled and consent_at is not null;
create table public.tg_market_notify_ad_receipts(
 user_id uuid not null references public.tg_market_users(id),listing_id uuid not null references public.tg_market_listings(id),
 queue_id uuid not null unique references public.tg_market_notify_queue(id),created_at timestamptz not null default now(),
 primary key(user_id,listing_id));
alter table public.tg_market_notify_ad_receipts enable row level security;
alter table public.tg_market_notify_ad_receipts force row level security;
-- Import only existing delivery identities, never enqueue historical advertisements.
insert into public.tg_market_notify_ad_receipts(user_id,listing_id,queue_id)
 select distinct on(q.user_id,e.listing_id) q.user_id,e.listing_id,q.id
 from public.tg_market_notify_queue q join public.tg_market_notify_events e on e.id=q.event_id
 where e.kind='listing' and e.listing_id is not null and q.state in ('sent','sending','review','pending')
 order by q.user_id,e.listing_id,case q.state when 'sent' then 0 when 'review' then 1 when 'sending' then 2 else 3 end,q.created_at,q.id;
revoke all on public.tg_market_notify_ad_receipts from public,anon,authenticated,service_role;
alter table public.tg_market_notify_events drop constraint tg_market_notify_events_kind_check;
alter table public.tg_market_notify_events add constraint tg_market_notify_events_kind_check check(kind in ('listing','listing_approved','listing_rejected','rep_application','rep_approved','rep_rejected','rep_good','message','test','test_user'));

-- Narrow trusted server contact synchronization: D1's actual bot-start evidence only.
create function public.tg_market_notify_contacts(p_contacts jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;uid uuid;n int:=0;
begin
 if jsonb_typeof(p_contacts)<>'array' or jsonb_array_length(p_contacts)>50 then raise exception 'invalid contact batch';end if;
 for c in select jsonb_array_elements(p_contacts) loop
  select id into uid from public.tg_market_users where telegram_id=(c->>'actor')::bigint;
  if uid is not null then
   insert into public.tg_market_notify_preferences(user_id,bot_started_at,blocked) values(uid,now(),coalesce((c->>'blocked')::boolean,false))
   on conflict(user_id) do update set bot_started_at=coalesce(tg_market_notify_preferences.bot_started_at,excluded.bot_started_at),blocked=tg_market_notify_preferences.blocked or excluded.blocked;
   n:=n+1;
  end if;
 end loop;
 return jsonb_build_object('synced',n);
end$$;
revoke all on function public.tg_market_notify_contacts(jsonb) from public,anon,authenticated;
grant execute on function public.tg_market_notify_contacts(jsonb) to service_role;

-- Disabling advertising preserves separately consented account/message deliveries.
do $patch$ declare d text;begin
 select pg_get_functiondef('public.tg_market_notifications(bigint,text,jsonb,boolean,text)'::regprocedure) into d;
 if position($needle$if p_data->'enabled'<>'true'::jsonb then update public.tg_market_notify_queue set state='cancelled',error_code='unsubscribed' where user_id=u.id and state='pending';end if;$needle$ in d)=0 then raise exception 'notification save baseline differs';end if;
 d:=replace(d,$needle$if p_data->'enabled'<>'true'::jsonb then update public.tg_market_notify_queue set state='cancelled',error_code='unsubscribed' where user_id=u.id and state='pending';end if;$needle$,$needle$if p_data->'enabled'<>'true'::jsonb then update public.tg_market_notify_queue q set state='cancelled',error_code='unsubscribed' where user_id=u.id and state='pending' and exists(select 1 from public.tg_market_notify_events e where e.id=q.event_id and e.kind='listing');end if;$needle$);
 execute d;
end$patch$;
alter function public.tg_market_notifications(bigint,text,jsonb,boolean,text) rename to tg_market_notifications_v12;
revoke all on function public.tg_market_notifications_v12(bigint,text,jsonb,boolean,text) from public,anon,authenticated,service_role;
create function public.tg_market_notifications(p_actor bigint,p_operation text,p_data jsonb default '{}',p_admin boolean default false,p_name text default 'مستخدم') returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.tg_market_users;p public.tg_market_notify_preferences;result jsonb;op text;gov text;cat text;eid bigint;ad public.tg_market_listings;
begin
 op:=case p_operation when 'prompt_claim' then 'onboarding_claim' when 'prompt_accept' then 'onboarding_enable' when 'prompt_defer' then 'onboarding_defer' when 'prompt_filter' then 'onboarding_filter' else p_operation end;
 -- Existing trusted identity and root checks remain in the private legacy RPC.
 result:=public.tg_market_notifications_v12(p_actor,'get','{}',p_admin,p_name);
 select * into u from public.tg_market_users where telegram_id=p_actor;
 insert into public.tg_market_notify_preferences(user_id) values(u.id) on conflict do nothing;
 select * into p from public.tg_market_notify_preferences where user_id=u.id for update;
 if u.banned and op not in ('get','unsubscribe','bot_stop') then raise exception 'account unavailable';end if;
 if op='welcome_claim' then
  if p_data->>'surface' is null or p_data->>'surface' not in ('bot','miniapp') then raise exception 'invalid welcome surface';end if;
  if p.welcome_seen_at is null then
   update public.tg_market_notify_preferences set welcome_seen_at=now(),welcome_surface=p_data->>'surface' where user_id=u.id;
   return public.tg_market_notifications(p_actor,'get','{}',p_admin,p_name)||jsonb_build_object('show',true);
  end if;
  return public.tg_market_notifications(p_actor,'get','{}',p_admin,p_name)||jsonb_build_object('show',false);
 elsif op='bot_seen' then
  perform public.tg_market_notify_contacts(jsonb_build_array(jsonb_build_object('actor',p_actor,'blocked',coalesce((p_data->>'blocked')::boolean,false))));
  -- Only verified live private-chat updates may clear an earlier transport block.
  update public.tg_market_notify_preferences set blocked=coalesce((p_data->>'blocked')::boolean,false) where user_id=u.id;
 elsif op='onboarding_claim' then
  if p_data->>'surface' is null or p_data->>'surface' not in ('bot','miniapp') then raise exception 'invalid onboarding surface';end if;
  if p.onboarding_state='unseen' then
   update public.tg_market_notify_preferences set onboarding_state='shown',onboarding_surface=p_data->>'surface',onboarding_shown_at=now() where user_id=u.id;
   return public.tg_market_notifications(p_actor,'get','{}',p_admin,p_name)||jsonb_build_object('show',true);
  end if;
  return public.tg_market_notifications(p_actor,'get','{}',p_admin,p_name)||jsonb_build_object('show',false);
 elsif op='onboarding_defer' then
  if p.onboarding_state in ('unseen','shown','configuring','deferred') then update public.tg_market_notify_preferences set onboarding_state='deferred' where user_id=u.id;end if;
 elsif op in ('onboarding_enable','bot_enable') then
  if p_data->'confirmed' is distinct from 'true'::jsonb and op<>'bot_enable' then raise exception 'explicit consent required';end if;
  if p_data->>'update' is not null then
   insert into public.tg_market_notify_updates(update_id,actor) values((p_data->>'update')::bigint,u.id) on conflict do nothing;
   if not found then return public.tg_market_notifications(p_actor,'get','{}',p_admin,p_name)||jsonb_build_object('replayed',true);end if;
  end if;
  -- Clicking enable gives consent, but targeted ads wait for the filter save.
  update public.tg_market_notify_preferences set onboarding_state='configuring',consent_at=coalesce(consent_at,now()),optional_disabled=false where user_id=u.id;
 elsif op='onboarding_filter' then
  if p.onboarding_state not in ('configuring','configured') then raise exception 'subscription configuration required';end if;
  if p_data->>'update' is not null then
   insert into public.tg_market_notify_updates(update_id,actor) values((p_data->>'update')::bigint,u.id) on conflict do nothing;
   if not found then return public.tg_market_notifications(p_actor,'get','{}',p_admin,p_name)||jsonb_build_object('replayed',true);end if;
  end if;
  gov:=p_data->>'governorate';cat:=p_data->>'category';
  if gov is not null then
   if not gov=any(array['بغداد','البصرة','نينوى','أربيل','النجف','كربلاء','بابل','الأنبار','ديالى','كركوك','صلاح الدين','واسط','ميسان','ذي قار','المثنى','القادسية','دهوك','السليمانية','حلبجة']) then raise exception 'invalid governorate';end if;
   update public.tg_market_notify_preferences set scope='governorate',governorate=gov where user_id=u.id;
  end if;
  if cat is not null then
   if not cat=any(array['أثاث','سيارات','عقارات','إلكترونيات','أجهزة منزلية','ملابس','أخرى']) then raise exception 'invalid categories';end if;
   update public.tg_market_notify_preferences set categories=case when cat=any(categories) then array_remove(categories,cat) else array_append(categories,cat) end where user_id=u.id;
  end if;
  if p_data->'all_categories'='true'::jsonb then update public.tg_market_notify_preferences set categories='{}' where user_id=u.id;end if;
 elsif op='save' then
  if p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'explicit consent required';end if;
  -- Omitted personal preferences preserve the previous explicit choice.
  result:=public.tg_market_notifications_v12(p_actor,'save',p_data||jsonb_build_object('operational',coalesce((p_data->>'operational')::boolean,p.operational and p.operational_consent_at is not null)),p_admin,p_name);
  update public.tg_market_notify_preferences set blocked=p.blocked,optional_disabled=false,
   operational_consent_at=case when coalesce((p_data->>'operational')::boolean,p.operational and p.operational_consent_at is not null) then coalesce(p.operational_consent_at,now()) else null end,
   onboarding_state=case when p_data->'enabled'='true'::jsonb then 'configured' else onboarding_state end where user_id=u.id;
 elsif op in ('unsubscribe','bot_stop') then
  if op='bot_stop' and p_data->>'update' is not null then
   insert into public.tg_market_notify_updates(update_id,actor) values((p_data->>'update')::bigint,u.id) on conflict do nothing;
   if not found then return public.tg_market_notifications(p_actor,'get','{}',p_admin,p_name)||jsonb_build_object('replayed',true);end if;
  end if;
  update public.tg_market_notify_preferences set enabled=false,consent_at=null,operational=false,operational_consent_at=null,optional_disabled=true,updated_at=now() where user_id=u.id;
  update public.tg_market_notify_queue set state='cancelled',error_code='unsubscribed' where user_id=u.id and state='pending';
 elsif op='user_test_status' then
  if p_data->>'request' is null then raise exception 'test request required';end if;
  select e.id into eid from public.tg_market_notify_events e where e.event_key='user_test:'||(p_data->>'request')::uuid and e.target_user=u.id;
  if eid is null then return jsonb_build_object('state','not_found');end if;
  return (select jsonb_build_object('event',eid,'state',nq.state,'telegram_message_id',nq.message_id,'error_code',nq.error_code) from public.tg_market_notify_queue nq where nq.event_id=eid and nq.user_id=u.id);
 elsif op='user_test' then
  if p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'explicit test consent required';end if;
  return public.tg_market_notify_worker('test_user',p_data||jsonb_build_object('user',u.id));
 elsif op<>'get' then
  return public.tg_market_notifications_v12(p_actor,op,p_data,p_admin,p_name);
 end if;
 select * into p from public.tg_market_notify_preferences where user_id=u.id;
 result:=public.tg_market_notifications_v12(p_actor,'get','{}',p_admin,p_name);
 return result||jsonb_build_object('welcome_seen_at',p.welcome_seen_at,'welcome_surface',p.welcome_surface,'onboarding_state',p.onboarding_state,'prompt_state',p.onboarding_state,'operational_consent_at',p.operational_consent_at,'optional_disabled',p.optional_disabled,'bot_started',p.bot_started_at is not null,'bot_started_at',p.bot_started_at,'consent_at',p.consent_at);
end$$;
revoke all on function public.tg_market_notifications(bigint,text,jsonb,boolean,text) from public,anon,authenticated;
grant execute on function public.tg_market_notifications(bigint,text,jsonb,boolean,text) to service_role;

-- Eligibility is rechecked immediately before send. Operational consent is separate
-- from advertising consent; no user receives optional traffic merely by opening UI.
create or replace function public.tg_market_notify_eligible(p_event bigint,p_user uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
declare e public.tg_market_notify_events;p public.tg_market_notify_preferences;u public.tg_market_users;ad public.tg_market_listings;ctl public.tg_market_notify_control;
begin
 select * into e from public.tg_market_notify_events where id=p_event;select * into u from public.tg_market_users where id=p_user;
 if e.id is null or u.id is null or u.banned or e.expires_at<=now() or (e.target_user is not null and e.target_user<>u.id) then return false;end if;
 select * into p from public.tg_market_notify_preferences where user_id=u.id;
 if e.kind='test' then return exists(select 1 from public.tg_market_root where user_id=u.id) and (e.listing_id is null or exists(select 1 from public.tg_market_listings where id=e.listing_id and owner_id=u.id and status='active' and approved_at=e.revision and not exists(select 1 from public.tg_market_reports where listing_id=e.listing_id and status='open')));end if;
 if p.user_id is null or p.bot_started_at is null or p.blocked then return false;end if;
 if e.kind='test_user' then
  return e.target_user=u.id and (e.listing_id is null or exists(select 1 from public.tg_market_listings l join public.tg_market_users owner on owner.id=l.owner_id and not owner.banned where l.id=e.listing_id and l.status='active' and l.approved_at=e.revision and not exists(select 1 from public.tg_market_reports where listing_id=l.id and status='open')));
 end if;
 select * into ctl from public.tg_market_notify_control where singleton;
 if not ctl.enabled or e.created_at<ctl.enabled_at or p.optional_disabled or p.paused_until>now() then return false;end if;
 if e.kind='listing' then
  if not p.enabled or p.consent_at is null or p.consent_at>e.created_at then return false;end if;
  select * into ad from public.tg_market_listings where id=e.listing_id;
  if ad.id is null or ad.status<>'active' or ad.approved_at is distinct from e.revision or exists(select 1 from public.tg_market_users where id=ad.owner_id and banned) or exists(select 1 from public.tg_market_reports where listing_id=ad.id and status='open') or ad.owner_id=u.id then return false;end if;
  if e.event_key like 'radar:%' then
   return exists(select 1 from public.tg_market_radar_matches m join public.tg_market_radars r on r.id=m.radar_id where m.event_id=e.id and r.owner_id=u.id and r.notifications and r.consent_at<=e.created_at and public.tg_market_radar_matches_ad(r,ad));
  end if;
  return not(p.scope='governorate' and p.governorate is distinct from ad.governorate) and (cardinality(p.categories)=0 or ad.category=any(p.categories));
 end if;
 if not p.operational or p.operational_consent_at is null or p.operational_consent_at>e.created_at then return false;end if;
 if e.kind='listing_approved' then return exists(select 1 from public.tg_market_listings where id=e.listing_id and owner_id=u.id and status='active' and approved_at=e.revision);end if;
 if e.kind='listing_rejected' then return exists(select 1 from public.tg_market_listings where id=e.listing_id and status='hidden' and owner_id=u.id);end if;
 if e.kind='rep_good' then return p.rep_goods and u.role='rep' and exists(select 1 from public.tg_market_rep_applications where user_id=u.id and status='approved') and exists(select 1 from public.tg_market_rep_goods where id=e.good_id and status='active');end if;
 if e.kind='rep_application' then return exists(select 1 from public.tg_market_root where user_id=u.id) and exists(select 1 from public.tg_market_rep_applications where user_id=e.subject_user and status='pending');end if;
 if e.kind='rep_approved' then return u.role='rep' and exists(select 1 from public.tg_market_rep_applications where user_id=u.id and status='approved');end if;
 if e.kind='rep_rejected' then return exists(select 1 from public.tg_market_rep_applications where user_id=u.id and status='rejected');end if;
 if e.kind='message' then return exists(select 1 from public.tg_market_threads where id=e.thread_id and u.id in(buyer_id,seller_id)) and not exists(select 1 from public.tg_market_notify_reads r join public.tg_market_messages m on m.id=e.message_ref where r.user_id=u.id and r.thread_id=e.thread_id and row(m.created_at,m.id)<=row(r.last_read_at,r.last_read_id));end if;
 return false;
end$$;
revoke all on function public.tg_market_notify_eligible(bigint,uuid) from public,anon,authenticated,service_role;

-- Keep existing transport implementation, removing destructive retention and
-- replacing fixed unavailable-photo delay with bounded backoff.
do $patch$ declare d text;begin
 select pg_get_functiondef('public.tg_market_notify_worker_v4(text,jsonb)'::regprocedure) into d;
 if position($needle$delete from public.tg_market_notify_queue where id in(select id from public.tg_market_notify_queue where state in ('sent','failed','cancelled')$needle$ in d)=0 then raise exception 'notification retention baseline differs';end if;
 d:=replace(d,$needle$delete from public.tg_market_notify_queue where id in(select id from public.tg_market_notify_queue where state in ('sent','failed','cancelled') and created_at<now()-interval '30 days' limit 100);$needle$,'-- Durable delivery receipts and failed events are retained.');
 d:=replace(d,$needle$if q.attempts>=10 then update public.tg_market_notify_queue set state='failed',error_code='retry_limit' where id=q.id;return jsonb_build_object('skipped',true);end if;$needle$,'-- Known transient failures keep their deferred retry, without dropping events.');
 d:=replace(d,$needle$if not public.tg_market_notify_eligible(q.event_id,q.user_id) then update public.tg_market_notify_queue set state='cancelled',error_code='no_longer_eligible' where id=q.id;return jsonb_build_object('skipped',true);end if;$needle$,$needle$if exists(select 1 from public.tg_market_notify_events where id=q.event_id and kind not in ('test','test_user')) and not exists(select 1 from public.tg_market_notify_preferences where user_id=q.user_id and bot_started_at is not null) then update public.tg_market_notify_queue set available_at=now()+interval '5 minutes',error_code='private_start_unverified' where id=q.id;return jsonb_build_object('skipped',true);end if;
  if not public.tg_market_notify_eligible(q.event_id,q.user_id) then update public.tg_market_notify_queue set state='cancelled',error_code='no_longer_eligible' where id=q.id;return jsonb_build_object('skipped',true);end if;$needle$);

 d:=replace(d,$needle$available_at=now()+interval '30 seconds',error_code='photo_unavailable'$needle$,$needle$available_at=now()+make_interval(secs=>least(3600,15*power(2,least(q.attempts,8)))::int),error_code='photo_unavailable'$needle$);
 execute d;
end$patch$;

alter function public.tg_market_notify_worker(text,jsonb) rename to tg_market_notify_worker_v12;
revoke all on function public.tg_market_notify_worker_v12(text,jsonb) from public,anon,authenticated,service_role;
create function public.tg_market_notify_worker(p_operation text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;q public.tg_market_notify_queue;e public.tg_market_notify_events;u public.tg_market_users;ad public.tg_market_listings;eid bigint;receipt uuid;img jsonb;
begin
 if p_operation='test_user' then
  if p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'explicit test consent required';end if;
  select * into u from public.tg_market_users where id=(p_data->>'user')::uuid and not banned;
  if u.id is null or not exists(select 1 from public.tg_market_notify_preferences where user_id=u.id and bot_started_at is not null and not blocked) then raise exception 'private bot start required';end if;
  if p_data->>'listing' is not null then
   select * into ad from public.tg_market_listings l where id=(p_data->>'listing')::uuid and status='active' and approved_at is not null and not exists(select 1 from public.tg_market_users where id=l.owner_id and banned) and not exists(select 1 from public.tg_market_reports where listing_id=l.id and status='open');
   if ad.id is null then raise exception 'approved listing required';end if;
  end if;
  if p_data->>'request' is null then raise exception 'test request required';end if;
  if not exists(select 1 from public.tg_market_notify_events where event_key='user_test:'||(p_data->>'request')::uuid and target_user=u.id) and exists(select 1 from public.tg_market_notify_events where kind='test_user' and target_user=u.id and created_at>now()-interval '1 minute') then raise exception 'test rate limited';end if;
  insert into public.tg_market_notify_events(event_key,kind,target_user,done,listing_id,revision) values('user_test:'||(p_data->>'request')::uuid,'test_user',u.id,true,ad.id,ad.approved_at) on conflict(event_key) do nothing;
  select id into eid from public.tg_market_notify_events where event_key='user_test:'||(p_data->>'request')::uuid and target_user=u.id;
  if eid is null then raise exception 'test target differs';end if;
  insert into public.tg_market_notify_queue(event_id,user_id) values(eid,u.id) on conflict(event_id,user_id) do nothing;
  return (select jsonb_build_object('event',eid,'state',nq.state,'telegram_message_id',nq.message_id,'error_code',nq.error_code) from public.tg_market_notify_queue nq where nq.event_id=eid and nq.user_id=u.id);
 end if;
 result:=public.tg_market_notify_worker_v12(p_operation,p_data);
 if p_operation='claim' and result->>'id' is not null then
  select * into q from public.tg_market_notify_queue where id=(result->>'id')::uuid;select * into e from public.tg_market_notify_events where id=q.event_id;
  if e.kind='listing' then
   insert into public.tg_market_notify_ad_receipts(user_id,listing_id,queue_id) values(q.user_id,e.listing_id,q.id) on conflict(user_id,listing_id) do nothing;
   select queue_id into receipt from public.tg_market_notify_ad_receipts where user_id=q.user_id and listing_id=e.listing_id;
   if receipt<>q.id then update public.tg_market_notify_queue set state='cancelled',error_code='duplicate_user_listing' where id=q.id;return jsonb_build_object('skipped',true);end if;
  elsif e.kind='test_user' and e.listing_id is not null then
   select * into ad from public.tg_market_listings where id=e.listing_id;
   result:=result||jsonb_build_object('title',ad.title,'description',ad.description,'price',ad.price,'area',concat_ws(' · ',ad.governorate,ad.area));
   if cardinality(ad.images)>0 then select jsonb_build_object('path',path,'mime',mime) into img from public.tg_market_images where id=ad.images[1] and owner_id=ad.owner_id and ready;result:=result||jsonb_build_object('image',img);end if;
  end if;
 end if;
 return result;
end$$;
revoke all on function public.tg_market_notify_worker(text,jsonb) from public,anon,authenticated;
grant execute on function public.tg_market_notify_worker(text,jsonb) to service_role;
