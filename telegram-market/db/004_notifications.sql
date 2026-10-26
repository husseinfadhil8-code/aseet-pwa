-- Incremental, Telegram-only. No backfill, subscription, message or advertisement seed.
alter table public.tg_market_listings add column governorate text;
create table public.tg_market_notify_preferences(user_id uuid primary key references public.tg_market_users(id) on delete cascade,enabled boolean not null default false,consent_at timestamptz,scope text not null default 'all' check(scope in ('all','governorate')),governorate text,categories text[] not null default '{}',operational boolean not null default true,rep_goods boolean not null default true,paused_until timestamptz,blocked boolean not null default false,updated_at timestamptz not null default now(),check(not enabled or consent_at is not null));
create table public.tg_market_notify_updates(update_id bigint primary key,actor uuid not null references public.tg_market_users(id) on delete cascade,created_at timestamptz not null default now());
create table public.tg_market_notify_control(singleton boolean primary key default true check(singleton),enabled boolean not null default false,enabled_at timestamptz not null default now(),next_send_at timestamptz not null default now(),last_cron_at timestamptz);
insert into public.tg_market_notify_control(singleton) values(true);
create table public.tg_market_rep_goods(id uuid primary key default gen_random_uuid(),title text not null check(length(trim(title)) between 5 and 120),description text not null default '' check(length(description)<=3000),area text not null check(length(trim(area)) between 2 and 100),price bigint not null check(price between 0 and 1000000000000),status text not null default 'active' check(status in ('active','hidden')),created_at timestamptz not null default now());
create table public.tg_market_notify_presence(user_id uuid primary key references public.tg_market_users(id) on delete cascade,thread_id uuid not null references public.tg_market_threads(id) on delete cascade,expires_at timestamptz not null);
create table public.tg_market_notify_reads(user_id uuid not null references public.tg_market_users(id) on delete cascade,thread_id uuid not null references public.tg_market_threads(id) on delete cascade,last_read_at timestamptz not null,last_read_id uuid not null references public.tg_market_messages(id) on delete cascade,primary key(user_id,thread_id));
create table public.tg_market_notify_events(id bigint generated always as identity primary key,event_key text unique not null,kind text not null check(kind in ('listing','listing_approved','listing_rejected','rep_application','rep_approved','rep_rejected','rep_good','message','test')),listing_id uuid references public.tg_market_listings(id) on delete cascade,thread_id uuid references public.tg_market_threads(id) on delete cascade,good_id uuid references public.tg_market_rep_goods(id) on delete cascade,message_ref uuid references public.tg_market_messages(id) on delete cascade,target_user uuid references public.tg_market_users(id) on delete cascade,subject_user uuid references public.tg_market_users(id) on delete cascade,revision timestamptz,created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '2 days',cursor_user uuid,done boolean not null default false,photo_file_id text);
create table public.tg_market_notify_queue(id uuid primary key default gen_random_uuid(),event_id bigint not null references public.tg_market_notify_events(id) on delete cascade,user_id uuid not null references public.tg_market_users(id) on delete cascade,state text not null default 'pending' check(state in ('pending','sending','sent','failed','review','cancelled')),attempts integer not null default 0,available_at timestamptz not null default now(),lease uuid,claimed_at timestamptz,message_id bigint,error_code text,created_at timestamptz not null default now(),sent_at timestamptz,unique(event_id,user_id));
create index tg_market_notify_due on public.tg_market_notify_queue(available_at,id) where state='pending';
create index tg_market_notify_events_due on public.tg_market_notify_events(id) where not done;
create index tg_market_notify_user on public.tg_market_notify_queue(user_id,created_at desc);
do $$declare t text;begin foreach t in array array['notify_preferences','notify_updates','notify_control','rep_goods','notify_presence','notify_reads','notify_events','notify_queue'] loop execute format('alter table public.%I enable row level security','tg_market_'||t);execute format('revoke all on public.%I from public,anon,authenticated','tg_market_'||t);end loop;end$$;
create function public.tg_market_notify_trigger() returns trigger language plpgsql security definer set search_path='' as $$
declare dest uuid;root uuid;key text;
begin
 if tg_table_name='tg_market_listings' then
  if old.governorate is distinct from new.governorate then
   -- A separate BEFORE trigger clears approval when the structured region changes.
   return new;
  end if;
  if old.approved_at is null and new.approved_at is not null and new.status='active' then
   insert into public.tg_market_notify_events(event_key,kind,listing_id,revision) values('listing:'||new.id,'listing',new.id,new.approved_at) on conflict(event_key) do nothing;
   insert into public.tg_market_notify_events(event_key,kind,listing_id,target_user,revision) values('listing_approved:'||new.id,'listing_approved',new.id,new.owner_id,new.approved_at) on conflict(event_key) do nothing;
  end if;
 elsif tg_table_name='tg_market_messages' then
  select case when new.sender_id=t.buyer_id then t.seller_id else t.buyer_id end into dest from public.tg_market_threads t where t.id=new.thread_id and new.sender_id in(t.buyer_id,t.seller_id);
  if dest is not null then insert into public.tg_market_notify_events(event_key,kind,thread_id,target_user,message_ref) values('message:'||new.id,'message',new.thread_id,dest,new.id);end if;
 elsif tg_table_name='tg_market_rep_applications' then
  key:=new.id::text||':'||new.created_at::text;
  if tg_op='INSERT' or old.status is distinct from new.status or old.created_at is distinct from new.created_at then
   if new.status='pending' then select user_id into root from public.tg_market_root where singleton;
    if root is not null then insert into public.tg_market_notify_events(event_key,kind,target_user,subject_user) values('rep_application:'||key,'rep_application',root,new.user_id) on conflict(event_key) do nothing;end if;
   else insert into public.tg_market_notify_events(event_key,kind,target_user) values('rep_'||new.status||':'||key,'rep_'||new.status,new.user_id) on conflict(event_key) do nothing;end if;
  end if;
 elsif tg_table_name='tg_market_rep_goods' and new.status='active' then
  insert into public.tg_market_notify_events(event_key,kind,good_id) values('rep_good:'||new.id,'rep_good',new.id) on conflict(event_key) do nothing;
 end if;
 return new;
