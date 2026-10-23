-- وسيط: صلاحيات حذف الطلبات وسجلات المبيعات للمدير فقط
-- شغّل هذا الملف مرة واحدة في Supabase SQL Editor بحساب مالك المشروع.
-- الحذف نهائي، ويجب تأكيده من واجهة المدير قبل التنفيذ.

grant usage on schema public to authenticated;

-- حذف طلبات أصحاب الأغراض: سياسة المدير الحالية موجودة في external-listings.sql.
grant delete on table public.external_listings to authenticated;
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

-- سجل البيع يحتوي سعر البيع وتقسيم العمولة وحالة دفعها.
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
