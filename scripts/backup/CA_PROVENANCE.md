# Public Supabase PostgreSQL trust anchor

supabase-prod-ca-2021.crt is a public CA certificate, not a private key or credential.
Downloaded over verified HTTPS from:
https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

The official Supabase Dashboard uses this URL template (env=prod):
https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json
https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/Settings/Database/SSLConfiguration.tsx

Supabase documents adding this CA for verify-full:
https://supabase.com/docs/guides/platform/ssl-enforcement

File SHA-256: 700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7
Certificate SHA-256 fingerprint: 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
Subject/issuer: Supabase Root 2021 CA, Supabase Inc.
Validity: 2021-04-28 to 2031-04-26.

The source adapter and pg_dump client use this pinned database-only CA. It is not
installed as a global runner/HTTP trust root. sslmode=verify-full and the pinned
Test host remain mandatory; a modified/missing CA fails before networking.
No observed peer certificate is automatically trusted. Rotation requires review.
