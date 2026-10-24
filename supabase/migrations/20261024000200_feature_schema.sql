-- Frozen snapshot of repository feature SQL for FRESH databases.
-- Root supabase/*.sql files are historical references; migrations are canonical.


-- Source snapshot: unique_usernames.sql
-- Waseet: unique representative usernames
-- Run this migration in Supabase SQL Editor before deploying/testing signup.
-- Existing representatives receive stable generated usernames if they do not have one.

do $check$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles does not exist. No changes made.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='profiles' and column_name='id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='profiles' and column_name='role'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='profiles' and column_name='full_name'
  ) then
    raise exception 'Expected profiles.id, profiles.role, or profiles.full_name is missing. No changes made.';
  end if;
end;
$check$;

alter table public.profiles add column if not exists username text;

-- Preserve every existing account; create a stable unique handle for reps that lack one.
update public.profiles
set username = 'rep_' || left(replace(id::text, '-', ''), 16)
where role::text = 'rep'
  and (username is null or btrim(username) = '');

-- Usernames are compared case-insensitively and without surrounding whitespace.
create unique index if not exists profiles_username_unique_idx
  on public.profiles (lower(btrim(username)))
  where username is not null and btrim(username) <> '';

create or replace function public.is_username_available(p_username text)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_username text := lower(btrim(coalesce(p_username, '')));
begin
  if v_username !~ '^[a-z0-9._]{3,24}$' then
    return false;
  end if;

  return not exists (
    select 1 from public.profiles p
    where lower(btrim(p.username)) = v_username
  );
end;
$function$;

revoke all on function public.is_username_available(text) from public;
grant execute on function public.is_username_available(text) to anon, authenticated;


-- Source snapshot: lock_usernames.sql
-- Waseet: lock usernames permanently after the representative chooses them.
-- Run this migration in Supabase SQL Editor after unique_usernames.sql.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username_locked BOOLEAN NOT NULL DEFAULT TRUE;

-- Existing generated handles can be replaced once by their owner.
UPDATE public.profiles
SET username_locked = FALSE
WHERE role::TEXT = 'rep'
  AND username ~ '^rep_[0-9a-f]{16}$';

CREATE OR REPLACE FUNCTION public.prevent_username_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF NEW.username IS DISTINCT FROM OLD.username THEN
    IF COALESCE(OLD.username_locked, TRUE) THEN
      RAISE EXCEPTION 'اسم المستخدم ثابت ولا يمكن تغييره';
    END IF;

    IF OLD.role::TEXT <> 'rep' OR NEW.role::TEXT <> 'rep' THEN
      RAISE EXCEPTION 'تغيير اسم المستخدم مسموح للمندوب القديم مرة واحدة فقط';
    END IF;

    IF NEW.username IS NULL OR LOWER(BTRIM(NEW.username)) !~ '^[a-z0-9._]{3,24}$' THEN
      RAISE EXCEPTION 'صيغة اسم المستخدم غير صحيحة';
    END IF;

    NEW.username := LOWER(BTRIM(NEW.username));
    NEW.username_locked := TRUE;
  ELSIF OLD.username_locked IS TRUE AND NEW.username_locked IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'لا يمكن إلغاء تثبيت اسم المستخدم';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS profiles_prevent_username_change ON public.profiles;
CREATE TRIGGER profiles_prevent_username_change
BEFORE UPDATE OF username, username_locked ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.prevent_username_change();

CREATE OR REPLACE FUNCTION public.set_my_username_once(p_username TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_username TEXT := LOWER(BTRIM(COALESCE(p_username, '')));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'يجب تسجيل الدخول أولاً';
  END IF;

  IF v_username !~ '^[a-z0-9._]{3,24}$' THEN
    RAISE EXCEPTION 'صيغة اسم المستخدم غير صحيحة';
  END IF;

  UPDATE public.profiles
  SET username = v_username,
      username_locked = TRUE
  WHERE id = auth.uid()
    AND role::TEXT = 'rep'
    AND username_locked = FALSE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'لا يمكن تغيير اسم المستخدم: قد يكون محفوظاً مسبقاً';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_my_username_once(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_my_username_once(TEXT) TO authenticated;


-- Source snapshot: profile_and_name_requests.sql
-- Waseet: profile photos and manager-approved display-name changes
-- Run in Supabase SQL Editor after the previous username migrations.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

CREATE TABLE IF NOT EXISTS public.name_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  requested_name TEXT NOT NULL CHECK (char_length(btrim(requested_name)) BETWEEN 2 AND 80),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES public.profiles(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_name_change_per_rep
ON public.name_change_requests(rep_id) WHERE status = 'pending';
ALTER TABLE public.name_change_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.name_change_requests FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_my_avatar_url(p_avatar_url TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول أولاً'; END IF;
  IF p_avatar_url IS NULL OR p_avatar_url !~ '^https://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'رابط الصورة غير صحيح';
  END IF;
  UPDATE public.profiles SET avatar_url = p_avatar_url WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'لم يتم العثور على ملف الحساب'; END IF;
END;
$function$;

-- Block representatives from directly editing their own display name.
CREATE OR REPLACE FUNCTION public.prevent_rep_self_name_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NEW.full_name IS DISTINCT FROM OLD.full_name
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles admin_profile
       WHERE admin_profile.id = auth.uid()
         AND admin_profile.role::text = 'admin'
     ) THEN
    RAISE EXCEPTION 'لا يمكن تغيير الاسم مباشرة؛ أرسل طلباً إلى المدير';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS profiles_prevent_rep_self_name_change ON public.profiles;
CREATE TRIGGER profiles_prevent_rep_self_name_change
BEFORE UPDATE OF full_name ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.prevent_rep_self_name_change();

CREATE OR REPLACE FUNCTION public.request_my_name_change(p_requested_name TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_name TEXT := btrim(coalesce(p_requested_name, ''));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول أولاً'; END IF;
  IF char_length(v_name) < 2 OR char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'الاسم المطلوب يجب أن يكون من حرفين إلى 80 حرفاً';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'rep') THEN
    RAISE EXCEPTION 'هذه الميزة للمندوبين فقط';
  END IF;
  IF EXISTS (SELECT 1 FROM public.name_change_requests WHERE rep_id = auth.uid() AND status = 'pending') THEN
    RAISE EXCEPTION 'لديك طلب تغيير اسم قيد المراجعة بالفعل';
  END IF;
  INSERT INTO public.name_change_requests(rep_id, requested_name) VALUES (auth.uid(), v_name);
END;
$function$;

CREATE OR REPLACE FUNCTION public.has_pending_name_change_request()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.name_change_requests
    WHERE rep_id = auth.uid() AND status = 'pending'
  );
$function$;

CREATE OR REPLACE FUNCTION public.get_name_change_requests()
RETURNS TABLE (id UUID, rep_id UUID, current_name TEXT, username TEXT, requested_name TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'admin') THEN
    RAISE EXCEPTION 'هذه القائمة متاحة للمدير فقط';
  END IF;
  RETURN QUERY
  SELECT n.id, n.rep_id, p.full_name, p.username, n.requested_name, n.created_at
  FROM public.name_change_requests n JOIN public.profiles p ON p.id = n.rep_id
  WHERE n.status = 'pending' ORDER BY n.created_at ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.review_name_change_request(p_request_id UUID, p_approve BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_request public.name_change_requests%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'admin') THEN
    RAISE EXCEPTION 'هذه العملية متاحة للمدير فقط';
  END IF;
  SELECT * INTO v_request FROM public.name_change_requests
  WHERE id = p_request_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الطلب غير موجود أو تمت مراجعته سابقاً'; END IF;
  IF p_approve THEN
    UPDATE public.profiles SET full_name = v_request.requested_name WHERE id = v_request.rep_id;
  END IF;
  UPDATE public.name_change_requests
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      reviewed_at = now(), reviewed_by = auth.uid()
  WHERE id = p_request_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_my_avatar_url(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_my_name_change(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_name_change_requests() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_pending_name_change_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_name_change_request(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_my_avatar_url(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_my_name_change(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_name_change_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_pending_name_change_request() TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_name_change_request(UUID, BOOLEAN) TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('profile-avatars', 'profile-avatars', true, 8388608, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 8388608,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

DROP POLICY IF EXISTS "Public can view profile avatars" ON storage.objects;
CREATE POLICY "Public can view profile avatars" ON storage.objects FOR SELECT
USING (bucket_id = 'profile-avatars');
DROP POLICY IF EXISTS "Users upload own profile avatar" ON storage.objects;
CREATE POLICY "Users upload own profile avatar" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'profile-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "Users update own profile avatar" ON storage.objects;
CREATE POLICY "Users update own profile avatar" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'profile-avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'profile-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);


-- Source snapshot: setup-push-notifications.sql
-- وسيط: تخزين اشتراكات إشعارات الويب بأمان
-- راجع هذا الملف وشغّله مرة واحدة في Supabase SQL Editor.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

drop policy if exists "Users can read their own push subscriptions" on public.push_subscriptions;
create policy "Users can read their own push subscriptions"
  on public.push_subscriptions for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own push subscriptions" on public.push_subscriptions;
create policy "Users can create their own push subscriptions"
  on public.push_subscriptions for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own push subscriptions" on public.push_subscriptions;
create policy "Users can update their own push subscriptions"
  on public.push_subscriptions for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own push subscriptions" on public.push_subscriptions;
create policy "Users can delete their own push subscriptions"
  on public.push_subscriptions for delete
  to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Source snapshot: external-listings.sql
-- وسيط: الإعلانات الخارجية واستلامها داخلياً
-- هذا الملف يضيف جداول فقط؛ لا يغيّر جدول goods الحالي.
-- راجع السياسات ثم شغّل الملف يدوياً في Supabase SQL Editor.

create table if not exists public.external_listings (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 2 and 180),
  description text,
  asking_price bigint check (asking_price is null or asking_price >= 0),
  area text,
  source_url text check (source_url is null or source_url ~* '^https?://'),
  image_url text check (image_url is null or image_url ~* '^https?://'),
  source_name text not null default 'Facebook',
  status text not null default 'pending'
    check (status in ('pending', 'active', 'sold', 'removed', 'hidden')),
  created_by uuid references auth.users(id) on delete set null,
  submitter_name text,
  submitter_contact text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists external_listings_status_created_idx
  on public.external_listings (status, created_at desc);

create table if not exists public.external_listing_claims (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.external_listings(id) on delete cascade,
  rep_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (listing_id),
  unique (listing_id, rep_id)
);

create index if not exists external_listing_claims_rep_idx
  on public.external_listing_claims (rep_id, created_at desc);

alter table public.external_listings enable row level security;
alter table public.external_listing_claims enable row level security;

-- إزالة السياسات السابقة بالاسم نفسه يجعل إعادة تشغيل الملف آمنة.
drop policy if exists "external listings visible to signed in users" on public.external_listings;
create policy "external listings visible to signed in users"
  on public.external_listings for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "admins manage external listings" on public.external_listings;
create policy "admins manage external listings"
  on public.external_listings for all to authenticated
  using (
    exists (select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists "reps view own claims and admins view all" on public.external_listing_claims;
create policy "reps view own claims and admins view all"
  on public.external_listing_claims for select to authenticated
  using (
    rep_id = auth.uid()
    or exists (select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists "approved reps claim active listings" on public.external_listing_claims;
-- Compatibility: some existing Waseet schemas have profiles.status and others do not.
do $policy_setup$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'status'
  ) then
    execute $policy$
      create policy "approved reps claim active listings"
      on public.external_listing_claims for insert to authenticated
      with check (
        rep_id = auth.uid()
        and exists (
          select 1 from public.profiles p
          where p.id = auth.uid()
            and p.role = 'rep'
            and coalesce(p.status::text, 'approved') = 'approved'
        )
        and exists (
          select 1 from public.external_listings l
          where l.id = listing_id and l.status = 'active'
        )
      )
    $policy$;
  else
    execute $policy$
      create policy "approved reps claim active listings"
      on public.external_listing_claims for insert to authenticated
      with check (
        rep_id = auth.uid()
        and exists (
          select 1 from public.profiles p
          where p.id = auth.uid() and p.role = 'rep'
        )
        and exists (
          select 1 from public.external_listings l
          where l.id = listing_id and l.status = 'active'
        )
      )
    $policy$;
  end if;
end
$policy_setup$;

drop policy if exists "admins manage external listing claims" on public.external_listing_claims;
create policy "admins manage external listing claims"
  on public.external_listing_claims for all to authenticated
  using (
    exists (select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin')
  );

comment on table public.external_listings is
  'إعلانات مصدرها خارجي. لا تُنسخ إليها بيانات اتصال شخصية إلا بموافقة ومسوغ واضح.';
comment on table public.external_listing_claims is
  'استلام الإعلان داخلي للمندوبين؛ لا تعرض هذه البيانات للمشترين.';


-- Public submissions require review; contact details are admin-only.
alter table public.external_listings add column if not exists submitter_name text, add column if not exists submitter_contact text;
alter table public.external_listings alter column source_url drop not null;
alter table public.external_listings alter column status set default 'pending';
alter table public.external_listings drop constraint if exists external_listings_status_check;
alter table public.external_listings add constraint external_listings_status_check check (status in ('pending', 'active', 'sold', 'removed', 'hidden'));

drop policy if exists "external listings visible to signed in users" on public.external_listings;
create policy "external listings visible to signed in users" on public.external_listings for select to authenticated
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "admins manage external listings" on public.external_listings;
create policy "admins manage external listings" on public.external_listings for all to authenticated
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "public can submit pending listings" on public.external_listings;
create policy "public can submit pending listings" on public.external_listings for insert to anon, authenticated
with check (status = 'pending'
  and char_length(trim(title)) between 2 and 180
  and char_length(trim(coalesce(submitter_name, ''))) between 2 and 100
  and char_length(trim(coalesce(submitter_contact, ''))) between 5 and 40
  and created_by is null);

comment on table public.external_listings is 'إعلانات الجمهور تبقى pending حتى يوافق المدير؛ بيانات التواصل خاصة بالإدارة.';

-- Ensure anonymous visitors can submit, while RLS limits them to pending rows.
grant insert on table public.external_listings to anon, authenticated;
grant select, update on table public.external_listings to authenticated;


-- أغراض الجمهور: تصل مباشرة إلى المندوبين بعد الإرسال، مع صور وسعر قابل للتفاوض.
alter table public.external_listings
  add column if not exists negotiable boolean,
  add column if not exists image_urls text[] not null default '{}';

-- مخزن صور الإعلانات العامة (الصور فقط، بحد أقصى 8 ميغابايت للصورة).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-images', 'listing-images', true, 8388608, array['image/jpeg','image/png','image/webp','image/gif','image/heic'])
on conflict (id) do update set
  public = true,
  file_size_limit = 8388608,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif','image/heic'];

drop policy if exists "public can upload listing images" on storage.objects;
create policy "public can upload listing images"
on storage.objects for insert to anon, authenticated
with check (bucket_id = 'listing-images');

drop policy if exists "listing images are publicly readable" on storage.objects;
create policy "listing images are publicly readable"
on storage.objects for select to anon, authenticated
using (bucket_id = 'listing-images');

-- يسمح للزائر بإرسال إعلان نشط بعد إدخال بيانات التواصل والسعر والصور.
drop policy if exists "public can submit pending listings" on public.external_listings;
drop policy if exists "public can submit owner listings" on public.external_listings;
create policy "public can submit owner listings"
on public.external_listings for insert to anon, authenticated
with check (
  status = 'pending'
  and char_length(trim(title)) between 2 and 180
  and char_length(trim(coalesce(submitter_name, ''))) between 2 and 100
  and char_length(trim(coalesce(submitter_contact, ''))) between 7 and 40
  and asking_price > 0
  and negotiable is not null
  and coalesce(array_length(image_urls, 1), 0) between 1 and 5
  and created_by is null
);

grant insert on table public.external_listings to anon, authenticated;
grant select, update on table public.external_listings to authenticated;


-- قصر مشاهدة إعلانات أصحاب الأغراض على الإدارة والمندوبين، وليس أي حساب مسجل عادي.
drop policy if exists "external listings visible to signed in users" on public.external_listings;
create policy "external listings visible to signed in users"
on public.external_listings for select to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role in ('admin', 'rep')
  )
  and (status = 'active' or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ))
);


-- Final privacy hardening: customer-submitted item requests are visible to the admin only.
drop policy if exists "external listings visible to signed in users" on public.external_listings;
create policy "external listings visible to signed in users"
on public.external_listings for select to authenticated
using (exists (
  select 1 from public.profiles p
  where p.id = auth.uid() and p.role = 'admin'
));

drop policy if exists "public can submit owner listings" on public.external_listings;
create policy "public can submit owner listings"
on public.external_listings for insert to anon, authenticated
with check (
  status = 'pending'
  and char_length(trim(title)) between 2 and 180
  and char_length(trim(coalesce(submitter_name, ''))) between 2 and 100
  and char_length(trim(coalesce(submitter_contact, ''))) between 7 and 40
  and asking_price > 0
  and negotiable is not null
  and coalesce(array_length(image_urls, 1), 0) between 1 and 5
  and created_by is null
);

-- إصلاح صلاحيات المدير عند إغلاق/رفض طلب صاحب الغرض.
-- شغّل هذا الملف في Supabase SQL Editor بعد رفع التعديل.
grant usage on schema public to authenticated;
grant select, insert, update on table public.external_listings to authenticated;

drop policy if exists "admins manage external listings" on public.external_listings;
create policy "admins manage external listings"
on public.external_listings
for all
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
);


-- Source snapshot: notifications.sql
-- Waseet in-app notifications
-- Run once in Supabase SQL Editor.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  title text not null,
  body text not null default '',
  category text not null default 'system'
    check (category in ('new_goods', 'app_update', 'system')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists notifications_recipient_created_idx
  on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_recipient_unread_idx
  on public.notifications (recipient_id, read_at)
  where read_at is null;

alter table public.notifications enable row level security;

drop policy if exists "Users read their own notifications" on public.notifications;
create policy "Users read their own notifications"
  on public.notifications for select to authenticated
  using (recipient_id = auth.uid());

drop policy if exists "Admins create notifications" on public.notifications;
create policy "Admins create notifications"
  on public.notifications for insert to authenticated
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

create or replace function public.mark_notification_read(p_notification_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notifications
  set read_at = now()
  where id = p_notification_id
    and recipient_id = auth.uid()
    and read_at is null;
$$;

revoke all on function public.mark_notification_read(uuid) from public;
grant execute on function public.mark_notification_read(uuid) to authenticated;

create or replace function public.notify_reps_about_new_good()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications
    (recipient_id, created_by, title, body, category, metadata)
  select
    p.id,
    new.created_by,
    'تمت إضافة غرض جديد',
    'أُضيف الغرض «' || coalesce(new.title, 'غرض جديد') || '» بسعر ' ||
      to_char(coalesce(new.asking_price, 0), 'FM999G999G999G990') || ' د.ع' ||
      case when coalesce(new.area, '') <> '' then ' — المنطقة: ' || new.area else '' end,
    'new_goods',
    jsonb_build_object(
      'goods_id', new.id,
      'goods_title', new.title,
      'asking_price', new.asking_price,
      'area', new.area
    )
  from public.profiles p
  where p.role = 'rep'
    and p.status in ('approved', 'restricted');

  return new;
end;
$$;

drop trigger if exists notify_reps_after_good_insert on public.goods;
create trigger notify_reps_after_good_insert
  after insert on public.goods
  for each row execute function public.notify_reps_about_new_good();


-- Source snapshot: fix_sales_permissions.sql
-- Waseet: repair sales table permissions safely
-- Run this file in Supabase SQL Editor as project owner.
-- Sales can be created by admins only; reps can read only their own sales.

ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON TABLE public.sales TO authenticated;

DROP POLICY IF EXISTS "waseet_admin_read_sales" ON public.sales;
CREATE POLICY "waseet_admin_read_sales"
ON public.sales
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.role::text = 'admin'
  )
);

DROP POLICY IF EXISTS "waseet_rep_read_own_sales" ON public.sales;
CREATE POLICY "waseet_rep_read_own_sales"
ON public.sales
FOR SELECT
TO authenticated
USING (
  rep_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.role::text = 'rep'
  )
);

DROP POLICY IF EXISTS "waseet_admin_insert_sales" ON public.sales;
CREATE POLICY "waseet_admin_insert_sales"
ON public.sales
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.role::text = 'admin'
  )
  AND EXISTS (
    SELECT 1
    FROM public.profiles rep
    WHERE rep.id = sales.rep_id
      AND rep.role::text = 'rep'
      AND rep.status::text IN ('approved', 'restricted')
  )
);

-- Intentionally do not grant UPDATE/DELETE on sales to client users.


-- Source snapshot: rep_commissions_access.sql
-- Waseet: allow each representative to read only their own sales for the personal commissions screen.
-- This policy does not grant representatives permission to insert, update, or confirm payouts.
do $policy_check$
begin
  if to_regclass('public.sales') is null or to_regclass('public.profiles') is null then
    raise exception 'Required public.sales or public.profiles table is missing. No policy was added.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sales' and column_name = 'rep_id'
  ) then
    raise exception 'public.sales.rep_id is missing. No policy was added.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name in ('role', 'status')
    group by table_schema, table_name
    having count(distinct column_name) = 2
  ) then
    raise exception 'public.profiles.role or public.profiles.status is missing. No policy was added.';
  end if;
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'sales'
      and c.relrowsecurity = true
  ) then
    raise exception 'Row Level Security is not enabled on public.sales. Inspect existing policies before enabling it; no policy was added.';
  end if;
end;
$policy_check$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'sales'
      and policyname = 'Representatives can read own sales'
  ) then
    create policy "Representatives can read own sales"
      on public.sales
      for select
      to authenticated
      using (
        rep_id = (select auth.uid())
        and exists (
          select 1 from public.profiles p
          where p.id = (select auth.uid())
            and p.role::text = 'rep'
            and p.status::text in ('approved', 'restricted')
        )
      );
  end if;
end;
$policy$;


-- Source snapshot: commission_payouts.sql
-- Waseet: commission payout tracking
-- Review the existing sales/profile schema before adding payout fields.
-- Run in Supabase SQL Editor. This migration stops safely if required columns differ.

do $migration_check$
declare
  missing_columns text;
  sale_id_type text;
begin
  if to_regclass('public.sales') is null then
    raise exception 'Migration stopped: public.sales table does not exist. Inspect the live schema before proceeding.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'Migration stopped: public.profiles table does not exist. Inspect the live schema before proceeding.';
  end if;

  select string_agg(required.column_name, ', ')
    into missing_columns
  from (values
    ('id'), ('goods_id'), ('rep_id'), ('final_price'),
    ('total_commission'), ('manager_share'), ('rep_share'), ('created_at')
  ) as required(column_name)
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'sales'
      and c.column_name = required.column_name
  );

  if missing_columns is not null then
    raise exception 'Migration stopped: public.sales is missing expected columns: %. Inspect the current schema first.', missing_columns;
  end if;

  select c.data_type into sale_id_type
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'sales' and c.column_name = 'id';

  if sale_id_type <> 'uuid' then
    raise exception 'Migration stopped: public.sales.id is %, but this migration expects uuid. Inspect the schema first.', sale_id_type;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'role'
  ) then
    raise exception 'Migration stopped: public.profiles.role is missing; cannot safely authorize administrators.';
  end if;
end;
$migration_check$;

alter table public.sales
  add column if not exists commission_paid_at timestamptz,
  add column if not exists commission_paid_by uuid references auth.users(id) on delete set null;

create index if not exists sales_commission_due_idx
  on public.sales (commission_paid_at, created_at desc);

create or replace function public.mark_sale_commission_paid(p_sale_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $function$
declare
  v_paid_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role::text = 'admin'
  ) then
    raise exception 'Only an administrator can confirm commission payouts.';
  end if;

  update public.sales
     set commission_paid_at = now(),
         commission_paid_by = auth.uid()
   where id = p_sale_id
     and commission_paid_at is null
   returning id into v_paid_id;

  if v_paid_id is null then
    raise exception 'Commission already paid or sale not found.';
  end if;
end;
$function$;

revoke all on function public.mark_sale_commission_paid(uuid) from public;
grant execute on function public.mark_sale_commission_paid(uuid) to authenticated;


-- Source snapshot: sale_notifications.sql
-- Waseet shared team activity: fan out sale notifications to all active representatives.
-- Run this updated file in Supabase SQL Editor.

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('new_goods', 'app_update', 'system', 'sale'));

CREATE OR REPLACE FUNCTION public.notify_rep_after_sale()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE good_title text;
DECLARE rep_name text;
DECLARE actor_name text;
BEGIN
  SELECT title INTO good_title FROM public.goods WHERE id = NEW.goods_id;
  INSERT INTO public.notifications (recipient_id, created_by, title, body, category, metadata)
  SELECT p.id, NEW.verified_by,
    CASE WHEN p.id = NEW.rep_id THEN 'تم تسجيل عملية بيع' ELSE '🛍️ بيع جديد في وسيط' END,
    CASE WHEN p.id = NEW.rep_id THEN
      'تم تسجيل بيع «' || coalesce(good_title, 'غرض') || '». حصتك من العمولة: ' ||
      to_char(coalesce(NEW.rep_share, 0), 'FM999G999G999G990') || ' د.ع'
    ELSE
      'المندوب ' || coalesce(rep_name, 'غير معروف') || ' باع «' || coalesce(good_title, 'غرض') ||
      '». سجّل العملية المستخدم ' || coalesce(actor_name, 'غير معروف') || '. افتح قسم نشاط الفريق لمتابعة العمليات.'
    END,
    'sale',
    jsonb_build_object('sale_id', NEW.id, 'goods_id', NEW.goods_id, 'rep_id', NEW.rep_id, 'activity_type', 'sale')
  FROM public.profiles p
  WHERE p.role::text = 'rep' AND p.status::text IN ('approved', 'restricted');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_rep_after_sale_insert ON public.sales;
CREATE TRIGGER notify_rep_after_sale_insert AFTER INSERT ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.notify_rep_after_sale();


-- Source snapshot: commission_payout_notifications.sql
-- Waseet shared team activity: notify all active representatives about commission payout updates.
-- Run this updated file in Supabase SQL Editor.

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('new_goods', 'app_update', 'system', 'sale'));

CREATE OR REPLACE FUNCTION public.notify_rep_after_commission_paid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE good_title text;
DECLARE rep_name text;
DECLARE actor_name text;
BEGIN
  IF OLD.commission_paid_at IS NULL AND NEW.commission_paid_at IS NOT NULL THEN
    SELECT title INTO good_title FROM public.goods WHERE id = NEW.goods_id;
    INSERT INTO public.notifications (recipient_id, created_by, title, body, category, metadata)
    SELECT p.id, NEW.commission_paid_by,
      CASE WHEN p.id = NEW.rep_id THEN '💰 تم إرسال مستحقاتك' ELSE '💰 تحديث تحويل عمولة' END,
      CASE WHEN p.id = NEW.rep_id THEN
        'تم تأكيد تحويل مستحقاتك عن بيع «' || coalesce(good_title, 'غرض') ||
        '» بمبلغ ' || to_char(coalesce(NEW.rep_share, 0), 'FM999G999G999G990') || ' د.ع.'
      ELSE
        'تم تأكيد تحويل مستحقات المندوب ' || coalesce(rep_name, 'غير معروف') || ' عن بيع «' || coalesce(good_title, 'غرض') ||
        '». نفّذ العملية المستخدم ' || coalesce(actor_name, 'غير معروف') || '. افتح قسم نشاط الفريق لمتابعة العمليات.'
      END,
      'sale',
      jsonb_build_object('sale_id', NEW.id, 'goods_id', NEW.goods_id, 'rep_id', NEW.rep_id,
        'activity_type', 'commission_paid', 'commission_paid_at', NEW.commission_paid_at)
    FROM public.profiles p
    WHERE p.role::text = 'rep' AND p.status::text IN ('approved', 'restricted');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_rep_after_commission_paid_update ON public.sales;
CREATE TRIGGER notify_rep_after_commission_paid_update
AFTER UPDATE OF commission_paid_at ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.notify_rep_after_commission_paid();


-- Source snapshot: rep-presence-location.sql
-- Waseet: online/last-seen and opt-in location metadata for reps.
-- Run once in Supabase SQL Editor.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS online boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_latitude double precision,
  ADD COLUMN IF NOT EXISTS last_longitude double precision,
  ADD COLUMN IF NOT EXISTS location_accuracy double precision,
  ADD COLUMN IF NOT EXISTS location_updated_at timestamptz;

-- Validate stored coordinates and avoid accidental invalid map links.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_last_latitude_range,
  ADD CONSTRAINT profiles_last_latitude_range
    CHECK (last_latitude IS NULL OR last_latitude BETWEEN -90 AND 90),
  DROP CONSTRAINT IF EXISTS profiles_last_longitude_range,
  ADD CONSTRAINT profiles_last_longitude_range
    CHECK (last_longitude IS NULL OR last_longitude BETWEEN -180 AND 180);

-- The Edge Function uses the service_role key to write presence securely.
GRANT SELECT, UPDATE ON TABLE public.profiles TO service_role;
GRANT SELECT ON TABLE public.goods, public.sales TO service_role;
GRANT SELECT, DELETE ON TABLE public.push_subscriptions TO service_role;


-- Source snapshot: admin_delete_records.sql
-- وسيط: إصلاح صلاحيات المدير لإغلاق/رفض طلبات أصحاب الأغراض وحذف الطلبات وسجلات المبيعات.
-- شغّل هذا الملف مرة واحدة في Supabase SQL Editor بحساب مالك المشروع.
-- ملاحظة: الحذف نهائي، والواجهة تطلب تأكيداً قبل تنفيذه.

grant usage on schema public to authenticated;

-- طلبات أصحاب الأغراض: صلاحيات الجدول + سياسات المدير.
grant select, insert, update, delete on table public.external_listings to authenticated;

drop policy if exists "admins manage external listings" on public.external_listings;
create policy "admins manage external listings"
on public.external_listings
for all
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role::text = 'admin'
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role::text = 'admin'
  )
);

-- سياسة حذف مستقلة لتوضيح السماح بالحذف للمدير فقط.
drop policy if exists "admins delete external listings" on public.external_listings;
create policy "admins delete external listings"
on public.external_listings
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role::text = 'admin'
  )
);

-- حذف سجل البيع والعمولة المرتبطة به متاح للمدير فقط.
alter table public.sales enable row level security;
grant delete on table public.sales to authenticated;

drop policy if exists "waseet_admin_delete_sales" on public.sales;
create policy "waseet_admin_delete_sales"
on public.sales
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role::text = 'admin'
  )
);


-- Source snapshot: chat.sql
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

-- Drop first because PostgreSQL cannot change a function's return columns with CREATE OR REPLACE.
drop function if exists public.get_chat_people();

create function public.get_chat_people()
returns table (id uuid, full_name text, role text, username text, avatar_url text)
language sql stable security definer
set search_path = public
as $$
  select p.id, p.full_name, p.role::text, p.username, p.avatar_url
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
