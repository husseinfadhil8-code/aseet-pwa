CREATE TABLE admin_bootstrap(slot INTEGER PRIMARY KEY CHECK(slot=1),code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE admin_credentials(slot INTEGER PRIMARY KEY CHECK(slot=1),id TEXT UNIQUE NOT NULL,public_key TEXT NOT NULL,counter INTEGER NOT NULL,user_handle TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE admin_challenges(id_hash TEXT PRIMARY KEY,challenge TEXT NOT NULL,kind TEXT NOT NULL,user_handle TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE admin_sessions(token_hash TEXT PRIMARY KEY,credential_id TEXT NOT NULL,csrf_hash TEXT NOT NULL,csrf_token TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE admin_auth_limits(bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL);
