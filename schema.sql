-- DealsPing AI Deal Discovery System — D1 Schema

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  firebase_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  slug TEXT,
  store TEXT DEFAULT 'amazon',
  category TEXT,
  subcategory TEXT,
  current_price REAL,
  original_price REAL,
  discount_pct REAL,
  discount_text TEXT,
  affiliate_url TEXT,
  original_url TEXT,
  asin TEXT,
  image_url TEXT,
  active INTEGER DEFAULT 1,
  published INTEGER DEFAULT 1,
  featured INTEGER DEFAULT 0,
  trending INTEGER DEFAULT 0,
  coupon_code TEXT,
  coupon_discount REAL,
  bank_offer TEXT,
  rating REAL,
  review_count INTEGER,
  in_stock INTEGER DEFAULT 1,
  deal_score REAL DEFAULT 0,
  freshness_score REAL DEFAULT 0,
  deal_type TEXT DEFAULT 'single',
  source_channel TEXT,
  firebase_created_at INTEGER,
  firebase_updated_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS ai_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_type TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  rank INTEGER,
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (deal_id) REFERENCES deals(id)
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  main_category TEXT,
  category TEXT,
  subcategory TEXT,
  is_active INTEGER DEFAULT 1,
  rotation_order INTEGER DEFAULT 0,
  last_rotated INTEGER,
  deal_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS category_rotation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rotation_day INTEGER,
  category TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_type TEXT,
  deals_added INTEGER DEFAULT 0,
  deals_updated INTEGER DEFAULT 0,
  deals_removed INTEGER DEFAULT 0,
  total_deals INTEGER DEFAULT 0,
  status TEXT,
  error_text TEXT,
  duration_ms INTEGER,
  synced_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS api_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT,
  query TEXT,
  results_count INTEGER,
  response_ms INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

-- ASIN Catalog (core table for AI-driven "check if it exists, link it" flow —
-- no price/image/availability by design: those need a live Amazon lookup at
-- click time, not a cached snapshot. See asin-collector/collector.py.)
CREATE TABLE IF NOT EXISTS asin_catalog (
  asin TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  subcategory TEXT,
  store TEXT DEFAULT 'amazon',
  affiliate_url TEXT,
  search_keywords TEXT,
  source TEXT DEFAULT 'asin_collector',
  added_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Dedup guard for on-demand catalog growth (see src/amazon.js) — prevents
-- hammering the Amazon API with repeated calls for the same failed query.
CREATE TABLE IF NOT EXISTS on_demand_search_log (
  query TEXT PRIMARY KEY,
  attempted_at INTEGER,
  results_found INTEGER DEFAULT 0
);

-- Flipkart catalog (same no-price-caching principle)
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_asin_category ON asin_catalog(category);
CREATE INDEX IF NOT EXISTS idx_asin_brand ON asin_catalog(brand);
CREATE INDEX IF NOT EXISTS idx_asin_keywords ON asin_catalog(search_keywords);
CREATE INDEX IF NOT EXISTS idx_flipkart_category ON flipkart_catalog(category);

CREATE INDEX IF NOT EXISTS idx_deals_category ON deals(category);
CREATE INDEX IF NOT EXISTS idx_deals_store ON deals(store);
CREATE INDEX IF NOT EXISTS idx_deals_score ON deals(deal_score DESC);
CREATE INDEX IF NOT EXISTS idx_deals_active ON deals(active, published);
CREATE INDEX IF NOT EXISTS idx_deals_price ON deals(current_price);
CREATE INDEX IF NOT EXISTS idx_deals_discount ON deals(discount_pct DESC);
CREATE INDEX IF NOT EXISTS idx_deals_updated ON deals(firebase_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_slug ON deals(slug);
CREATE INDEX IF NOT EXISTS idx_deals_asin ON deals(asin);
CREATE INDEX IF NOT EXISTS idx_deals_trending ON deals(trending);
CREATE INDEX IF NOT EXISTS idx_deals_featured ON deals(featured);
CREATE INDEX IF NOT EXISTS idx_ai_lists_type ON ai_lists(list_type, rank);
