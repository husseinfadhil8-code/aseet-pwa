ALTER TABLE admin_challenges ADD COLUMN approval_window_id TEXT;
ALTER TABLE admin_challenges ADD COLUMN enrollment_request_id TEXT;
CREATE TABLE admin_enrollment_windows(slot INTEGER PRIMARY KEY CHECK(slot=1),id TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,issued INTEGER NOT NULL DEFAULT 0 CHECK(issued BETWEEN 0 AND 5));
CREATE TABLE admin_enrollment_requests(id TEXT PRIMARY KEY,window_id TEXT NOT NULL,browser_hash TEXT UNIQUE NOT NULL,credential_id TEXT UNIQUE NOT NULL,public_key TEXT NOT NULL,counter INTEGER NOT NULL,user_handle TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','denied','consumed')));
CREATE INDEX admin_enrollment_expiry ON admin_enrollment_requests(expires_at);
CREATE TABLE admin_enrollment_approvals(slot INTEGER PRIMARY KEY CHECK(slot=1),request_id TEXT UNIQUE NOT NULL,window_id TEXT NOT NULL,fingerprint TEXT NOT NULL,approved_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,verification_ref TEXT NOT NULL);
CREATE TRIGGER admin_request_immutable BEFORE UPDATE OF id,window_id,browser_hash,credential_id,public_key,counter,user_handle,fingerprint,created_at,expires_at ON admin_enrollment_requests BEGIN SELECT RAISE(ABORT,'immutable enrollment request'); END;
