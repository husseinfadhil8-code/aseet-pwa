-- Waseet: create an in-app notification for the selected representative after a sale is saved.
-- Run once in Supabase SQL Editor as project owner.

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_category_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('new_goods', 'app_update', 'system', 'sale'));

CREATE OR REPLACE FUNCTION public.notify_rep_after_sale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  good_title text;
BEGIN
  SELECT title INTO good_title
  FROM public.goods
  WHERE id = NEW.goods_id;

  INSERT INTO public.notifications
    (recipient_id, created_by, title, body, category, metadata)
  SELECT
    p.id,
    NEW.verified_by,
    'تم تسجيل عملية بيع',
    'تم تسجيل بيع «' || coalesce(good_title, 'غرض') ||
      '». حصتك من العمولة: ' ||
      to_char(coalesce(NEW.rep_share, 0), 'FM999G999G999G990') || ' د.ع',
    'sale',
    jsonb_build_object(
      'sale_id', NEW.id,
      'goods_id', NEW.goods_id,
      'rep_id', NEW.rep_id,
      'rep_share', NEW.rep_share
    )
  FROM public.profiles p
  WHERE p.id = NEW.rep_id
    AND p.role::text = 'rep'
    AND p.status::text IN ('approved', 'restricted');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_rep_after_sale_insert ON public.sales;

CREATE TRIGGER notify_rep_after_sale_insert
  AFTER INSERT ON public.sales
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_rep_after_sale();
