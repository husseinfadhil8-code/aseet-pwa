-- Additive user support replies. No modification/deletion of existing tickets.
create table public.tg_market_support_replies(
 id uuid primary key default gen_random_uuid(),
 ticket_id uuid not null references public.tg_market_support(id),
 user_id uuid not null references public.tg_market_users(id),
 author_id uuid not null references public.tg_market_users(id),
 body text not null check(length(trim(body)) between 1 and 1800),
 request_key uuid not null unique,
 created_at timestamptz not null default now()
);
create index tg_market_support_replies_ticket on public.tg_market_support_replies(ticket_id,created_at,id);
alter table public.tg_market_support_replies enable row level security;
alter table public.tg_market_support_replies force row level security;
revoke all on public.tg_market_support_replies from public,anon,authenticated,service_role;
create trigger notification_outbox_capture after insert on public.tg_market_support_replies for each row execute function public.capture_notification_outbox('id,ticket_id,user_id,author_id,body,created_at');
create function public.tg_market_support_action(p_actor bigint,p_operation text,p_data jsonb default '{}',p_admin boolean default false,p_name text default 'مستخدم') returns jsonb
language plpgsql security definer set search_path='' as $$
declare u public.tg_market_users;t public.tg_market_support;r public.tg_market_support_replies;root boolean;request uuid;answer text;
begin
 select * into u from public.tg_market_users where telegram_id=p_actor;
 if p_operation='create' then
  perform public.tg_market_action(p_actor,'support',jsonb_build_object('body',p_data->>'body'),p_admin,p_name);
  return jsonb_build_object('saved',true);
 end if;
 if u.id is null then return jsonb_build_object('tickets','[]'::jsonb);end if;
 root:=coalesce(p_admin,false) and u.role='admin' and not u.banned and exists(select 1 from public.tg_market_root where user_id=u.id);
 if p_operation='inbox' or (p_operation='admin' and root) then
  return jsonb_build_object('tickets',coalesce((
   select jsonb_agg(to_jsonb(q)||jsonb_build_object('replies',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'body',x.body,'created_at',x.created_at) order by x.created_at,x.id) from public.tg_market_support_replies x where x.ticket_id=q.id),'[]'::jsonb)))
   from(select s.id,s.user_id,s.body,s.created_at from public.tg_market_support s
     where (p_operation='admin' or s.user_id=u.id)
     order by s.created_at desc,s.id limit 50 offset least(10000,greatest(0,coalesce((p_data->>'offset')::int,0))))q
  ),'[]'::jsonb));
 end if;
 if p_operation='reply' then
  if not root then raise exception 'owner required';end if;
  if p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'explicit reply confirmation required';end if;
  request:=(p_data->>'request')::uuid;answer:=trim(p_data->>'body');
  if request is null or answer is null or length(answer) not between 1 and 1800 then raise exception 'invalid support reply';end if;
  select * into t from public.tg_market_support where id=(p_data->>'ticket')::uuid;
  if t.id is null then raise exception 'support ticket unavailable';end if;
  insert into public.tg_market_support_replies(ticket_id,user_id,author_id,body,request_key)
   values(t.id,t.user_id,u.id,answer,request) on conflict(request_key) do nothing returning * into r;
  if r.id is null then
   select * into r from public.tg_market_support_replies where request_key=request;
   if r.ticket_id<>t.id or r.author_id<>u.id or r.body<>answer then raise exception 'support reply request conflict';end if;
  end if;
  return jsonb_build_object('saved',true,'reply_id',r.id);
 end if;
 if p_operation='admin' then raise exception 'owner required';end if;
 raise exception 'unknown support operation';
end$$;
revoke all on function public.tg_market_support_action(bigint,text,jsonb,boolean,text) from public,anon,authenticated;
grant execute on function public.tg_market_support_action(bigint,text,jsonb,boolean,text) to service_role;
