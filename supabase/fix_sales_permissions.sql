-- Waseet: repair sales table permissions safely
-- Run this file in Supabase SQL Editor as project owner.
-- Sales can be created by admins only; reps can read only their own sales.

ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON TABLE public.sales TO authenticated;

DROP POLICY IF EXISTS "waseet_admin_read_sales" ON public.sales;
CREATE POLICY "waseet_admin_read_sales"
ON public.sales
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.role::text = 'admin'
  )
);

DROP POLICY IF EXISTS "waseet_rep_read_own_sales" ON public.sales;
CREATE POLICY "waseet_rep_read_own_sales"
ON public.sales
FOR SELECT
TO authenticated
USING (
  rep_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.role::text = 'rep'
  )
);

DROP POLICY IF EXISTS "waseet_admin_insert_sales" ON public.sales;
CREATE POLICY "waseet_admin_insert_sales"
ON public.sales
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.role::text = 'admin'
  )
  AND EXISTS (
    SELECT 1
    FROM public.profiles rep
    WHERE rep.id = sales.rep_id
      AND rep.role::text = 'rep'
      AND rep.status::text IN ('approved', 'restricted')
  )
);

-- Intentionally do not grant UPDATE/DELETE on sales to client users.
