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
