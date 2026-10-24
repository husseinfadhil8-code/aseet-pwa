-- REVIEW ONLY. Apply as a trusted BYPASSRLS database owner, never from the browser.
-- Compatible with PR #6 / atomic_sales.sql. No historical rows are rewritten.
BEGIN;
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                 WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'A trusted BYPASSRLS migration owner is required for non-recursive RLS helpers';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                 AND table_name='profiles' AND column_name='permissions' AND data_type='jsonb')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                 AND table_name='profiles' AND column_name='status') THEN
    RAISE EXCEPTION 'Review the real profiles schema: status and jsonb permissions are required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles)
     AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE role::text='admin' AND status::text='approved') THEN
    RAISE EXCEPTION 'Review administrator accounts first: no approved administrator exists';
  END IF;
END;
$preflight$;
LOCK TABLE public.profiles, public.goods IN SHARE ROW EXCLUSIVE MODE;

-- These helpers read only the caller's account, with no user-supplied ID or role.
-- BYPASSRLS ownership avoids policies recursively querying profiles through RLS.
CREATE OR REPLACE FUNCTION public.rls_is_active_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid()
                 AND p.role::text='admin' AND p.status::text='approved');
$$;
CREATE OR REPLACE FUNCTION public.rls_is_active_staff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid()
    AND ((p.role::text='admin' AND p.status::text='approved')
      OR (p.role::text='rep' AND p.status::text IN ('approved','restricted'))));
$$;
REVOKE ALL ON FUNCTION public.rls_is_active_admin(), public.rls_is_active_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_is_active_admin(), public.rls_is_active_staff() TO authenticated, anon;

-- Only the actual database session role can identify a trusted backend. Never
-- trust user metadata, JWT role text, app settings, or SECURITY DEFINER current_user.
CREATE OR REPLACE FUNCTION public.rls_is_trusted_backend()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname =
    CASE WHEN nullif(current_setting('role',true),'none') IS NULL
         THEN session_user::text ELSE current_setting('role',true) END
    AND (r.rolsuper OR r.rolbypassrls));
$$;
REVOKE ALL ON FUNCTION public.rls_is_trusted_backend() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rls_is_auth_signup_session()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN nullif(current_setting('role',true),'none') IS NULL
              THEN session_user::text ELSE current_setting('role',true) END = 'supabase_auth_admin';
$$;
REVOKE ALL ON FUNCTION public.rls_is_auth_signup_session() FROM PUBLIC, anon, authenticated;

-- RLS restricts rows, not which fields an otherwise valid UPDATE can change.
-- This trigger also protects against legacy SECURITY DEFINER profile writers
-- called by ordinary users: their session role remains authenticated.
CREATE OR REPLACE FUNCTION public.guard_profile_authority()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- GoTrue auth.users triggers may run without a user JWT. Preserve that path,
  -- but never accept authority copied from user-controlled signup metadata.
  IF TG_OP='INSERT' AND public.rls_is_auth_signup_session() THEN
    NEW.role := 'rep';
    NEW.status := 'pending';
    NEW.permissions := '{"can_add_inquiry":true}'::jsonb;
    RETURN NEW;
  END IF;
  IF public.rls_is_trusted_backend() OR public.rls_is_active_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF auth.uid() IS NULL OR NEW.id IS DISTINCT FROM auth.uid()
      OR NEW.role::text IS DISTINCT FROM 'rep'
      OR NEW.status::text IS DISTINCT FROM 'pending'
      OR NEW.permissions IS DISTINCT FROM '{"can_add_inquiry":true}'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='التسجيل مسموح كمندوب قيد المراجعة فقط.';
    END IF;
  ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.status IS DISTINCT FROM OLD.status OR NEW.permissions IS DISTINCT FROM OLD.permissions THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='تغيير الدور والحالة والصلاحيات متاح للمدير المفعّل فقط.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_profile_authority() FROM PUBLIC, anon, authenticated;
