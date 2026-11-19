-- Rejections retain original staging and cannot publish a rate.
CREATE TABLE IF NOT EXISTS gold_history_rejections (
 record_id TEXT PRIMARY KEY REFERENCES gold_history_records(id),
 reviewed_at INTEGER NOT NULL, reviewed_by TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 8 AND 1000),
 provenance TEXT NOT NULL CHECK(provenance IN ('test','admin_verified'))
);
CREATE TRIGGER IF NOT EXISTS gold_history_reject_approved
BEFORE INSERT ON gold_history_rejections
WHEN EXISTS(SELECT 1 FROM gold_history_decisions WHERE record_id=NEW.record_id)
BEGIN SELECT RAISE(ABORT,'Observation already approved'); END;
CREATE TRIGGER IF NOT EXISTS gold_history_approve_rejected
BEFORE INSERT ON gold_history_decisions
WHEN EXISTS(SELECT 1 FROM gold_history_rejections WHERE record_id=NEW.record_id)
BEGIN SELECT RAISE(ABORT,'Observation already rejected'); END;
