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
