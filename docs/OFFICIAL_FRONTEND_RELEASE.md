# Official frontend release

This release starts from main c4f26d3 and selectively ports compatible frontend work from PR #8 (396ba65), administrator identity/send guards from #11, conversation request ordering from #12, and importer transport hardening from #13. PR #7 and all database changes stay in their existing review branches. The published preview directory is retained unchanged.

Included: shared responsive RTL styling, accessible dialogs and viewport zoom, local product search/price filtering, safe product-card listeners, local pinned SDK, static-only service-worker caching, chat history pagination and message grouping, account/request race guards and the actual profile name for administrators. Existing navigation destinations, authentication/signup and sales storage contracts remain in use.

No canonical migrations, RLS proposals, new owner-contact RPC, atomic record_sale RPC, profile adoption, Auth provisioning or hosted restore is part of this release. Database upgrades and their dependent features remain gated on independent backup/restoration and live integration verification. Frontend hiding does not claim to fix database column permissions.

The importer workflow is explicitly paused. Its hardened source permissions are empty by default, and no feed or production database write is initiated by the frontend test workflow. Existing Edge Function deployment automation is unchanged and is not triggered by these paths.

Validation uses intercepted browser APIs and synthetic fixtures, including the legacy sales write flow, login UI, product rendering/search, chat, and role-gated navigation. These checks do not assert successful live account login, real sale creation, email or Push delivery. No private account credentials are collected.

Frontend rollback is a reviewed revert of this release's frontend commit, preserving the importer pause and existing preview. No database rollback is needed because this release changes no database objects or data. The preceding official source is main c4f26d3. Verify main SHA, GitHub Pages build status, root release.json and root asset hashes after publishing; /preview/ is not the release URL.
