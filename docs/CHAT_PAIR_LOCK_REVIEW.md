# Pending chat pair lock proposal

This branch preserves PR #8 at 396ba65. The six canonical migrations are unchanged; the proposal is outside planning/apply and is not a production release.

`supabase/proposals/direct_chat_pair_lock.sql` requires reviewed 004/005/006. It adds a transaction advisory lock derived from the ordered pair before direct-chat lookup/creation, and a rechecked lock for initial group creation only. Existing groups avoid the global creation lock. Table and column INSERT privileges, plus direct DELETE privileges on conversations/memberships, are revoked from browser roles so clients cannot bypass the guarded RPC. Last-read column updates and message operations remain intact. Active administration is required; banned administrators are not added to a newly bootstrapped group.

Historical duplicate conversations and their messages are retained. The proposal does not automatically reconcile or delete them. Owner/backend rights and approved security-definer RPCs remain available. Review other write clients and role ownership before any hosted application.

Four actual PostgreSQL tests passed locally in networkless disposable containers: concurrent reversed-pair requests return one direct ID with exactly two members; concurrent group bootstrap returns one group; browser table/column insert and delete bypasses fail while last-read updates work; inactive administrators and anonymous callers cannot create conversations. The full branch workflow also runs these tests.

No hosted SQL was executed. No token/password was printed. Before applying: independently saved backup and verified restoration, exact target identity/schema/role audit, review alongside pending sixth migration and other RLS proposals, and conversion into a tracked ordered migration with a reviewed plan. Do not modify/reapply 006, adopt history, reset the database or automatically apply proposals. Production requires its own backup and upgrade plan.

Official frontend releases continue independently on main. Their client guards and in-memory drafts do not establish server uniqueness; this proposal has not been enabled there.
