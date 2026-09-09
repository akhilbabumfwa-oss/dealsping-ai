// DealsPing AI — Deal Score Engine, Freshness, AI Lists, Category Rotation
// Pure functions + D1 operations. No Firebase access here (see sync.js).

// ─── Discount % extraction ───────────────────────────────────────────────────
export function extractDiscountPct(discountText, mrp, price) {
  if (discountText) {
    const m = String(discountText).match(/(\d+(?:\.\d+)?)/);
    if (m) return Math.max(0, Math.min(100, parseFloat(m[1])));
  }
  if (mrp && price && mrp > price && mrp > 0) {
    return Math.max(0, Math.min(100, ((mrp - price) / mrp) * 100));
  }
  return 0;
}

// ─── Freshness ────────────────────────────────────────────────────────────────
// firebaseCreatedMs: epoch millis of the deal's Firebase createdAt
export function calcFreshness(firebaseCreatedMs, nowMs = Date.now()) {
  if (!firebaseCreatedMs) return 0.1;
  const hours = (nowMs - firebaseCreatedMs) / 3_600_000;
  if (hours < 6) return 1.0;
  if (hours < 24) return 0.8;
  if (hours < 48) return 0.6;
  if (hours < 24 * 7) return 0.3;
  return 0.1;
}

// ─── Price competitiveness score (0-15) ──────────────────────────────────────
function priceScore(price) {
  const p = Number(price) || 0;
  if (p > 0 && p < 500) return 15;
  if (p < 1000) return 12;
  if (p < 2000) return 9;
  if (p < 5000) return 6;
  return 3;
}

// ─── Deal Score (0-100) ───────────────────────────────────────────────────────
// deal: { discount_pct, freshness_score, current_price, trending, featured,
//         coupon_code, bank_offer }
export function calcDealScore(deal) {
  const discountScore = (Math.min(100, Math.max(0, deal.discount_pct || 0)) / 100) * 25; // max 25
  const freshnessScore = (deal.freshness_score ?? 0) * 20; // max 20
  const priceComp = priceScore(deal.current_price); // max 15
  const trendingScore = deal.trending ? 15 : 0; // max 15
  const featuredScore = deal.featured ? 10 : 0; // max 10
  const couponBonus = deal.coupon_code ? 10 : 0; // max 10
  const bankOfferBonus = deal.bank_offer ? 5 : 0; // max 5

  const total =
    discountScore + freshnessScore + priceComp + trendingScore + featuredScore + couponBonus + bankOfferBonus;

  return Math.round(Math.min(100, Math.max(0, total)) * 100) / 100;
}

// ─── AI Lists definitions ─────────────────────────────────────────────────────
// Each entry: { type, where (SQL fragment), orderBy (SQL fragment) }
const LIST_DEFS = [
  {
    type: 'best_deals',
    where: `active = 1 AND published = 1`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'latest_deals',
    where: `active = 1 AND published = 1`,
    orderBy: `firebase_created_at DESC`,
  },
  {
    type: 'trending_deals',
    where: `active = 1 AND published = 1 AND trending = 1`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'featured_deals',
    where: `active = 1 AND published = 1 AND featured = 1`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'under_500',
    where: `active = 1 AND published = 1 AND current_price > 0 AND current_price <= 500`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'under_1000',
    where: `active = 1 AND published = 1 AND current_price > 0 AND current_price <= 1000`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'under_2000',
    where: `active = 1 AND published = 1 AND current_price > 0 AND current_price <= 2000`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'under_5000',
    where: `active = 1 AND published = 1 AND current_price > 0 AND current_price <= 5000`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'electronics',
    where: `active = 1 AND published = 1 AND LOWER(category) = 'electronics'`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'fashion',
    where: `active = 1 AND published = 1 AND LOWER(category) = 'fashion'`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'home_kitchen',
    where: `active = 1 AND published = 1 AND (LOWER(category) = 'home' OR LOWER(category) = 'kitchen')`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'mobiles',
    where: `active = 1 AND published = 1 AND (LOWER(category) LIKE '%mobile%' OR LOWER(category) LIKE '%phone%')`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'with_coupon',
    where: `active = 1 AND published = 1 AND coupon_code IS NOT NULL AND coupon_code != ''`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'with_bank_offer',
    where: `active = 1 AND published = 1 AND bank_offer IS NOT NULL AND bank_offer != ''`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'amazon_deals',
    where: `active = 1 AND published = 1 AND LOWER(store) = 'amazon'`,
    orderBy: `deal_score DESC`,
  },
  {
    type: 'flipkart_deals',
    where: `active = 1 AND published = 1 AND LOWER(store) = 'flipkart'`,
    orderBy: `deal_score DESC`,
  },
];