DO $helper_owners$
BEGIN
  -- CREATE OR REPLACE retains an existing function's owner. Fail rather than
  -- leaving an authorization helper under an untrusted pre-existing owner.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='public' AND p.proname IN (
      'rls_is_active_admin','rls_is_active_staff','rls_is_trusted_backend',
      'rls_is_auth_signup_session','guard_profile_authority')
      AND NOT (r.rolsuper OR r.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Review helper function owners: untrusted existing ownership detected';
  END IF;
END;
$helper_owners$;
DROP TRIGGER IF EXISTS a_guard_profile_authority ON public.profiles;
CREATE TRIGGER a_guard_profile_authority BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_authority();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Enable update for admin" ON public.profiles;
DROP POLICY IF EXISTS "Enable update for admin" ON public.goods;
DROP POLICY IF EXISTS "Allow insert goods for authenticated" ON public.goods;

-- Permissive policies provide the supported paths. Restrictive policies cap ALL
-- permissive policies, including unknown legacy USING(true)/WITH CHECK(true).
DROP POLICY IF EXISTS profiles_supported_select ON public.profiles;
CREATE POLICY profiles_supported_select ON public.profiles FOR SELECT TO authenticated
USING (id=auth.uid() OR public.rls_is_active_admin());
DROP POLICY IF EXISTS profiles_select_boundary ON public.profiles;
CREATE POLICY profiles_select_boundary ON public.profiles AS RESTRICTIVE FOR SELECT TO authenticated, anon
USING (id=auth.uid() OR public.rls_is_active_admin());

DROP POLICY IF EXISTS profiles_supported_insert ON public.profiles;
CREATE POLICY profiles_supported_insert ON public.profiles FOR INSERT TO authenticated WITH CHECK (
  public.rls_is_active_admin() OR (id=auth.uid() AND role::text='rep' AND status::text='pending'
    AND permissions='{"can_add_inquiry":true}'::jsonb));
DROP POLICY IF EXISTS profiles_insert_boundary ON public.profiles;
CREATE POLICY profiles_insert_boundary ON public.profiles AS RESTRICTIVE FOR INSERT TO authenticated, anon
WITH CHECK (public.rls_is_active_admin() OR (id=auth.uid() AND role::text='rep' AND status::text='pending'
  AND permissions='{"can_add_inquiry":true}'::jsonb));

DROP POLICY IF EXISTS profiles_supported_update ON public.profiles;
CREATE POLICY profiles_supported_update ON public.profiles FOR UPDATE TO authenticated
USING (id=auth.uid() OR public.rls_is_active_admin())
WITH CHECK (id=auth.uid() OR public.rls_is_active_admin());
DROP POLICY IF EXISTS profiles_update_boundary ON public.profiles;
CREATE POLICY profiles_update_boundary ON public.profiles AS RESTRICTIVE FOR UPDATE TO authenticated, anon
USING (id=auth.uid() OR public.rls_is_active_admin())
WITH CHECK (id=auth.uid() OR public.rls_is_active_admin());
DROP POLICY IF EXISTS profiles_delete_boundary ON public.profiles;
CREATE POLICY profiles_delete_boundary ON public.profiles AS RESTRICTIVE FOR DELETE TO authenticated, anon
USING (public.rls_is_active_admin());

DROP POLICY IF EXISTS goods_supported_access ON public.goods;
CREATE POLICY goods_supported_access ON public.goods FOR ALL TO authenticated
USING (public.rls_is_active_admin()) WITH CHECK (public.rls_is_active_admin());
DROP POLICY IF EXISTS goods_supported_read ON public.goods;
CREATE POLICY goods_supported_read ON public.goods FOR SELECT TO authenticated
USING (public.rls_is_active_staff());
DROP POLICY IF EXISTS goods_read_boundary ON public.goods;
CREATE POLICY goods_read_boundary ON public.goods AS RESTRICTIVE FOR SELECT TO authenticated, anon
USING (public.rls_is_active_staff());
DROP POLICY IF EXISTS goods_insert_boundary ON public.goods;
CREATE POLICY goods_insert_boundary ON public.goods AS RESTRICTIVE FOR INSERT TO authenticated, anon
WITH CHECK (public.rls_is_active_admin() AND created_by=auth.uid());
DROP POLICY IF EXISTS goods_update_boundary ON public.goods;
CREATE POLICY goods_update_boundary ON public.goods AS RESTRICTIVE FOR UPDATE TO authenticated, anon
USING (public.rls_is_active_admin()) WITH CHECK (public.rls_is_active_admin());
DROP POLICY IF EXISTS goods_delete_boundary ON public.goods;
CREATE POLICY goods_delete_boundary ON public.goods AS RESTRICTIVE FOR DELETE TO authenticated, anon
USING (public.rls_is_active_admin());

REVOKE ALL ON TABLE public.profiles, public.goods FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.goods TO authenticated;
-- No sales grants, policies or RPC signatures change here. In particular this
-- migration must not restore direct sales INSERT revoked by atomic_sales.sql.
NOTIFY pgrst, 'reload schema';
COMMIT;
