-- REVIEW ONLY: do not run against a hosted project without schema/policy review.
-- Apply last, after fix_sales_permissions.sql and existing sales/notification migrations.
-- Run as the trusted database owner. This entire migration is transactional.
BEGIN;

DO $preflight$
DECLARE requirement record;
BEGIN
  FOR requirement IN
    SELECT * FROM (VALUES
      ('profiles','id','uuid'), ('profiles','role',NULL), ('profiles','status',NULL),
      ('goods','id','uuid'), ('goods','status',NULL),
      ('sales','id','uuid'), ('sales','goods_id','uuid'), ('sales','rep_id','uuid'),
      ('sales','final_price','bigint'), ('sales','total_commission','bigint'),
      ('sales','manager_share','bigint'), ('sales','rep_share','bigint'),
      ('sales','verified_by','uuid'), ('sales','verified_at','timestamp with time zone')
    ) AS expected(table_name, column_name, data_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = requirement.table_name
        AND c.column_name = requirement.column_name
        AND (requirement.data_type IS NULL OR c.data_type = requirement.data_type)
    ) THEN
      RAISE EXCEPTION 'Schema review required: public.%.% missing or has an unexpected type (%)',
        requirement.table_name, requirement.column_name, requirement.data_type;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sales' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Schema review required: public.sales must already have RLS enabled';
  END IF;
END;
$preflight$;

-- Block writers while historical goods are registered and the guards are installed.
LOCK TABLE public.sales IN SHARE ROW EXCLUSIVE MODE;

-- A separate registry preserves ALL historical sale rows, including any duplicates.
-- A deleted sale does not make a previously sold good eligible for another sale.
CREATE TABLE IF NOT EXISTS public.sale_goods_registry (
  goods_id uuid PRIMARY KEY REFERENCES public.goods(id) ON DELETE CASCADE
);
ALTER TABLE public.sale_goods_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sale_goods_registry FROM PUBLIC, anon, authenticated, service_role;
INSERT INTO public.sale_goods_registry (goods_id)
SELECT DISTINCT goods_id FROM public.sales
ON CONFLICT (goods_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.guard_sale_goods_registry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $guard$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.goods_id IS DISTINCT FROM OLD.goods_id THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'لا يمكن تغيير الغرض المرتبط بسجل بيع.';
    END IF;
    RETURN NEW;
  END IF;
  -- The primary key is the final concurrency guard, even for privileged direct inserts.
  INSERT INTO public.sale_goods_registry (goods_id) VALUES (NEW.goods_id)
  ON CONFLICT (goods_id) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'سبق تسجيل بيع لهذا الغرض.';
  END IF;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION public.guard_sale_goods_registry() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_sale_goods_registry ON public.sales;
CREATE TRIGGER guard_sale_goods_registry
BEFORE INSERT OR UPDATE OF goods_id ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.guard_sale_goods_registry();

CREATE OR REPLACE FUNCTION public.record_sale(
  p_goods_id uuid, p_rep_id uuid, p_final_price numeric,
  p_total_commission numeric, p_rep_share numeric
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $sale$
DECLARE
  v_actor uuid := auth.uid();
  v_status text;
  v_sale_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'يجب تسجيل الدخول أولاً.';
  END IF;
  -- SHARE also blocks concurrent role/status changes until the sale commits.
  -- A consistent order avoids locking the two profiles in opposite orders.
  PERFORM p.id FROM public.profiles p
  WHERE p.id IN (v_actor, p_rep_id) ORDER BY p.id FOR SHARE;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = v_actor AND p.role::text = 'admin' AND p.status::text = 'approved'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'تسجيل البيع متاح للمدير المفعّل فقط.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_rep_id AND p.role::text = 'rep'
      AND p.status::text IN ('approved', 'restricted')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'اختر مندوباً نشطاً مسجلاً في النظام.';
  END IF;
  -- Integral IQD amounts only, within JavaScript's exact integer range.
  -- Bounds reject NaN/Infinity as well as negative/overflowing inputs.
  IF p_final_price IS NULL OR p_total_commission IS NULL OR p_rep_share IS NULL
    OR NOT (p_final_price BETWEEN 1 AND 9007199254740991)
    OR NOT (p_total_commission BETWEEN 0 AND 9007199254740991)
    OR NOT (p_rep_share BETWEEN 0 AND p_total_commission)
    OR p_final_price <> trunc(p_final_price)
    OR p_total_commission <> trunc(p_total_commission)
    OR p_rep_share <> trunc(p_rep_share)
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'أدخل أسعاراً وعمولات صحيحة؛ حصة المندوب بين صفر وإجمالي العمولة.';
  END IF;

  -- A competing transaction waits here, then sees 'sold' (or gets a serialization error).
  SELECT g.status::text INTO v_status FROM public.goods g
  WHERE g.id = p_goods_id FOR UPDATE;
  IF NOT FOUND OR v_status IS DISTINCT FROM 'available' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'الغرض غير متاح للبيع. حدّث القائمة.';
  END IF;

  INSERT INTO public.sales (
    goods_id, rep_id, final_price, total_commission, manager_share, rep_share,
    verified_by, verified_at
  ) VALUES (
    p_goods_id, p_rep_id, p_final_price::bigint, p_total_commission::bigint,
    (p_total_commission - p_rep_share)::bigint, p_rep_share::bigint,
    v_actor, transaction_timestamp()
  ) RETURNING id INTO v_sale_id;
  IF v_sale_id IS NULL THEN
    RAISE EXCEPTION 'لم يتم إنشاء سجل البيع؛ لم تتغير حالة الغرض.';
  END IF;

  UPDATE public.goods SET status = 'sold' WHERE id = p_goods_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الغرض غير موجود؛ لم يتم تسجيل البيع.';
  END IF;
  -- Exceptions from the insert, update, or existing notification triggers roll back
  -- the sale, registry entry, goods change and in-app notifications together.
  RETURN v_sale_id;
END;
$sale$;
REVOKE ALL ON FUNCTION public.record_sale(uuid, uuid, numeric, numeric, numeric)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_sale(uuid, uuid, numeric, numeric, numeric) TO authenticated;

-- RLS INSERT policies alone cannot force callers to use the atomic workflow.
-- Preserve SELECT/DELETE and payout RPC behavior, but close direct API inserts.
REVOKE INSERT ON TABLE public.sales FROM PUBLIC, anon, authenticated;
DO $column_grants$
DECLARE column_name text;
BEGIN
  FOR column_name IN
    SELECT a.attname FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.sales'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    EXECUTE format('REVOKE INSERT (%I) ON public.sales FROM PUBLIC, anon, authenticated', column_name);
  END LOOP;
END;
$column_grants$;

NOTIFY pgrst, 'reload schema';
COMMIT;