export const AI_LIST_TYPES = LIST_DEFS.map((d) => d.type);

// ─── Rebuild all AI lists ─────────────────────────────────────────────────────
export async function rebuildAiLists(db) {
  const results = {};
  for (const def of LIST_DEFS) {
    try {
      await db.prepare(`DELETE FROM ai_lists WHERE list_type = ?`).bind(def.type).run();

      const selectSql = `
        SELECT id FROM deals
        WHERE ${def.where}
        ORDER BY ${def.orderBy}
        LIMIT 100
      `;
      const { results: rows } = await db.prepare(selectSql).all();

      if (rows && rows.length) {
        const now = Math.floor(Date.now() / 1000);
        const stmts = rows.map((row, idx) =>
          db
            .prepare(
              `INSERT INTO ai_lists (list_type, deal_id, rank, updated_at) VALUES (?, ?, ?, ?)`
            )
            .bind(def.type, row.id, idx + 1, now)
        );
        // D1 batch — chunk to stay under limits
        const CHUNK = 50;
        for (let i = 0; i < stmts.length; i += CHUNK) {
          await db.batch(stmts.slice(i, i + CHUNK));
        }
      }
      results[def.type] = rows ? rows.length : 0;
    } catch (e) {
      results[def.type] = `error: ${e.message}`;
    }
  }
  return results;
}

// ─── Category Rotation ────────────────────────────────────────────────────────
export const ROTATION_GROUPS = [
  ['electronics', 'mobiles', 'laptops', 'earbuds'],
  ['tv', 'monitors', 'gaming', 'accessories'],
  ['fashion', 'shoes', 'bags', 'watches'],
  ['home', 'kitchen', 'beauty', 'sports'],
];

export function dayOfYear(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const diff = date.getTime() - start;
  return Math.floor(diff / 86_400_000);
}

export function currentRotationGroupIndex(date = new Date()) {
  return Math.floor(dayOfYear(date) / 4) % ROTATION_GROUPS.length;
}

export async function rotateCategories(db) {
  const idx = currentRotationGroupIndex();
  const group = ROTATION_GROUPS[idx];
  const day = dayOfYear();
  const now = Math.floor(Date.now() / 1000);

  const stmts = group.map((cat) =>
    db
      .prepare(`INSERT INTO category_rotation (rotation_day, category, created_at) VALUES (?, ?, ?)`)
      .bind(day, cat, now)
  );
  await db.batch(stmts);

  return { rotation_group_index: idx, categories: group, day };
}

// ─── Recompute scores for all active deals ───────────────────────────────────
// Called after sync (scores are already set per-row during sync), but exposed
// here in case a standalone recompute is needed (e.g. freshness decays daily).
export async function recomputeAllScores(db) {
  const { results: rows } = await db
    .prepare(`SELECT id, discount_pct, current_price, trending, featured, coupon_code, bank_offer, firebase_created_at FROM deals WHERE active = 1`)
    .all();

  if (!rows || !rows.length) return 0;

  const now = Date.now();
  const stmts = rows.map((row) => {
    const freshness = calcFreshness(row.firebase_created_at ? row.firebase_created_at * 1000 : null, now);
    const score = calcDealScore({
      discount_pct: row.discount_pct,
      freshness_score: freshness,
      current_price: row.current_price,
      trending: row.trending,
      featured: row.featured,
      coupon_code: row.coupon_code,
      bank_offer: row.bank_offer,
    });
    return db
      .prepare(`UPDATE deals SET freshness_score = ?, deal_score = ?, updated_at = ? WHERE id = ?`)
      .bind(freshness, score, Math.floor(now / 1000), row.id);
  });

  const CHUNK = 50;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await db.batch(stmts.slice(i, i + CHUNK));
  }
  return rows.length;
}
