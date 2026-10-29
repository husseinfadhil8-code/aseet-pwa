-- Additive migration. Apply only after live catalog review, verified encrypted backup,
-- target-owner approval, and Worker capability deployment. No historical backfill.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
create table public.notification_outbox (
 id uuid primary key default gen_random_uuid(),
 event_type text not null, source_table text not null, record_id text not null,
 occurred_at timestamptz not null default clock_timestamp(),
 payload jsonb not null,
 status text not null default 'pending' check(status in ('pending','processing','queued','retry','sent','review')),
 attempts integer not null default 0, delivery_attempts integer not null default 0,
 last_error text, next_attempt_at timestamptz not null default now(),
 lease_token uuid, lease_until timestamptz, queued_at timestamptz, sent_at timestamptz,
 telegram_message_ids jsonb not null default '[]'::jsonb
);
alter table public.notification_outbox enable row level security;
alter table public.notification_outbox force row level security;
revoke all on public.notification_outbox from public, anon, authenticated, service_role;
create index notification_outbox_due on public.notification_outbox(next_attempt_at,occurred_at,id) where status in ('pending','retry','processing');
create index notification_outbox_reconcile on public.notification_outbox(queued_at,id) where status in ('queued','review');
create index notification_outbox_subject on public.notification_outbox(source_table,record_id,occurred_at);
create function public.capture_notification_outbox() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare before_row jsonb; after_row jsonb; allowed text[]; a jsonb; b jsonb;
begin
 allowed := string_to_array(TG_ARGV[0],',');
 before_row := case when TG_OP='INSERT' then null else to_jsonb(OLD) end;
 after_row := case when TG_OP='DELETE' then null else to_jsonb(NEW) end;
 -- Persist an explicit allowlist, never contact/payment/identity fields or chat content.
 select jsonb_object_agg(key,value) into a from jsonb_each(before_row) where key=any(allowed);
 select jsonb_object_agg(key,value) into b from jsonb_each(after_row) where key=any(allowed);
 if TG_OP='UPDATE' and a is not distinct from b then return NEW; end if;
 insert into public.notification_outbox(event_type,source_table,record_id,payload)
 values(lower(TG_OP),TG_TABLE_NAME,coalesce(after_row->>'id',before_row->>'id',after_row->>'singleton',before_row->>'singleton'),jsonb_build_object('old',a,'row',b,'origin',coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-waseet-origin','database')));
 return case when TG_OP='DELETE' then OLD else NEW end;
end $$;
revoke all on function public.capture_notification_outbox() from public,anon,authenticated,service_role;
-- Fail closed if any expected table/column differs from the reviewed catalog.
do $$
declare spec record; col text;
begin
 for spec in select * from (values
 ('users','id,telegram_id,display_name,role,banned,created_at'),
 ('listings','id,owner_id,title,price,images,status,approved_at,created_at,description'),
 ('rep_applications','id,user_id,status,reason,created_at'),
 ('publications','id,listing_id,state,message_id,created_at'),
 ('wanted','id,owner_id,title,status,updated_at,created_at'),
 ('wanted_offers','id,request_id,seller_id,listing_id,created_at'),
 ('reports','id,user_id,listing_id,reason,status,created_at'),
 ('wanted_reports','id,user_id,request_id,reason,status,created_at'),
 ('support','id,user_id,body,created_at'),
 ('audit','id,actor,action,created_at'),
 ('settings','singleton,channel_verified,auto_publish,purchases_enabled,payments_verified'),
 ('intelligence_settings','singleton,channel_enabled,tips_enabled,assistant_enabled,knowledge_approved,version'),
 ('packages','id,enabled,version'),
 ('payouts','id,sale_id,paid_by,created_at'),
 ('rep_goods','id,title,price,status,created_at')
 ) as t(source,columns) loop
 foreach col in array string_to_array(spec.columns,',') loop
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='tg_market_'||spec.source and column_name=col) then
 raise exception 'notification outbox catalog mismatch: %.%',spec.source,col;
 end if;
 end loop;
 execute format('create trigger notification_outbox_capture after insert or update or delete on public.%I for each row execute function public.capture_notification_outbox(%L)','tg_market_'||spec.source,spec.columns);
 end loop;
end $$;
create function public.notification_outbox_claim(p_limit integer default 20) returns setof public.notification_outbox
language sql security definer set search_path=pg_catalog,public as $$
 with due as (select id from public.notification_outbox where
 ((status in ('pending','retry') and next_attempt_at<=now()) or (status='processing' and lease_until<now()))
 order by occurred_at,id for update skip locked limit greatest(1,least(p_limit,50)))
 update public.notification_outbox o set status='processing',attempts=attempts+1,
 lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',last_error=null
 from due where o.id=due.id returning o.*
$$;
create function public.notification_outbox_bridge_ack(p_id uuid,p_token uuid,p_error text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.notification_outbox set status=case when p_error is null then 'queued' else 'retry' end,
 queued_at=case when p_error is null then now() else queued_at end,
 next_attempt_at=now()+make_interval(secs=>least(3600,15*power(2,least(attempts,8)))::int),
 last_error=case when p_error is null then null else 'outbox_bridge_failed' end,lease_until=null
 where id=p_id and lease_token=p_token and status='processing';
 return found;
end $$;
create function public.notification_outbox_queued(p_limit integer default 50) returns setof public.notification_outbox
language sql security definer set search_path=pg_catalog,public as $$
 select * from public.notification_outbox where status in ('queued','review') order by queued_at,id limit greatest(1,least(p_limit,100))
$$;
create function public.notification_outbox_delivery(p_id uuid,p_status text,p_attempts integer,p_message_ids jsonb,p_error text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_status not in ('queued','sent','review') or p_attempts<0 or jsonb_typeof(p_message_ids)!='array' or (p_status='sent' and jsonb_array_length(p_message_ids)=0) then raise exception 'invalid outbox delivery'; end if;
 update public.notification_outbox set status=p_status,delivery_attempts=p_attempts,
 telegram_message_ids=p_message_ids,last_error=left(p_error,80),
 sent_at=case when p_status='sent' then now() else null end,
 queued_at=case when p_status='sent' then queued_at else now() end
 where id=p_id and status in ('queued','review');return found;
end $$;
revoke all on function public.notification_outbox_claim(integer),public.notification_outbox_bridge_ack(uuid,uuid,text),public.notification_outbox_queued(integer),public.notification_outbox_delivery(uuid,text,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.notification_outbox_claim(integer),public.notification_outbox_bridge_ack(uuid,uuid,text),public.notification_outbox_queued(integer),public.notification_outbox_delivery(uuid,text,integer,jsonb,text) to service_role;
create function public.notification_outbox_health() returns jsonb
language sql security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('stalled',count(*) filter(where status!='sent' and occurred_at<now()-interval '15 minutes'),
 'repeated_failures',count(*) filter(where status!='sent' and (attempts>=5 or delivery_attempts>=5)),
 'review',count(*) filter(where status='review')) from public.notification_outbox
$$;
revoke all on function public.notification_outbox_health() from public,anon,authenticated;
grant execute on function public.notification_outbox_health() to service_role;
commit;
