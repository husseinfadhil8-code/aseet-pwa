-- Review locally first. NOT approved for hosted application yet.
-- RLS alone does not conceal columns on rows an approved representative can read.
REVOKE SELECT ON public.goods FROM PUBLIC,anon,authenticated;
REVOKE SELECT(owner_name,owner_phone) ON public.goods FROM PUBLIC,anon,authenticated;
GRANT SELECT(id,title,description,area,asking_price,agreed_commission,status,created_by,created_at)
 ON public.goods TO authenticated;

CREATE FUNCTION public.get_good_owner_contact(p_goods_id uuid)
RETURNS TABLE(owner_name text,owner_phone text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT public.rls_is_active_admin() THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Owner contacts require an active administrator';
 END IF;
 RETURN QUERY SELECT g.owner_name,g.owner_phone FROM public.goods g WHERE g.id=p_goods_id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_good_owner_contact(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_good_owner_contact(uuid) TO authenticated;

-- Existing memberships must stop granting access as soon as an account is banned.
CREATE OR REPLACE FUNCTION public.is_chat_member(p_conversation_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.rls_is_active_staff() AND EXISTS (
  SELECT 1 FROM public.chat_members m WHERE m.conversation_id=p_conversation_id AND m.user_id=auth.uid());
$$;
REVOKE ALL ON FUNCTION public.is_chat_member(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.is_chat_member(uuid) TO authenticated;

REVOKE UPDATE ON public.chat_members FROM PUBLIC,anon,authenticated;
REVOKE UPDATE(conversation_id,user_id,joined_at) ON public.chat_members FROM PUBLIC,anon,authenticated;
GRANT UPDATE(last_read_at) ON public.chat_members TO authenticated;
CREATE POLICY chat_members_active_update_boundary ON public.chat_members AS RESTRICTIVE
 FOR UPDATE TO authenticated USING(public.rls_is_active_staff()) WITH CHECK(public.rls_is_active_staff());

CREATE OR REPLACE FUNCTION public.get_chat_people()
RETURNS TABLE(id uuid,full_name text,role text,username text,avatar_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT p.id,p.full_name,p.role::text,p.username,p.avatar_url FROM public.profiles p
 WHERE public.rls_is_active_staff() AND ((p.role::text='admin' AND p.status='approved')
   OR (p.role::text='rep' AND p.status IN ('approved','restricted')))
 ORDER BY CASE WHEN p.role::text='admin' THEN 0 ELSE 1 END,p.full_name;
$$;
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
