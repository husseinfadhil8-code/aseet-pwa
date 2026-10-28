-- Additive operational metadata, in the EXISTING D1 database only.
-- Telegram accounts, advertisements, messages and authoritative roles stay in Supabase.
CREATE TABLE IF NOT EXISTS tg_ops_users(id INTEGER PRIMARY KEY,code TEXT NOT NULL UNIQUE,first_seen INTEGER NOT NULL,started INTEGER NOT NULL DEFAULT 0,tour_step INTEGER NOT NULL DEFAULT 0,marketing INTEGER NOT NULL DEFAULT 0,blocked INTEGER NOT NULL DEFAULT 0,known_market INTEGER NOT NULL DEFAULT 1,role TEXT NOT NULL DEFAULT 'market');
CREATE TABLE IF NOT EXISTS tg_ops_updates(id INTEGER PRIMARY KEY,state TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_ops_referrals(invitee INTEGER PRIMARY KEY REFERENCES tg_ops_users(id),inviter INTEGER NOT NULL REFERENCES tg_ops_users(id),state TEXT NOT NULL DEFAULT 'pending',reason TEXT NOT NULL DEFAULT '',checked_at INTEGER,created_at INTEGER NOT NULL,CHECK(invitee!=inviter));
CREATE INDEX IF NOT EXISTS tg_ops_referrals_inviter ON tg_ops_referrals(inviter,state);
CREATE TABLE IF NOT EXISTS tg_ops_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,funded INTEGER NOT NULL DEFAULT 0,terms_approved INTEGER NOT NULL DEFAULT 0,reward_cents INTEGER NOT NULL DEFAULT 500,target INTEGER NOT NULL DEFAULT 30,budget_cents INTEGER NOT NULL DEFAULT 0,max_rewards INTEGER NOT NULL DEFAULT 0,min_age_ms INTEGER NOT NULL DEFAULT 86400000,terms TEXT NOT NULL DEFAULT 'دعوة مستخدم جديد يبدأ البوت وينضم للقناة، دون تكرار أو دعوة للنفس. الاستحقاق المالي غير مفعّل.',version INTEGER NOT NULL DEFAULT 1);
INSERT OR IGNORE INTO tg_ops_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS tg_ops_claims(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,milestone INTEGER NOT NULL,amount_cents INTEGER NOT NULL,target_count INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',reason TEXT NOT NULL DEFAULT '',payment_reference TEXT UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_id,milestone));
CREATE TABLE IF NOT EXISTS tg_ops_campaigns(id TEXT PRIMARY KEY,text TEXT NOT NULL,route TEXT NOT NULL,audience TEXT NOT NULL DEFAULT 'all',state TEXT NOT NULL DEFAULT 'draft',scheduled_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS tg_ops_delivery(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,user_id INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,error TEXT,updated_at INTEGER NOT NULL,UNIQUE(campaign_id,user_id));
CREATE TABLE IF NOT EXISTS tg_ops_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor INTEGER NOT NULL,operation TEXT NOT NULL,reference TEXT NOT NULL,details TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_ops_notices(key TEXT PRIMARY KEY,user_id INTEGER NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_ops_save_receipts(key TEXT PRIMARY KEY,actor INTEGER NOT NULL,payload_hash TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_ops_leases(name TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_ops_drafts(token TEXT PRIMARY KEY,payload_json TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_ops_channel_intro(id INTEGER PRIMARY KEY CHECK(id=1),text TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'draft',message_id INTEGER,updated_at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS tg_ops_users_audience ON tg_ops_users(started,marketing,blocked,role);
CREATE INDEX IF NOT EXISTS tg_ops_delivery_due ON tg_ops_delivery(state,updated_at,campaign_id);
