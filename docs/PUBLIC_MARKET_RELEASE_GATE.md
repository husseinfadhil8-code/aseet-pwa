# Public market release gate — PR #50

**Status: BLOCKED. Do not merge or publish from this document alone.**

This checklist is intentionally distinct from the existing public-market phase-1 implementation notes.

## 1. Verify the exact candidate
- Record the current PR #50 HEAD SHA and target main SHA.
- Require a **completed successful** frontend compatibility run for the exact HEAD (not an earlier commit), including Chromium and WebKit.
- Require successful browser regression tests for original staff goods, sales, commissions, chat, login and reports.
- Never interpret no CI result as passing.

## 2. Waseet-Test isolated rollout (not production)
- Confirm project identity and inspect existing schema/policies first.
- Apply the three public-market SQL files to **Waseet-Test only** in dependency order, after reviewing for conflicts.
- Test with real JWTs for: anonymous visitor, market seller, another market buyer, approved rep, approved admin, blocked rep.
- Test RLS via REST directly, not only by hiding staff UI:
  1. Anonymous users can read active public listings but not hidden listings, private messages or staff resources.
  2. Market seller can edit only their listings; cannot change seller_id, unhide moderated ads or delete moderated ads.
  3. Another market account cannot edit/delete someone else's listings or storage objects.
  4. Only buyer and seller can read/send messages in their own thread; a third user must be denied.
  5. Market accounts **must not** access legacy goods, sales, commissions, profiles administration or staff chat via REST.
  6. A rep cannot escalate itself to admin or access market moderation.
  7. Approved admin retains all original capabilities; staff login and routing still work.
- Test actual mobile signup, email confirmation, session restoration, image upload, chat, abuse reports and logout.
- Record evidence for each test; halt on an unexpected allow.

## 3. Production data safeguards
- Capture a dated and verified backup of the actual **production** Supabase project, including database and relevant Storage objects.
- Restore the backup to a separate disposable project, then verify counts and sample records for goods, sales, commissions, profiles, chats and storage objects.
- Never put test accounts/data or draft SQL into production during this step.
- Only after restore proof and explicit production configuration review, prepare an incremental migration and rollback plan.

## 4. Release and verification
- Merge PR #50 only after 1–3 are green and current HEAD has passed checks.
- Confirm GitHub Pages points to the expected main commit and that service worker caches update.
- Smoke-test production guest browsing, original admin and agent flows, publish/edit/photos/chat and notifications on iPhone.
- If any failure occurs, stop rollout; use the documented recovery procedure.

Release evidence template:
- Candidate SHA:
- CI run URL and conclusion:
- Waseet-Test project and migration log:
- RLS JWT test evidence:
- Production backup identifier/date:
- Separate restore test and observed integrity:
- Release approval:
- Main deployment SHA and smoke-test result:
