-- Separate proposal requiring reviewed 004/005/006 and matching roles.
-- Not automatically planned/applied. No historical conversation deletion.
-- Review all write clients and verified backup/restoration before application.
REVOKE INSERT,DELETE ON public.chat_conversations,public.chat_members FROM PUBLIC,anon,authenticated;
REVOKE INSERT(id,kind,title,created_by,created_at) ON public.chat_conversations FROM PUBLIC,anon,authenticated;
REVOKE INSERT(conversation_id,user_id,joined_at,last_read_at) ON public.chat_members FROM PUBLIC,anon,authenticated;

create or replace function public.ensure_chat_ready()
returns uuid
language plpgsql security definer
set search_path = ''
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

  if v_role is null or not ((v_role = 'admin' and v_status = 'approved') or (v_role = 'rep' and v_status in ('approved','restricted'))) then
    raise exception 'حسابك غير مخوّل لاستخدام الدردشة';
  end if;

  select c.id into v_group_id
  from public.chat_conversations c
  where c.kind = 'group' and c.title = 'مجموعة المندوبين'
  order by c.created_at asc limit 1;

  if v_group_id is null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waseet:representative-group',0));
    select c.id into v_group_id from public.chat_conversations c
      where c.kind='group' and c.title='مجموعة المندوبين' order by c.created_at,c.id limit 1;
  end if;
  if v_group_id is null then
    insert into public.chat_conversations(kind,title,created_by)
    values ('group','مجموعة المندوبين',v_uid) returning id into v_group_id;
  end if;

  insert into public.chat_members(conversation_id,user_id)
  select v_group_id, p.id
  from public.profiles p
  where (p.role = 'admin' and p.status='approved')
     or (p.role = 'rep' and p.status in ('approved','restricted'))
  on conflict (conversation_id,user_id) do nothing;

  return v_group_id;
end;
$$;

create or replace function public.create_direct_chat(p_recipient_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
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

  if v_role is null or not ((v_role = 'admin' and v_status = 'approved') or (v_role = 'rep' and v_status in ('approved','restricted'))) then
    raise exception 'هذا الحساب غير متاح للدردشة';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'waseet:direct:' || least(v_uid,p_recipient_id)::text || ':' || greatest(v_uid,p_recipient_id)::text,0));

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

REVOKE ALL ON FUNCTION public.get_chat_people(),public.ensure_chat_ready(),public.create_direct_chat(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_chat_people(),public.ensure_chat_ready(),public.create_direct_chat(uuid) TO authenticated;
