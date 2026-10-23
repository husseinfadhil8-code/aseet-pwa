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
