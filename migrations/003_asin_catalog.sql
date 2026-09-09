-- ASIN catalog for the AI-recommendation "check + link" flow — see
-- src/mcp.js check_and_link / search_catalog and schema.sql for context.
CREATE TABLE IF NOT EXISTS asin_catalog (
  asin TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  subcategory TEXT,
  store TEXT DEFAULT 'amazon',
  affiliate_url TEXT,
  search_keywords TEXT,
  added_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS flipkart_catalog (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  product_url TEXT,
  affiliate_url TEXT,
  search_keywords TEXT,
  added_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_asin_category ON asin_catalog(category);
CREATE INDEX IF NOT EXISTS idx_asin_brand ON asin_catalog(brand);
CREATE INDEX IF NOT EXISTS idx_asin_keywords ON asin_catalog(search_keywords);
CREATE INDEX IF NOT EXISTS idx_flipkart_category ON flipkart_catalog(category);
