-- Waseet shared team activity: notify all active representatives about commission payout updates.
-- Run this updated file in Supabase SQL Editor.

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('new_goods', 'app_update', 'system', 'sale'));

CREATE OR REPLACE FUNCTION public.notify_rep_after_commission_paid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE good_title text;
BEGIN
  IF OLD.commission_paid_at IS NULL AND NEW.commission_paid_at IS NOT NULL THEN
    SELECT title INTO good_title FROM public.goods WHERE id = NEW.goods_id;
    INSERT INTO public.notifications (recipient_id, created_by, title, body, category, metadata)
    SELECT p.id, NEW.commission_paid_by,
      CASE WHEN p.id = NEW.rep_id THEN '💰 تم إرسال مستحقاتك' ELSE '💰 تحديث تحويل عمولة' END,
      CASE WHEN p.id = NEW.rep_id THEN
        'تم تأكيد تحويل مستحقاتك عن بيع «' || coalesce(good_title, 'غرض') ||
        '» بمبلغ ' || to_char(coalesce(NEW.rep_share, 0), 'FM999G999G999G990') || ' د.ع.'
      ELSE
        'تم تحديث حالة تحويل مستحقات عن بيع «' || coalesce(good_title, 'غرض') ||
        '». افتح قسم نشاط الفريق لمتابعة العمليات.'
      END,
      'sale',
      jsonb_build_object('sale_id', NEW.id, 'goods_id', NEW.goods_id, 'rep_id', NEW.rep_id,
        'activity_type', 'commission_paid', 'commission_paid_at', NEW.commission_paid_at)
    FROM public.profiles p
    WHERE p.role::text = 'rep' AND p.status::text IN ('approved', 'restricted');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_rep_after_commission_paid_update ON public.sales;
CREATE TRIGGER notify_rep_after_commission_paid_update
AFTER UPDATE OF commission_paid_at ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.notify_rep_after_commission_paid();
