-- Existing operational D1 only; no Supabase schema or business-row changes.
CREATE TABLE IF NOT EXISTS tg_n_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT OR IGNORE INTO tg_n_meta VALUES('boot_at',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE IF NOT EXISTS tg_n_events(key TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,test INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_n_delivery(key TEXT PRIMARY KEY,event_key TEXT NOT NULL REFERENCES tg_n_events(key),audience TEXT NOT NULL CHECK(audience IN ('admin','user')),user_ref TEXT,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,message_id INTEGER,error_code TEXT NOT NULL DEFAULT '',lease TEXT);
CREATE INDEX IF NOT EXISTS tg_n_delivery_due ON tg_n_delivery(state,available_at);
CREATE TABLE IF NOT EXISTS tg_n_preferences(scope TEXT NOT NULL,kind TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(scope,kind));
CREATE TABLE IF NOT EXISTS tg_n_snapshots(source TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source,id));
CREATE TABLE IF NOT EXISTS tg_n_scans(source TEXT PRIMARY KEY,cursor TEXT NOT NULL DEFAULT '',initialized INTEGER NOT NULL DEFAULT 0,last_success INTEGER,error_code TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS tg_n_raw(key TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,processed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_n_registration(user_id TEXT PRIMARY KEY,miniapp_seen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tg_n_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',result TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_n_health(id INTEGER PRIMARY KEY CHECK(id=1),result TEXT NOT NULL,checked_at INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS tg_n_bot_insert AFTER INSERT ON tg_ops_users WHEN NEW.started=1 BEGIN
 INSERT OR IGNORE INTO tg_n_raw VALUES('bot_first:'||NEW.id,'bot_first',json_object('actor_telegram',NEW.id),0,unixepoch()*1000);
END;
CREATE TRIGGER IF NOT EXISTS tg_n_bot_start AFTER UPDATE OF started ON tg_ops_users WHEN NEW.started=1 AND OLD.started=0 BEGIN
 INSERT OR IGNORE INTO tg_n_raw VALUES('bot_first:'||NEW.id,'bot_first',json_object('actor_telegram',NEW.id),0,unixepoch()*1000);
END;
CREATE TRIGGER IF NOT EXISTS tg_n_reward_enrolled AFTER INSERT ON tg_ops_reward_enrollments BEGIN
 INSERT OR IGNORE INTO tg_n_raw VALUES('campaign_enrolled:'||NEW.user_id,'campaign_enrolled',json_object('actor_telegram',NEW.user_id),0,unixepoch()*1000);
END;
CREATE TRIGGER IF NOT EXISTS tg_n_referral_qualified AFTER UPDATE OF state ON tg_ops_referrals WHEN NEW.state='qualified' AND OLD.state!='qualified' BEGIN
 INSERT OR IGNORE INTO tg_n_raw VALUES('referral_qualified:'||NEW.invitee,'referral_qualified',json_object('actor_telegram',NEW.inviter,'invitee',NEW.invitee),0,unixepoch()*1000);
 INSERT OR IGNORE INTO tg_n_raw SELECT 'referral_milestone:'||NEW.inviter,'referral_milestone',json_object('actor_telegram',NEW.inviter),0,unixepoch()*1000 WHERE EXISTS(SELECT 1 FROM tg_ops_reward_enrollments e WHERE e.user_id=NEW.inviter AND (SELECT COUNT(*) FROM tg_ops_referrals r WHERE r.inviter=NEW.inviter AND r.state='qualified' AND r.created_at>=e.created_at)>=e.target_count);
END;
CREATE TRIGGER IF NOT EXISTS tg_n_claim_created AFTER INSERT ON tg_ops_claims BEGIN
 INSERT OR IGNORE INTO tg_n_raw VALUES('cash_requested:'||NEW.id,'cash_requested',json_object('actor_telegram',NEW.user_id,'claim_id',NEW.id,'state',NEW.state),0,unixepoch()*1000);
END;
CREATE TRIGGER IF NOT EXISTS tg_n_claim_changed AFTER UPDATE OF state ON tg_ops_claims WHEN NEW.state!=OLD.state BEGIN
 INSERT OR IGNORE INTO tg_n_raw VALUES('cash_changed:'||NEW.id||':'||NEW.state,'cash_changed',json_object('actor_telegram',NEW.user_id,'claim_id',NEW.id,'state',NEW.state,'reason',NEW.reason),0,unixepoch()*1000);
END;
CREATE TABLE IF NOT EXISTS tg_n_links(token TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE REFERENCES tg_n_events(key));
