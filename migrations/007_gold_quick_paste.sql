-- Additive: existing 24K INR/g spot observations retain their explicit legacy meaning.
-- No historical record is updated or deleted.
ALTER TABLE gold_spot_rates ADD COLUMN rate_type TEXT NOT NULL DEFAULT 'SPOT' CHECK(rate_type IN ('SPOT','RTGS'));
ALTER TABLE gold_spot_rates ADD COLUMN metal TEXT NOT NULL DEFAULT 'GOLD' CHECK(metal IN ('GOLD','SILVER'));
ALTER TABLE gold_spot_rates ADD COLUMN purity TEXT NOT NULL DEFAULT '24K';
ALTER TABLE gold_spot_rates ADD COLUMN quote_unit TEXT NOT NULL DEFAULT 'INR/g';
ALTER TABLE gold_spot_rates ADD COLUMN quoted_price_paise INTEGER;
ALTER TABLE gold_spot_rates ADD COLUMN source_name TEXT;
ALTER TABLE gold_spot_rates ADD COLUMN batch_id TEXT;
CREATE TABLE IF NOT EXISTS gold_rate_imports (
 id TEXT PRIMARY KEY, source_name TEXT NOT NULL, raw_message TEXT NOT NULL,
 created_at INTEGER NOT NULL, created_by TEXT NOT NULL, provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gold_spot_series_time ON gold_spot_rates(market,rate_type,metal,purity,effective_at);
CREATE UNIQUE INDEX IF NOT EXISTS gold_import_observation ON gold_spot_rates(market,rate_type,metal,purity,effective_at) WHERE batch_id IS NOT NULL;
