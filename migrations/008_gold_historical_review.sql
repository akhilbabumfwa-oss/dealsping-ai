-- Historical workbook imports are staged, not published. All tables are append-only.
CREATE TABLE IF NOT EXISTS gold_history_sources (
 id TEXT PRIMARY KEY, filename TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE,
 metadata_json TEXT NOT NULL, summary_json TEXT NOT NULL, sheets_json TEXT NOT NULL,
 imported_at INTEGER NOT NULL, expected_rows INTEGER NOT NULL, expected_records INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gold_history_rows (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES gold_history_sources(id),
 sheet TEXT NOT NULL, row_number INTEGER NOT NULL, raw_cells_json TEXT NOT NULL,
 UNIQUE(source_id,sheet,row_number)
);
CREATE TABLE IF NOT EXISTS gold_history_records (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES gold_history_sources(id),
 row_id TEXT NOT NULL REFERENCES gold_history_rows(id), sheet TEXT NOT NULL, cell TEXT NOT NULL,
 field TEXT NOT NULL, kind TEXT NOT NULL, market TEXT, asset TEXT NOT NULL, purity TEXT, unit TEXT,
 original_date TEXT NOT NULL, original_time TEXT, timezone TEXT, observed_at INTEGER,
 value_json TEXT NOT NULL, numeric_text TEXT, notes TEXT NOT NULL, flags_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('accepted','rejected','duplicate','pending_review')),
 fingerprint TEXT NOT NULL, UNIQUE(source_id,sheet,cell)
);
CREATE TABLE IF NOT EXISTS gold_history_fingerprints (fingerprint TEXT PRIMARY KEY, record_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gold_history_completions (
 source_id TEXT PRIMARY KEY REFERENCES gold_history_sources(id), completed_at INTEGER NOT NULL,
 row_count INTEGER NOT NULL, record_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gold_history_decisions (
 id TEXT PRIMARY KEY, record_id TEXT NOT NULL UNIQUE REFERENCES gold_history_records(id),
 spot_id TEXT NOT NULL REFERENCES gold_spot_rates(id), reviewed_at INTEGER NOT NULL,
 reviewed_by TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision='approve'),
 provenance TEXT NOT NULL CHECK(provenance IN ('test','admin_verified'))
);
CREATE INDEX IF NOT EXISTS gold_history_preview ON gold_history_records(source_id,kind,market,status,observed_at);
CREATE INDEX IF NOT EXISTS gold_history_fingerprint_index ON gold_history_records(fingerprint);
