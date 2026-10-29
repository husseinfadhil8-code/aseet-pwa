-- Operational metadata only. No financial records or settings are modified.
CREATE TABLE tg_n_outbox(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
CREATE TABLE tg_n_outbox_events(outbox_id TEXT NOT NULL REFERENCES tg_n_outbox(id),event_key TEXT NOT NULL REFERENCES tg_n_events(key),PRIMARY KEY(outbox_id,event_key));
CREATE INDEX tg_n_outbox_events_event ON tg_n_outbox_events(event_key);
CREATE TRIGGER tg_n_admin_audit AFTER INSERT ON tg_ops_audit WHEN NEW.operation LIKE 'admin_%' BEGIN
 INSERT OR IGNORE INTO tg_n_raw VALUES('admin_audit:'||NEW.id,'admin_operation',json_object('actor_telegram',NEW.actor,'title',NEW.operation),0,unixepoch()*1000);
END;
-- Preserve each distinct committed status transition, including returns to a
-- previous state. The old claim_id:state key lost such transitions.
DROP TRIGGER tg_n_claim_changed;
CREATE TRIGGER tg_n_claim_changed AFTER UPDATE OF state,payment_reference ON tg_ops_claims WHEN NEW.state!=OLD.state OR NEW.payment_reference IS NOT OLD.payment_reference BEGIN
 INSERT INTO tg_n_raw VALUES('cash_changed:'||NEW.id||':'||lower(hex(randomblob(16))),'cash_changed',json_object('actor_telegram',NEW.user_id,'claim_id',NEW.id,'state',NEW.state,'reason',NEW.reason),0,unixepoch()*1000);
END;
