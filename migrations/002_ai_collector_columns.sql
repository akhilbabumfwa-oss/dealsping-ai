-- Additive columns for AI-collected deals (rating/review_count from Amazon
-- searchItems customerReviews resource; in_stock from offersV2 availability).
-- Existing rows get NULL/1 defaults — no data loss, no breaking change.
ALTER TABLE deals ADD COLUMN rating REAL;
ALTER TABLE deals ADD COLUMN review_count INTEGER;
ALTER TABLE deals ADD COLUMN in_stock INTEGER DEFAULT 1;