end$$;
create function public.tg_market_notify_region_reset() returns trigger language plpgsql set search_path='' as $$begin if old.governorate is distinct from new.governorate then new.approved_at:=null;new.approved_by:=null;end if;return new;end$$;
create trigger tg_market_notify_region_reset before update of governorate on public.tg_market_listings for each row execute function public.tg_market_notify_region_reset();
create trigger tg_market_notify_listing after update on public.tg_market_listings for each row execute function public.tg_market_notify_trigger();
create trigger tg_market_notify_message after insert on public.tg_market_messages for each row execute function public.tg_market_notify_trigger();
create trigger tg_market_notify_application after insert or update on public.tg_market_rep_applications for each row execute function public.tg_market_notify_trigger();
create trigger tg_market_notify_good after insert on public.tg_market_rep_goods for each row execute function public.tg_market_notify_trigger();
create function public.tg_market_notify_eligible(p_event bigint,p_user uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare e public.tg_market_notify_events;p public.tg_market_notify_preferences;u public.tg_market_users;ad public.tg_market_listings;ctl public.tg_market_notify_control;
begin
 select * into e from public.tg_market_notify_events where id=p_event;
 select * into u from public.tg_market_users where id=p_user;
 if e.id is null or u.id is null or u.banned or e.expires_at<=now() or (e.target_user is not null and e.target_user<>u.id) then return false;end if;
 -- Test is a single explicit root request, not an advertisement subscription.
 if e.kind='test' then return exists(select 1 from public.tg_market_root where user_id=u.id) and (e.listing_id is null or exists(select 1 from public.tg_market_listings where id=e.listing_id and owner_id=u.id and status='active' and approved_at=e.revision and not exists(select 1 from public.tg_market_reports where listing_id=e.listing_id and status='open')));end if;
 select * into ctl from public.tg_market_notify_control where singleton;
 select * into p from public.tg_market_notify_preferences where user_id=u.id;
 if not ctl.enabled or e.created_at<ctl.enabled_at or p.user_id is null or not p.enabled or p.blocked or p.consent_at>e.created_at or p.paused_until>now() then return false;end if;
 if e.kind in ('listing','listing_approved') then
  select * into ad from public.tg_market_listings where id=e.listing_id;
  if ad.id is null or ad.status<>'active' or ad.approved_at is distinct from e.revision or exists(select 1 from public.tg_market_users where id=ad.owner_id and banned) or exists(select 1 from public.tg_market_reports where listing_id=ad.id and status='open') then return false;end if;
  if e.kind='listing' then
   if ad.owner_id=u.id or (p.scope='governorate' and p.governorate is distinct from ad.governorate) or (cardinality(p.categories)>0 and not ad.category=any(p.categories)) then return false;end if;
   return true;
  end if;
 end if;
 if not p.operational then return false;end if;
 if e.kind='listing_rejected' then return exists(select 1 from public.tg_market_listings where id=e.listing_id and status='hidden' and owner_id=u.id);end if;
 if e.kind='rep_good' then return p.rep_goods and u.role='rep' and exists(select 1 from public.tg_market_rep_applications where user_id=u.id and status='approved') and exists(select 1 from public.tg_market_rep_goods where id=e.good_id and status='active');end if;
 if e.kind='rep_application' then return exists(select 1 from public.tg_market_root where user_id=u.id) and exists(select 1 from public.tg_market_rep_applications where user_id=e.subject_user and status='pending');end if;
 if e.kind='rep_approved' then return u.role='rep' and exists(select 1 from public.tg_market_rep_applications where user_id=u.id and status='approved');end if;
 if e.kind='rep_rejected' then return exists(select 1 from public.tg_market_rep_applications where user_id=u.id and status='rejected');end if;
 if e.kind='message' then return exists(select 1 from public.tg_market_threads where id=e.thread_id and u.id in(buyer_id,seller_id)) and not exists(select 1 from public.tg_market_notify_reads r join public.tg_market_messages m on m.id=e.message_ref where r.user_id=u.id and r.thread_id=e.thread_id and row(m.created_at,m.id)<=row(r.last_read_at,r.last_read_id));end if;
 return true;
end$$;
create function public.tg_market_notifications(p_actor bigint,p_operation text,p_data jsonb default '{}',p_admin boolean default false,p_name text default 'مستخدم') returns jsonb language plpgsql security definer set search_path='' as $$
declare me jsonb;u public.tg_market_users;root boolean;p public.tg_market_notify_preferences;cats text[];gov text;res jsonb;ad public.tg_market_listings;g public.tg_market_rep_goods;eid bigint;
begin
 me:=public.tg_market_action(p_actor,'me','{}',p_admin,p_name);
 select * into u from public.tg_market_users where id=(me->>'id')::uuid;
 root:=exists(select 1 from public.tg_market_root where user_id=u.id) and u.role='admin' and p_admin;
 if p_operation in ('bot_enable','bot_stop') then
  insert into public.tg_market_notify_updates(update_id,actor) values((p_data->>'update')::bigint,u.id) on conflict(update_id) do nothing;
  if not found then return public.tg_market_notifications(p_actor,'get','{}',p_admin,p_name)||jsonb_build_object('replayed',true);end if;
  if p_operation='bot_stop' then return public.tg_market_notifications(p_actor,'unsubscribe','{}',p_admin,p_name);end if;
  if exists(select 1 from public.tg_market_notify_preferences where user_id=u.id and enabled) then return public.tg_market_notifications(p_actor,'get','{}',p_admin,p_name);end if;
  return public.tg_market_notifications(p_actor,'save','{"enabled":true,"confirmed":true,"scope":"all"}',p_admin,p_name);
 end if;
 if p_operation='get' then select * into p from public.tg_market_notify_preferences where user_id=u.id;return jsonb_build_object('enabled',coalesce(p.enabled,false),'scope',coalesce(p.scope,'all'),'governorate',p.governorate,'categories',coalesce(p.categories,'{}'),'operational',coalesce(p.operational,true),'rep_goods',coalesce(p.rep_goods,true),'paused_until',p.paused_until,'blocked',coalesce(p.blocked,false));end if;
 if p_operation='save' then
  if p_data->'confirmed' is distinct from 'true'::jsonb or jsonb_typeof(p_data->'enabled') is distinct from 'boolean' then raise exception 'explicit consent required';end if;
  cats:=array(select distinct jsonb_array_elements_text(coalesce(p_data->'categories','[]')));
  if cardinality(cats)>7 or not cats<@array['أثاث','سيارات','عقارات','إلكترونيات','أجهزة منزلية','ملابس','أخرى'] then raise exception 'invalid categories';end if;
  gov:=nullif(trim(p_data->>'governorate'),'');
  if coalesce(p_data->>'scope','all') not in ('all','governorate') or (p_data->>'scope'='governorate' and (gov is null or not gov=any(array['بغداد','البصرة','نينوى','أربيل','النجف','كربلاء','بابل','الأنبار','ديالى','كركوك','صلاح الدين','واسط','ميسان','ذي قار','المثنى','القادسية','دهوك','السليمانية','حلبجة']))) then raise exception 'governorate required';end if;
  insert into public.tg_market_notify_preferences(user_id,enabled,consent_at,scope,governorate,categories,operational,rep_goods) values(u.id,p_data->'enabled'='true',case when p_data->'enabled'='true' then now() end,coalesce(p_data->>'scope','all'),gov,cats,coalesce((p_data->>'operational')::boolean,true),coalesce((p_data->>'rep_goods')::boolean,true)) on conflict(user_id) do update set enabled=excluded.enabled,consent_at=case when excluded.enabled then case when tg_market_notify_preferences.enabled then tg_market_notify_preferences.consent_at else now() end else null end,scope=excluded.scope,governorate=excluded.governorate,categories=excluded.categories,operational=excluded.operational,rep_goods=excluded.rep_goods,blocked=false,paused_until=null,updated_at=now();
  if p_data->'enabled'<>'true'::jsonb then update public.tg_market_notify_queue set state='cancelled',error_code='unsubscribed' where user_id=u.id and state='pending';end if;
  return public.tg_market_notifications(p_actor,'get','{}',p_admin,p_name);
 end if;
 if p_operation='pause' then update public.tg_market_notify_preferences set paused_until=now()+interval '24 hours' where user_id=u.id;update public.tg_market_notify_queue set state='cancelled',error_code='paused' where user_id=u.id and state='pending';return '{}';end if;
 if p_operation='unsubscribe' then update public.tg_market_notify_preferences set enabled=false,consent_at=null,categories='{}',governorate=null,blocked=false,paused_until=null,updated_at=now() where user_id=u.id;update public.tg_market_notify_queue set state='cancelled',error_code='unsubscribed' where user_id=u.id and state='pending';return '{}';end if;
 if p_operation='presence' then
  if p_data->'active' is distinct from 'true'::jsonb then delete from public.tg_market_notify_presence where user_id=u.id and (p_data->>'thread' is null or thread_id=(p_data->>'thread')::uuid);return '{}';end if;
  if not exists(select 1 from public.tg_market_threads where id=(p_data->>'thread')::uuid and u.id in(buyer_id,seller_id)) then raise exception 'thread required';end if;
  if p_data->>'read_id' is not null then
   insert into public.tg_market_notify_reads(user_id,thread_id,last_read_at,last_read_id) select u.id,m.thread_id,m.created_at,m.id from public.tg_market_messages m where m.id=(p_data->>'read_id')::uuid and m.thread_id=(p_data->>'thread')::uuid on conflict(user_id,thread_id) do update set last_read_at=excluded.last_read_at,last_read_id=excluded.last_read_id where row(tg_market_notify_reads.last_read_at,tg_market_notify_reads.last_read_id)<row(excluded.last_read_at,excluded.last_read_id);
  end if;
  insert into public.tg_market_notify_presence(user_id,thread_id,expires_at) values(u.id,(p_data->>'thread')::uuid,now()+interval '30 seconds') on conflict(user_id) do update set thread_id=excluded.thread_id,expires_at=excluded.expires_at;return '{}';
 end if;
 if p_operation='save_listing' then
  gov:=nullif(trim(p_data->>'governorate'),'');
  if gov is not null and not gov=any(array['بغداد','البصرة','نينوى','أربيل','النجف','كربلاء','بابل','الأنبار','ديالى','كركوك','صلاح الدين','واسط','ميسان','ذي قار','المثنى','القادسية','دهوك','السليمانية','حلبجة']) then raise exception 'invalid governorate';end if;
  res:=public.tg_market_action(p_actor,'save',p_data,p_admin,p_name);update public.tg_market_listings set governorate=gov where id=(res->>'id')::uuid and owner_id=u.id;return res;
 end if;
 if p_operation='goods' then
  if not root and (u.role<>'rep' or not exists(select 1 from public.tg_market_rep_applications where user_id=u.id and status='approved')) then raise exception 'rep required';end if;
  return coalesce((select jsonb_agg(to_jsonb(q)) from(select * from public.tg_market_rep_goods where status='active' and (p_data->>'id' is null or id=(p_data->>'id')::uuid) order by created_at desc limit 30)q),'[]');
 end if;
 if not root then raise exception 'owner required';end if;
 if p_operation='stats' then return jsonb_build_object('enabled',(select enabled from public.tg_market_notify_control where singleton),'last_cron_at',(select last_cron_at from public.tg_market_notify_control where singleton),'subscribers',(select count(*) from public.tg_market_notify_preferences where enabled and not blocked),'states',(select coalesce(jsonb_object_agg(state,n),'{}') from(select state,count(*) n from public.tg_market_notify_queue group by state)q),'recent',coalesce((select jsonb_agg(to_jsonb(q)) from(select q.id,q.state,q.attempts,q.error_code,q.created_at,q.sent_at,e.kind from public.tg_market_notify_queue q join public.tg_market_notify_events e on e.id=q.event_id order by q.created_at desc limit 50)q),'[]'));end if;
 if p_operation='reject_listing' then
  select * into ad from public.tg_market_listings where id=(p_data->>'id')::uuid for update;
  if ad.id is null or ad.status in ('sold','deleted') then raise exception 'listing unavailable';end if;
  perform public.tg_market_action(p_actor,'admin_listing',jsonb_build_object('id',ad.id,'status','hidden'),p_admin,p_name);
  insert into public.tg_market_notify_events(event_key,kind,listing_id,target_user) values('listing_rejected:'||ad.id,'listing_rejected',ad.id,ad.owner_id) on conflict(event_key) do nothing;return '{}';
 end if;
 if p_operation='good_save' then
  insert into public.tg_market_rep_goods(id,title,description,area,price) values((p_data->>'id')::uuid,p_data->>'title',coalesce(p_data->>'description',''),p_data->>'area',(p_data->>'price')::bigint) on conflict(id) do nothing returning * into g;return jsonb_build_object('id',p_data->>'id');
 end if;
 if p_operation='good_hide' then update public.tg_market_rep_goods set status='hidden' where id=(p_data->>'id')::uuid;return '{}';end if;
 if p_operation='test' then
  if p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'explicit consent required';end if;
  if p_data->>'listing' is not null then select * into ad from public.tg_market_listings where id=(p_data->>'listing')::uuid and owner_id=u.id and status='active' and approved_at is not null;if ad.id is null then raise exception 'approved owner listing required';end if;end if;
  insert into public.tg_market_notify_events(event_key,kind,target_user,done,listing_id,revision) values('test:'||(p_data->>'request')::uuid,'test',u.id,true,ad.id,ad.approved_at) on conflict(event_key) do nothing;
  select id into eid from public.tg_market_notify_events where event_key='test:'||(p_data->>'request')::uuid;
  insert into public.tg_market_notify_queue(event_id,user_id) values(eid,u.id) on conflict(event_id,user_id) do nothing;return jsonb_build_object('event',eid);
 end if;
 raise exception 'unknown notification operation';
end$$;
create function public.tg_market_notify_worker(p_operation text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.tg_market_notify_events;q public.tg_market_notify_queue;u public.tg_market_users;ad public.tg_market_listings;g public.tg_market_rep_goods;ctl public.tg_market_notify_control;v record;n int:=0;last_id uuid;body jsonb;image jsonb;v_lease uuid;delay int;
begin
 if p_operation='heartbeat' then update public.tg_market_notify_control set last_cron_at=now() where singleton;return '{}';end if;
 if p_operation='activate' then
  if not exists(select 1 from public.tg_market_notify_queue nq join public.tg_market_notify_events ne on ne.id=nq.event_id where ne.kind='test' and nq.state='sent' and nq.message_id is not null) then raise exception 'real delivery test required';end if;
  update public.tg_market_notify_control set enabled=true,enabled_at=case when enabled then enabled_at else now() end where singleton;return '{}';
 end if;
 if p_operation='fanout' then
  update public.tg_market_notify_queue set state='review',error_code='delivery_uncertain' where state='sending' and claimed_at<now()-interval '5 minutes';
  delete from public.tg_market_notify_presence where expires_at<now()-interval '1 hour';
  delete from public.tg_market_notify_queue where id in(select id from public.tg_market_notify_queue where state in ('sent','failed','cancelled') and created_at<now()-interval '30 days' limit 100);
  select * into e from public.tg_market_notify_events where not done order by case when target_user is not null then 0 else 1 end,id for update skip locked limit 1;
  if e.id is null then return '{}';end if;
  if e.expires_at<=now() then update public.tg_market_notify_events set done=true where id=e.id;return '{}';end if;
  if e.target_user is not null then
   if public.tg_market_notify_eligible(e.id,e.target_user) then insert into public.tg_market_notify_queue(event_id,user_id) values(e.id,e.target_user) on conflict(event_id,user_id) do nothing;end if;
   update public.tg_market_notify_events set done=true where id=e.id;return '{}';
  end if;
  for v in select user_id from public.tg_market_notify_preferences where consent_at<=e.created_at and (e.cursor_user is null or user_id>e.cursor_user) order by user_id limit 50 loop
   n:=n+1;last_id:=v.user_id;
   if public.tg_market_notify_eligible(e.id,v.user_id) then insert into public.tg_market_notify_queue(event_id,user_id) values(e.id,v.user_id) on conflict(event_id,user_id) do nothing;end if;
  end loop;
  update public.tg_market_notify_events set cursor_user=coalesce(last_id,cursor_user),done=n<50 where id=e.id;return jsonb_build_object('scanned',n);
 end if;
 if p_operation='claim' then
  select * into ctl from public.tg_market_notify_control where singleton for update;
  if ctl.next_send_at>now() then return jsonb_build_object('wait_ms',ceil(extract(epoch from ctl.next_send_at-now())*1000));end if;
  select nq.* into q from public.tg_market_notify_queue nq join public.tg_market_notify_events ne on ne.id=nq.event_id where nq.state='pending' and nq.available_at<=now() order by case when ne.kind='message' then 0 when ne.kind='listing' then 2 else 1 end,nq.available_at,nq.id for update of nq skip locked limit 1;
  if q.id is null then return '{}';end if;
  if not public.tg_market_notify_eligible(q.event_id,q.user_id) then update public.tg_market_notify_queue set state='cancelled',error_code='no_longer_eligible' where id=q.id;return jsonb_build_object('skipped',true);end if;
  if q.attempts>=10 then update public.tg_market_notify_queue set state='failed',error_code='retry_limit' where id=q.id;return jsonb_build_object('skipped',true);end if;
  select * into e from public.tg_market_notify_events where id=q.event_id;
  if e.kind='message' and exists(select 1 from public.tg_market_notify_presence where user_id=q.user_id and thread_id=e.thread_id and expires_at>now()) then
   update public.tg_market_notify_queue set available_at=(select expires_at+interval '1 second' from public.tg_market_notify_presence where user_id=q.user_id) where id=q.id;return jsonb_build_object('skipped',true);
  end if;
  select * into u from public.tg_market_users where id=q.user_id;
  v_lease:=gen_random_uuid();update public.tg_market_notify_queue set state='sending',attempts=attempts+1,lease=v_lease,claimed_at=now() where id=q.id;
  update public.tg_market_notify_control set next_send_at=now()+interval '1.1 seconds' where singleton;
  body:=jsonb_build_object('id',q.id,'lease',v_lease,'chat',u.telegram_id,'kind',e.kind,'thread',e.thread_id,'listing',e.listing_id,'good',e.good_id,'file_id',e.photo_file_id);
  if e.kind='listing' or (e.kind='test' and e.listing_id is not null) then
   select * into ad from public.tg_market_listings where id=e.listing_id;
   body:=body||jsonb_build_object('title',ad.title,'description',ad.description,'price',ad.price,'area',concat_ws(' · ',ad.governorate,ad.area));
   if cardinality(ad.images)>0 and e.photo_file_id is null then select jsonb_build_object('path',path,'mime',mime) into image from public.tg_market_images where id=ad.images[1] and owner_id=ad.owner_id and ready;body:=body||jsonb_build_object('image',image);end if;
  elsif e.kind='rep_good' then select * into g from public.tg_market_rep_goods where id=e.good_id;body:=body||jsonb_build_object('title',g.title,'description',g.description,'price',g.price,'area',g.area);
  end if;
  return body;
 end if;
 if p_operation='validate' then
  select * into q from public.tg_market_notify_queue where id=(p_data->>'id')::uuid and lease=(p_data->>'lease')::uuid and state='sending' for update;
  if q.id is null then return jsonb_build_object('valid',false);end if;
  if not public.tg_market_notify_eligible(q.event_id,q.user_id) then update public.tg_market_notify_queue set state='cancelled',error_code='no_longer_eligible' where id=q.id;return jsonb_build_object('valid',false);end if;
  return jsonb_build_object('valid',true);
 end if;
 if p_operation='finish' then
  select * into q from public.tg_market_notify_queue where id=(p_data->>'id')::uuid and lease=(p_data->>'lease')::uuid and state='sending' for update;
  if q.id is null then return '{}';end if;
  if p_data->>'outcome'='sent' and (p_data->>'message')::bigint>0 then
   update public.tg_market_notify_queue set state='sent',message_id=(p_data->>'message')::bigint,sent_at=now(),error_code=null where id=q.id;
   if length(p_data->>'file_id') between 1 and 1024 then update public.tg_market_notify_events set photo_file_id=p_data->>'file_id' where id=q.event_id and photo_file_id is null;end if;
  elsif p_data->>'outcome'='rate_limited' then
   delay:=least(greatest(coalesce((p_data->>'retry_after')::int,30),1),86400);
   update public.tg_market_notify_queue set state='pending',available_at=now()+make_interval(secs=>delay),error_code='rate_limited',lease=null where id=q.id;
   update public.tg_market_notify_control set next_send_at=greatest(next_send_at,now()+make_interval(secs=>delay)) where singleton;
  elsif p_data->>'outcome'='retryable' then
   update public.tg_market_notify_queue set state='pending',available_at=now()+interval '30 seconds',error_code='photo_unavailable',lease=null where id=q.id;
  elsif p_data->>'outcome'='blocked' then
   update public.tg_market_notify_preferences set enabled=false,blocked=true,consent_at=null,updated_at=now() where user_id=q.user_id;
   update public.tg_market_notify_queue set state='failed',error_code='bot_blocked' where id=q.id;
   update public.tg_market_notify_queue set state='cancelled',error_code='bot_blocked' where user_id=q.user_id and state='pending';
  elsif p_data->>'outcome'='failed' then update public.tg_market_notify_queue set state='failed',error_code='telegram_rejected' where id=q.id;
  else update public.tg_market_notify_queue set state='review',error_code='delivery_uncertain' where id=q.id;
  end if;return '{}';
 end if;
 raise exception 'unknown worker operation';
end$$;
revoke all on function public.tg_market_notify_trigger(),public.tg_market_notify_region_reset(),public.tg_market_notify_eligible(bigint,uuid),public.tg_market_notifications(bigint,text,jsonb,boolean,text),public.tg_market_notify_worker(text,jsonb) from public,anon,authenticated;
grant execute on function public.tg_market_notifications(bigint,text,jsonb,boolean,text),public.tg_market_notify_worker(text,jsonb) to service_role;
