-- Waseet: lock usernames permanently after the representative chooses them.
-- Run this migration in Supabase SQL Editor after unique_usernames.sql.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username_locked BOOLEAN NOT NULL DEFAULT TRUE;

-- Existing generated handles can be replaced once by their owner.
UPDATE public.profiles
SET username_locked = FALSE
WHERE role::TEXT = 'rep'
  AND username ~ '^rep_[0-9a-f]{16}$';

CREATE OR REPLACE FUNCTION public.prevent_username_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF NEW.username IS DISTINCT FROM OLD.username THEN
    IF COALESCE(OLD.username_locked, TRUE) THEN
      RAISE EXCEPTION 'اسم المستخدم ثابت ولا يمكن تغييره';
    END IF;

    IF OLD.role::TEXT <> 'rep' OR NEW.role::TEXT <> 'rep' THEN
      RAISE EXCEPTION 'تغيير اسم المستخدم مسموح للمندوب القديم مرة واحدة فقط';
    END IF;

    IF NEW.username IS NULL OR LOWER(BTRIM(NEW.username)) !~ '^[a-z0-9._]{3,24}$' THEN
      RAISE EXCEPTION 'صيغة اسم المستخدم غير صحيحة';
    END IF;

    NEW.username := LOWER(BTRIM(NEW.username));
    NEW.username_locked := TRUE;
  ELSIF OLD.username_locked IS TRUE AND NEW.username_locked IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'لا يمكن إلغاء تثبيت اسم المستخدم';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS profiles_prevent_username_change ON public.profiles;
CREATE TRIGGER profiles_prevent_username_change
BEFORE UPDATE OF username, username_locked ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.prevent_username_change();

CREATE OR REPLACE FUNCTION public.set_my_username_once(p_username TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_username TEXT := LOWER(BTRIM(COALESCE(p_username, '')));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'يجب تسجيل الدخول أولاً';
  END IF;

  IF v_username !~ '^[a-z0-9._]{3,24}$' THEN
    RAISE EXCEPTION 'صيغة اسم المستخدم غير صحيحة';
  END IF;

  UPDATE public.profiles
  SET username = v_username,
      username_locked = TRUE
  WHERE id = auth.uid()
    AND role::TEXT = 'rep'
    AND username_locked = FALSE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'لا يمكن تغيير اسم المستخدم: قد يكون محفوظاً مسبقاً';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_my_username_once(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_my_username_once(TEXT) TO authenticated;
