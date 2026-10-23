-- Waseet: online/last-seen and opt-in location metadata for reps.
-- Run once in Supabase SQL Editor.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS online boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_latitude double precision,
  ADD COLUMN IF NOT EXISTS last_longitude double precision,
  ADD COLUMN IF NOT EXISTS location_accuracy double precision,
  ADD COLUMN IF NOT EXISTS location_updated_at timestamptz;

-- Validate stored coordinates and avoid accidental invalid map links.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_last_latitude_range,
  ADD CONSTRAINT profiles_last_latitude_range
    CHECK (last_latitude IS NULL OR last_latitude BETWEEN -90 AND 90),
  DROP CONSTRAINT IF EXISTS profiles_last_longitude_range,
  ADD CONSTRAINT profiles_last_longitude_range
    CHECK (last_longitude IS NULL OR last_longitude BETWEEN -180 AND 180);

-- The Edge Function uses the service_role key to write presence securely.
GRANT SELECT, UPDATE ON TABLE public.profiles TO service_role;
GRANT SELECT ON TABLE public.goods, public.sales TO service_role;
GRANT SELECT, DELETE ON TABLE public.push_subscriptions TO service_role;
