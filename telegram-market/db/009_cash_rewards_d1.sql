-- Existing D1 only. Apply once, after verifying both columns are absent.
-- No changes to Supabase accounts, advertisements or messages.
ALTER TABLE tg_ops_settings ADD COLUMN budget_iqd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tg_ops_settings ADD COLUMN reward_iqd INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS tg_ops_reward_enrollments(user_id INTEGER PRIMARY KEY REFERENCES tg_ops_users(id),amount_cents INTEGER NOT NULL CHECK(amount_cents=1000),amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0),target_count INTEGER NOT NULL CHECK(target_count=30),state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','claimed','rejected')),created_at INTEGER NOT NULL,terms TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tg_ops_reward_seen(user_id INTEGER PRIMARY KEY,seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_ops_reward_notifications(claim_id TEXT PRIMARY KEY REFERENCES tg_ops_claims(id),state TEXT NOT NULL DEFAULT 'pending',updated_at INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS tg_ops_reward_health(id INTEGER PRIMARY KEY CHECK(id=1),membership_ready INTEGER NOT NULL DEFAULT 0,checked_at INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS tg_ops_reward_qualify_due ON tg_ops_referrals(state,checked_at,created_at);
