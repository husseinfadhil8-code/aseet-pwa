-- Waseet shared team activity: fan out sale notifications to all active representatives.
-- Run this updated file in Supabase SQL Editor.

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('new_goods', 'app_update', 'system', 'sale'));

CREATE OR REPLACE FUNCTION public.notify_rep_after_sale()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE good_title text;
DECLARE rep_name text;
DECLARE actor_name text;
BEGIN
  SELECT title INTO good_title FROM public.goods WHERE id = NEW.goods_id;
  SELECT full_name INTO rep_name FROM public.profiles WHERE id = NEW.rep_id;
  SELECT full_name INTO actor_name FROM public.profiles WHERE id = NEW.verified_by;
  INSERT INTO public.notifications (recipient_id, created_by, title, body, category, metadata)
  SELECT p.id, NEW.verified_by,
    CASE WHEN p.id = NEW.rep_id THEN 'تم تسجيل عملية بيع' ELSE '🛍️ بيع جديد في وسيط' END,
    CASE WHEN p.id = NEW.rep_id THEN
      'تم تسجيل بيع «' || coalesce(good_title, 'غرض') || '». حصتك من العمولة: ' ||
      to_char(coalesce(NEW.rep_share, 0), 'FM999G999G999G990') || ' د.ع'
    ELSE
      'المندوب ' || coalesce(rep_name, 'غير معروف') || ' باع «' || coalesce(good_title, 'غرض') ||
      '». سجّل العملية المستخدم ' || coalesce(actor_name, 'غير معروف') || '. افتح قسم نشاط الفريق لمتابعة العمليات.'
    END,
    'sale',
    jsonb_build_object('sale_id', NEW.id, 'goods_id', NEW.goods_id, 'rep_id', NEW.rep_id, 'activity_type', 'sale', 'rep_name', rep_name,
      'actor_name', coalesce(nullif(btrim(actor_name), ''), 'الإدارة'))
  FROM public.profiles p
  WHERE p.role::text = 'rep' AND p.status::text IN ('approved', 'restricted');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_rep_after_sale_insert ON public.sales;
CREATE TRIGGER notify_rep_after_sale_insert AFTER INSERT ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.notify_rep_after_sale();
