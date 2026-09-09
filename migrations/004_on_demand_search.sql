-- On-demand catalog growth: when a search comes up empty/thin, a real Amazon
-- searchItems call is triggered in the background (see src/amazon.js) and
-- results are saved into asin_catalog tagged with source='on_demand_search'
-- so they're distinguishable from the nightly asin-collector.py sweep.
ALTER TABLE asin_catalog ADD COLUMN source TEXT DEFAULT 'asin_collector';

-- Dedup guard: prevents hammering the Amazon API with repeated on-demand
-- calls for the same query (e.g. a burst of identical searches, or a query
-- Amazon genuinely has zero matches for). A query is skipped if it was
-- already attempted within the last hour.
CREATE TABLE IF NOT EXISTS on_demand_search_log (
  query TEXT PRIMARY KEY,
  attempted_at INTEGER,
  results_found INTEGER DEFAULT 0
);
