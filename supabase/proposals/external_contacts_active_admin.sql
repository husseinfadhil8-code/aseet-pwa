-- Separate reviewed proposal, NOT a canonical migration or hosted apply target.
-- The historical external_listings policies check role but not active status.
-- A restrictive boundary also caps unexpected permissive SELECT policies.
DROP POLICY IF EXISTS external_contacts_active_read ON public.external_listings;
CREATE POLICY external_contacts_active_read ON public.external_listings AS RESTRICTIVE
  FOR SELECT TO PUBLIC USING (public.rls_is_active_admin());
DROP POLICY IF EXISTS external_contacts_active_update ON public.external_listings;
CREATE POLICY external_contacts_active_update ON public.external_listings AS RESTRICTIVE
  FOR UPDATE TO PUBLIC USING (public.rls_is_active_admin())
  WITH CHECK (public.rls_is_active_admin());
DROP POLICY IF EXISTS external_contacts_active_delete ON public.external_listings;
CREATE POLICY external_contacts_active_delete ON public.external_listings AS RESTRICTIVE
  FOR DELETE TO PUBLIC USING (public.rls_is_active_admin());
-- Public pending submissions retain their existing INSERT policies; they cannot
-- read the submitted contacts back. No rows or existing canonical files change.
