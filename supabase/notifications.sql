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
