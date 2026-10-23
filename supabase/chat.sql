-- Waseet private and group chat
-- Run this entire file once in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('direct','group')),
  title text,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_members (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_conversation_created_idx
  on public.chat_messages (conversation_id, created_at desc);
create index if not exists chat_members_user_idx on public.chat_members(user_id);

alter table public.chat_conversations enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;

-- SECURITY DEFINER helper avoids recursive row-level-security checks on chat_members.
create or replace function public.is_chat_member(p_conversation_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.chat_members m
    where m.conversation_id = p_conversation_id and m.user_id = auth.uid()
  );
$$;
revoke all on function public.is_chat_member(uuid) from public;
grant execute on function public.is_chat_member(uuid) to authenticated;

drop policy if exists "chat conversations visible to members" on public.chat_conversations;
create policy "chat conversations visible to members"
on public.chat_conversations for select to authenticated
using (public.is_chat_member(chat_conversations.id));

drop policy if exists "chat members visible to conversation members" on public.chat_members;
create policy "chat members visible to conversation members"
on public.chat_members for select to authenticated
using (public.is_chat_member(chat_members.conversation_id));

drop policy if exists "users can update own chat read time" on public.chat_members;
create policy "users can update own chat read time"
on public.chat_members for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "chat messages visible to members" on public.chat_messages;
create policy "chat messages visible to members"
on public.chat_messages for select to authenticated
using (public.is_chat_member(chat_messages.conversation_id));

drop policy if exists "members can send chat messages" on public.chat_messages;
create policy "members can send chat messages"
on public.chat_messages for insert to authenticated
with check (
  sender_id = auth.uid()
  and public.is_chat_member(chat_messages.conversation_id)
);

create or replace function public.get_chat_people()
returns table (id uuid, full_name text, role text, username text)
language sql stable security definer
set search_path = public
as $$
  select p.id, p.full_name, p.role::text, p.username
  from public.profiles p
  where p.role = 'admin'
     or (p.role = 'rep' and p.status in ('approved','restricted'))
  order by case when p.role = 'admin' then 0 else 1 end, p.full_name;
$$;

create or replace function public.ensure_chat_ready()
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_role text;
  v_status text;
begin
  if v_uid is null then raise exception 'يجب تسجيل الدخول أولاً'; end if;

  select p.role::text, p.status::text into v_role, v_status
  from public.profiles p where p.id = v_uid;

  if v_role is null or (v_role = 'rep' and v_status not in ('approved','restricted')) then
    raise exception 'حسابك غير مخوّل لاستخدام الدردشة';
  end if;

  select c.id into v_group_id
  from public.chat_conversations c
  where c.kind = 'group' and c.title = 'مجموعة المندوبين'
  order by c.created_at asc limit 1;

  if v_group_id is null then
    insert into public.chat_conversations(kind,title,created_by)
    values ('group','مجموعة المندوبين',v_uid) returning id into v_group_id;
  end if;

  insert into public.chat_members(conversation_id,user_id)
  select v_group_id, p.id
  from public.profiles p
  where p.role = 'admin'
     or (p.role = 'rep' and p.status in ('approved','restricted'))
  on conflict (conversation_id,user_id) do nothing;

  return v_group_id;
end;
$$;

create or replace function public.create_direct_chat(p_recipient_id uuid)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_conversation_id uuid;
  v_role text;
  v_status text;
begin
  if v_uid is null then raise exception 'يجب تسجيل الدخول أولاً'; end if;
  if p_recipient_id is null or p_recipient_id = v_uid then
    raise exception 'اختر شخصاً آخر لبدء المحادثة';
  end if;

  perform public.ensure_chat_ready();

  select p.role::text, p.status::text into v_role, v_status
  from public.profiles p where p.id = p_recipient_id;

  if v_role is null or (v_role = 'rep' and v_status not in ('approved','restricted')) then
    raise exception 'هذا الحساب غير متاح للدردشة';
  end if;

  select c.id into v_conversation_id
  from public.chat_conversations c
  where c.kind = 'direct'
    and exists (select 1 from public.chat_members a where a.conversation_id=c.id and a.user_id=v_uid)
    and exists (select 1 from public.chat_members b where b.conversation_id=c.id and b.user_id=p_recipient_id)
    and (select count(*) from public.chat_members n where n.conversation_id=c.id) = 2
  order by c.created_at asc limit 1;

  if v_conversation_id is null then
    insert into public.chat_conversations(kind,title,created_by)
    values ('direct',null,v_uid) returning id into v_conversation_id;
    insert into public.chat_members(conversation_id,user_id)
    values (v_conversation_id,v_uid),(v_conversation_id,p_recipient_id)
    on conflict do nothing;
  end if;

  return v_conversation_id;
end;
$$;

revoke all on function public.get_chat_people() from public;
revoke all on function public.ensure_chat_ready() from public;
revoke all on function public.create_direct_chat(uuid) from public;
grant execute on function public.get_chat_people() to authenticated;
grant execute on function public.ensure_chat_ready() to authenticated;
grant execute on function public.create_direct_chat(uuid) to authenticated;

grant select on public.chat_conversations, public.chat_members, public.chat_messages to authenticated;
grant update (last_read_at) on public.chat_members to authenticated;
grant insert (conversation_id, sender_id, body) on public.chat_messages to authenticated;
