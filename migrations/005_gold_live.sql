-- Additive only. Apply locally during development, never to production without approval.
CREATE TABLE IF NOT EXISTS gold_spot_rates (
 id TEXT PRIMARY KEY, market TEXT NOT NULL CHECK(market IN ('CLT','TCR','EKM','PGT','CBE','MUM')),
 price_paise INTEGER NOT NULL CHECK(price_paise > 0 AND price_paise <= 100000000),
 effective_at INTEGER NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
 supersedes TEXT REFERENCES gold_spot_rates(id), correction_reason TEXT,
 CHECK(supersedes IS NULL OR length(correction_reason) >= 8)
);
CREATE UNIQUE INDEX IF NOT EXISTS gold_spot_one_correction ON gold_spot_rates(supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX IF NOT EXISTS gold_spot_market_time ON gold_spot_rates(market,effective_at);
CREATE TABLE IF NOT EXISTS gold_reference_sources (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
 permission_url TEXT NOT NULL, permission_verified_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gold_reference_rates (
 id TEXT PRIMARY KEY, market TEXT NOT NULL, price_paise INTEGER NOT NULL CHECK(price_paise > 0),
 effective_at INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES gold_reference_sources(id)
);
CREATE INDEX IF NOT EXISTS gold_reference_market_time ON gold_reference_rates(market,effective_at);
CREATE TABLE IF NOT EXISTS gold_observations (
 symbol TEXT NOT NULL, observed_at INTEGER NOT NULL, price REAL NOT NULL CHECK(price > 0),
 source TEXT NOT NULL, PRIMARY KEY(symbol,observed_at)
);
CREATE TABLE IF NOT EXISTS gold_api_cache (
 key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gold_provider_budget (
 hour INTEGER PRIMARY KEY, requests INTEGER NOT NULL
);
