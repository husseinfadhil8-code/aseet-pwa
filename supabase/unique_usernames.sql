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
