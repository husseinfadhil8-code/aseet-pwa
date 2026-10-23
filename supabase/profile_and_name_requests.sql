-- Waseet: profile photos and manager-approved display-name changes
-- Run in Supabase SQL Editor after the previous username migrations.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

CREATE TABLE IF NOT EXISTS public.name_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  requested_name TEXT NOT NULL CHECK (char_length(btrim(requested_name)) BETWEEN 2 AND 80),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES public.profiles(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_name_change_per_rep
ON public.name_change_requests(rep_id) WHERE status = 'pending';
ALTER TABLE public.name_change_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.name_change_requests FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_my_avatar_url(p_avatar_url TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول أولاً'; END IF;
  IF p_avatar_url IS NULL OR p_avatar_url !~ '^https://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'رابط الصورة غير صحيح';
  END IF;
  UPDATE public.profiles SET avatar_url = p_avatar_url WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'لم يتم العثور على ملف الحساب'; END IF;
END;
$function$;

-- Block representatives from directly editing their own display name.
CREATE OR REPLACE FUNCTION public.prevent_rep_self_name_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NEW.full_name IS DISTINCT FROM OLD.full_name
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles admin_profile
       WHERE admin_profile.id = auth.uid()
         AND admin_profile.role::text = 'admin'
     ) THEN
    RAISE EXCEPTION 'لا يمكن تغيير الاسم مباشرة؛ أرسل طلباً إلى المدير';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS profiles_prevent_rep_self_name_change ON public.profiles;
CREATE TRIGGER profiles_prevent_rep_self_name_change
BEFORE UPDATE OF full_name ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.prevent_rep_self_name_change();

CREATE OR REPLACE FUNCTION public.request_my_name_change(p_requested_name TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_name TEXT := btrim(coalesce(p_requested_name, ''));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول أولاً'; END IF;
  IF char_length(v_name) < 2 OR char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'الاسم المطلوب يجب أن يكون من حرفين إلى 80 حرفاً';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'rep') THEN
    RAISE EXCEPTION 'هذه الميزة للمندوبين فقط';
  END IF;
  IF EXISTS (SELECT 1 FROM public.name_change_requests WHERE rep_id = auth.uid() AND status = 'pending') THEN
    RAISE EXCEPTION 'لديك طلب تغيير اسم قيد المراجعة بالفعل';
  END IF;
  INSERT INTO public.name_change_requests(rep_id, requested_name) VALUES (auth.uid(), v_name);
END;
$function$;

CREATE OR REPLACE FUNCTION public.has_pending_name_change_request()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.name_change_requests
    WHERE rep_id = auth.uid() AND status = 'pending'
  );
$function$;

CREATE OR REPLACE FUNCTION public.get_name_change_requests()
RETURNS TABLE (id UUID, rep_id UUID, current_name TEXT, username TEXT, requested_name TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'admin') THEN
    RAISE EXCEPTION 'هذه القائمة متاحة للمدير فقط';
  END IF;
  RETURN QUERY
  SELECT n.id, n.rep_id, p.full_name, p.username, n.requested_name, n.created_at
  FROM public.name_change_requests n JOIN public.profiles p ON p.id = n.rep_id
  WHERE n.status = 'pending' ORDER BY n.created_at ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.review_name_change_request(p_request_id UUID, p_approve BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_request public.name_change_requests%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'admin') THEN
    RAISE EXCEPTION 'هذه العملية متاحة للمدير فقط';
  END IF;
  SELECT * INTO v_request FROM public.name_change_requests
  WHERE id = p_request_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الطلب غير موجود أو تمت مراجعته سابقاً'; END IF;
  IF p_approve THEN
    UPDATE public.profiles SET full_name = v_request.requested_name WHERE id = v_request.rep_id;
  END IF;
  UPDATE public.name_change_requests
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      reviewed_at = now(), reviewed_by = auth.uid()
  WHERE id = p_request_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_my_avatar_url(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_my_name_change(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_name_change_requests() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_pending_name_change_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_name_change_request(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_my_avatar_url(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_my_name_change(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_name_change_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_pending_name_change_request() TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_name_change_request(UUID, BOOLEAN) TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('profile-avatars', 'profile-avatars', true, 8388608, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 8388608,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

DROP POLICY IF EXISTS "Public can view profile avatars" ON storage.objects;
CREATE POLICY "Public can view profile avatars" ON storage.objects FOR SELECT
USING (bucket_id = 'profile-avatars');
DROP POLICY IF EXISTS "Users upload own profile avatar" ON storage.objects;
CREATE POLICY "Users upload own profile avatar" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'profile-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "Users update own profile avatar" ON storage.objects;
CREATE POLICY "Users update own profile avatar" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'profile-avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'profile-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
