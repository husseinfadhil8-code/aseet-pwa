-- Additive category expansion only; no rows, ownership, RLS or grants are changed.
ALTER TABLE public.tg_market_listings DROP CONSTRAINT tg_market_listings_category_check;
ALTER TABLE public.tg_market_listings ADD CONSTRAINT tg_market_listings_category_check CHECK(category IN ('أثاث','سيارات','عقارات','إلكترونيات','أجهزة منزلية','ملابس','أخرى','خدمات'));
ALTER TABLE public.tg_market_listings DROP CONSTRAINT tg_market_listings_condition_check;
ALTER TABLE public.tg_market_listings ADD CONSTRAINT tg_market_listings_condition_check CHECK(condition IN ('new','used','service') AND ((category='خدمات')=(condition='service')));
ALTER TABLE public.tg_market_wanted DROP CONSTRAINT tg_market_wanted_category_check;
ALTER TABLE public.tg_market_wanted ADD CONSTRAINT tg_market_wanted_category_check CHECK(category IN ('أثاث','سيارات','عقارات','إلكترونيات','أجهزة منزلية','ملابس','أخرى','خدمات'));
ALTER TABLE public.tg_market_radars DROP CONSTRAINT tg_market_radars_category_check;
ALTER TABLE public.tg_market_radars ADD CONSTRAINT tg_market_radars_category_check CHECK(category IN ('أثاث','سيارات','عقارات','إلكترونيات','أجهزة منزلية','ملابس','أخرى','خدمات'));
DO $services$ DECLARE d text;BEGIN
 SELECT pg_get_functiondef('public.tg_market_notifications(bigint,text,jsonb,boolean,text)'::regprocedure) INTO d;
 IF position('cardinality(cats)>7' in d)=0 THEN RAISE EXCEPTION 'notification category guard differs';END IF;
 d:=replace(d,'cardinality(cats)>7','cardinality(cats)>8');
 d:=replace(d,'''ملابس'',''أخرى'']','''ملابس'',''أخرى'',''خدمات'']');
 EXECUTE d;
END $services$;
