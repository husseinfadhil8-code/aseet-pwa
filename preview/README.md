# Waseet design preview — isolated from all hosted databases

Source: PR #8 commit 32b592107bf7804919b016df69de016506508346, which includes PR #7 at dc9aa78 and PR #6.

Public URL: https://husseinfadhil8-code.github.io/aseet-pwa/preview/

This is an explicitly labelled, in-memory design preview, not the production app or a real Auth login. Choose representative or administrator. All entries, messages, goods, approvals and sales are synthetic. Changes disappear on reload. Never enter real account credentials.

The copied app configuration is https://preview.invalid with an offline placeholder; preview-sdk.js refuses all other configurations and contains no network transport or persistence. CSP connect-src 'none' blocks all backend connections. No service worker is registered by this preview, and no SQL, migrations, Supabase CLI or production workflow is part of this publication. Outbound sharing, Push, real Auth, email recovery and Storage uploads are disabled. Root application files are unchanged.

Only this preview directory is added to main. The existing main-triggered importer workflow is path-limited to scripts/** and its own workflow file, neither of which this publication changes. PR #7 and PR #8 remain unmerged. The six migrations and their hosted state are untouched.

Demo photos downloaded from Unsplash, bundled locally to avoid external image requests:
- https://images.unsplash.com/photo-1567538096630-e0c55bd6374c
- https://images.unsplash.com/photo-1511707171634-5f897ff02aa9
- https://images.unsplash.com/photo-1496181133206-80ce9b88a853
- https://images.unsplash.com/photo-1586023492125-27b2c045efd7

source-manifest.json records source hashes before the explicit preview-only configuration/entry changes. Rebuild from a reviewed source commit rather than treating copied preview files as the canonical app source.
