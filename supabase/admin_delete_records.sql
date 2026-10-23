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
