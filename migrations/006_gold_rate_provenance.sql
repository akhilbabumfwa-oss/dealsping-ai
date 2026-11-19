-- Fail closed for legacy observations: preserve them, but require explicit verification.
ALTER TABLE gold_spot_rates ADD COLUMN provenance TEXT NOT NULL DEFAULT 'unverified'
 CHECK(provenance IN ('unverified','test','admin_verified'));
ALTER TABLE gold_spot_rates ADD COLUMN verified_at INTEGER;
ALTER TABLE gold_reference_rates ADD COLUMN provenance TEXT NOT NULL DEFAULT 'unverified'
 CHECK(provenance IN ('unverified','test','reference_verified'));
ALTER TABLE gold_reference_rates ADD COLUMN verified_at INTEGER;
