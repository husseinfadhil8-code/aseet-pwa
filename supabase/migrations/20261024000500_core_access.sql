-- Explicit local/fresh-install access; platform default grants are not assumed.
GRANT SELECT, INSERT ON public.notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inquiries TO authenticated;

CREATE POLICY inquiries_active_admin ON public.inquiries FOR ALL TO authenticated
USING (public.rls_is_active_admin()) WITH CHECK (public.rls_is_active_admin());
CREATE POLICY inquiries_rep_read ON public.inquiries FOR SELECT TO authenticated
USING (rep_id=auth.uid() AND public.rls_is_active_staff());
CREATE POLICY inquiries_rep_insert ON public.inquiries FOR INSERT TO authenticated
WITH CHECK (rep_id=auth.uid() AND public.rls_is_active_staff()
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid()
    AND p.permissions->'can_add_inquiry' IS DISTINCT FROM 'false'::jsonb));

-- Cap legacy OR-combined sales SELECT policies that forgot to check account status.
CREATE POLICY sales_active_reader_boundary ON public.sales AS RESTRICTIVE FOR SELECT TO authenticated
USING (public.rls_is_active_admin() OR
       (rep_id=auth.uid() AND public.rls_is_active_staff()));
