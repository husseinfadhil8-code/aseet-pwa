-- Local review proposal. NOT a canonical migration and NOT approved for hosted use.
-- Keep migration 006 byte-for-byte unchanged; a new hosted migration needs review.
CREATE POLICY notifications_active_insert_boundary ON public.notifications AS RESTRICTIVE
 FOR INSERT TO authenticated WITH CHECK(public.rls_is_active_admin());
CREATE POLICY notifications_active_read_boundary ON public.notifications AS RESTRICTIVE
 FOR SELECT TO authenticated USING(public.rls_is_active_staff());
CREATE OR REPLACE FUNCTION public.mark_notification_read(p_notification_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT public.rls_is_active_staff() THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Active account required';
 END IF;
 UPDATE public.notifications SET read_at=now()
  WHERE id=p_notification_id AND recipient_id=auth.uid() AND read_at IS NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_notification_read(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.mark_notification_read(uuid) TO authenticated;
