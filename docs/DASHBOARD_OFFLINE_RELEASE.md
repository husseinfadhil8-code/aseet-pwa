# Dashboard offline assets

Release `2026-10-25-dashboard-offline-9` preserves the welcome dashboard and compact notification bell already merged in #32–#34. It adds the dashboard script, styles and public illustration to the explicit static-only service-worker cache, with a new cache and asset revision. Private data and API responses remain outside the cache.

The existing worker regression now checks offline fallback for all three new dashboard assets as well as app.js, and continues to reject private/API URLs. No database changes or migrations. Offline browsing does not imply live listings or messages are available.
