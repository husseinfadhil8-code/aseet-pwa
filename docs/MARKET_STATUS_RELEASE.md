# Market status accessibility — 2026-10-25-market-status-6

Empty searches now distinguish no available inventory from filters with no matches and suggest clearing filters. The result list exposes aria-busy during delayed searches and page requests, and returns to idle after success, failure or session reset. No data contracts, writes or database objects change.

One new browser case covers empty inventory, filtered empty results, clearing filters and busy/idle transitions. The local Chromium paging suite passed 19 tests. CI verifies the complete Chromium/WebKit release suite before merge; publication additionally requires Pages and official root/hash verification.
