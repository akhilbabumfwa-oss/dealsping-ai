// DealsPing AI — Public REST API
// Response envelope: { success, data, count, total, page, source, powered_by }

const SOURCE = 'dealsping.in';
const POWERED_BY = 'DealsPing AI';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const AMAZON_DISCLOSURE = 'As an Amazon Associate, DealsPing earns from qualifying purchases';
const CATALOG_AFFILIATE_TAG = 'webdealsping-21';

function buildAsinAffiliateUrl(asin) {
  return `https://www.amazon.in/dp/${asin}?tag=${CATALOG_AFFILIATE_TAG}`;
}

// ─── Best-effort in-memory rate limiter (per isolate) ────────────────────────
// Not distributed-strict (Workers isolates can be recycled), but provides
// real protection against bursty single-client abuse without extra infra.
const rateBuckets = new Map(); // ip -> { count, windowStart }
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret, X-Sync-Secret',
};

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ success: false, error: message, source: SOURCE, powered_by: POWERED_BY }, status);
}

function paginationParams(url) {
  let limit = parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10);
  let page = parseInt(url.searchParams.get('page') || '1', 10);
  if (isNaN(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  if (isNaN(page) || page <= 0) page = 1;
  const offset = (page - 1) * limit;
  return { limit, page, offset };
}

// ─── Clean deal shape for public responses ────────────────────────────────────
function cleanDeal(row, siteUrl) {
  return {
    id: row.id,
    title: row.title,
    store: row.store,
    category: row.category,
    current_price: row.current_price,
    original_price: row.original_price,
    discount_pct: row.discount_pct,
    discount_text: row.discount_text,
    affiliate_url: row.affiliate_url,
    image_url: row.image_url,
    coupon_code: row.coupon_code || null,
    bank_offer: row.bank_offer || null,
    deal_score: row.deal_score,
    slug: row.slug,
    deal_url: row.slug ? `${siteUrl}/deal/${row.slug}` : null,
    asin: row.asin || null,
    rating: row.rating ?? null,
    review_count: row.review_count ?? null,
  };
}

function withDisclosure(payload, deals) {
  const hasAffiliate = deals.some((d) => d.affiliate_url);
  if (hasAffiliate) {
    payload.disclosure = AMAZON_DISCLOSURE;
  }
  return payload;
}

async function logApiCall(db, endpoint, query, resultsCount, responseMs) {
  try {
    await db
      .prepare(`INSERT INTO api_log (endpoint, query, results_count, response_ms, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(endpoint, query, resultsCount, responseMs, Math.floor(Date.now() / 1000))
      .run();
  } catch (_) {
    // never fail the request because logging failed
  }
}

// ─── List-type backed endpoints (via ai_lists join) ──────────────────────────
async function handleListEndpoint(db, listType, url, siteUrl) {
  const { limit, page, offset } = paginationParams(url);

  const totalRow = await db
    .prepare(`SELECT COUNT(*) as c FROM ai_lists WHERE list_type = ?`)
    .bind(listType)
    .first();
  const total = totalRow?.c || 0;

  const { results } = await db
    .prepare(
      `SELECT d.* FROM ai_lists al
       JOIN deals d ON d.id = al.deal_id
       WHERE al.list_type = ? AND d.active = 1 AND d.published = 1
       ORDER BY al.rank ASC
       LIMIT ? OFFSET ?`
    )
    .bind(listType, limit, offset)
    .all();

  const deals = (results || []).map((r) => cleanDeal(r, siteUrl));
  return { deals, total, page, count: deals.length };
}

// ─── AI collector ingestion (upsert by ASIN) ─────────────────────────────────
async function handleDealsImport(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  const provided = request.headers.get('X-Sync-Secret');
  if (!env.SYNC_SECRET || provided !== env.SYNC_SECRET) {
    return errorResponse('Unauthorized', 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorResponse('Invalid JSON body', 400);
  }

  const asin = String(body.asin || '').trim();
  const title = String(body.title || '').trim();
  const currentPrice = Number(body.current_price);
  if (!asin || !title || !currentPrice || currentPrice <= 0) {
    return errorResponse('asin, title, and a positive current_price are required', 400);
  }

  const db = env.DB;
  const id = `ai_${asin}`;
  const now = Math.floor(Date.now() / 1000);

  const originalPrice = Number(body.original_price) || currentPrice;
  const discountPct = body.discount_pct != null ? Number(body.discount_pct) : 0;
  const discountText = body.discount_text || (discountPct > 0 ? `${Math.round(discountPct)}%` : null);
  const dealScore = body.deal_score != null ? Number(body.deal_score) : 0;
  const rating = body.rating != null ? Number(body.rating) : null;
  const reviewCount = body.review_count != null ? parseInt(body.review_count, 10) : null;
  const inStock = body.in_stock === false ? 0 : 1;

  try {
    const existing = await db.prepare(`SELECT id FROM deals WHERE id = ?`).bind(id).first();

    await db
      .prepare(
        `INSERT OR REPLACE INTO deals (
          id, firebase_id, title, slug, store, category, subcategory,
          current_price, original_price, discount_pct, discount_text,
          affiliate_url, original_url, asin, image_url,
          active, published, featured, trending,
          coupon_code, coupon_discount, bank_offer,
          rating, review_count, in_stock,
          deal_score, freshness_score, deal_type, source_channel,
          firebase_created_at, firebase_updated_at,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          1, 1, 0, 0,
          NULL, NULL, NULL,
          ?, ?, ?,
          ?, 1.0, 'single', ?,
          COALESCE((SELECT firebase_created_at FROM deals WHERE id = ?), ?), ?,
          COALESCE((SELECT created_at FROM deals WHERE id = ?), ?), ?
        )`
      )
      .bind(
        id, id, title, null, body.store || 'amazon', body.category || null, null,
        currentPrice, originalPrice, discountPct, discountText,
        body.affiliate_url || null, body.affiliate_url || null, asin, body.image_url || null,
        rating, reviewCount, inStock,
        dealScore, body.source_channel || 'ai_collector',
        id, now, now,
        id, now, now
      )
      .run();

    return jsonResponse({ success: true, action: existing ? 'updated' : 'inserted', id, asin });
  } catch (e) {
    return errorResponse(`Import failed: ${e.message}`, 500);
  }
}

// ─── ASIN catalog import (single) ────────────────────────────────────────────
function upsertCatalogRow(row) {
  const asin = String(row.asin || '').trim();
  const title = String(row.title || '').trim();
  if (!asin || !title) return { ok: false, error: 'asin and title are required' };
  return {
    ok: true,
    asin,
    title,
    brand: row.brand || null,
    category: row.category || null,
    subcategory: row.subcategory || null,
    store: row.store || 'amazon',
    affiliate_url: row.affiliate_url || buildAsinAffiliateUrl(asin),
    search_keywords: row.search_keywords || null,
  };
}

async function handleCatalogImport(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') return errorResponse('Method not allowed', 405);

  const provided = request.headers.get('X-Sync-Secret');
  if (!env.SYNC_SECRET || provided !== env.SYNC_SECRET) {
    return errorResponse('Unauthorized', 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorResponse('Invalid JSON body', 400);
  }

  const row = upsertCatalogRow(body);
  if (!row.ok) return errorResponse(row.error, 400);

  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);

  try {
    const existing = await db.prepare(`SELECT asin FROM asin_catalog WHERE asin = ?`).bind(row.asin).first();
    await db
      .prepare(
        `INSERT OR REPLACE INTO asin_catalog (
          asin, title, brand, category, subcategory, store, affiliate_url, search_keywords,
          added_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT added_at FROM asin_catalog WHERE asin = ?), ?), ?)`
      )
      .bind(row.asin, row.title, row.brand, row.category, row.subcategory, row.store, row.affiliate_url, row.search_keywords, row.asin, now, now)
      .run();

    return jsonResponse({ success: true, action: existing ? 'updated' : 'inserted', asin: row.asin });
  } catch (e) {
    return errorResponse(`Import failed: ${e.message}`, 500);
  }
}

// ─── ASIN catalog import (bulk) ───────────────────────────────────────────────
async function handleCatalogBulkImport(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') return errorResponse('Method not allowed', 405);

  const provided = request.headers.get('X-Sync-Secret');
  if (!env.SYNC_SECRET || provided !== env.SYNC_SECRET) {
    return errorResponse('Unauthorized', 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorResponse('Invalid JSON body', 400);
  }

  const products = Array.isArray(body.products) ? body.products : Array.isArray(body) ? body : null;
  if (!products) return errorResponse('Body must be an array of products, or {products: [...]}', 400);

  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;
  let failed = 0;
  const errors = [];

  const validRows = [];
  for (const raw of products) {
    const row = upsertCatalogRow(raw);
    if (!row.ok) {
      failed++;
      errors.push({ asin: raw?.asin || null, error: row.error });
      continue;
    }
    validRows.push(row);
  }

  const CHUNK = 25; // stay well under D1's 100-bound-parameter-per-statement limit
  for (let i = 0; i < validRows.length; i += CHUNK) {
    const chunk = validRows.slice(i, i + CHUNK);
    try {
      const stmts = chunk.map((row) =>
        db
          .prepare(
            `INSERT OR REPLACE INTO asin_catalog (
              asin, title, brand, category, subcategory, store, affiliate_url, search_keywords,
              added_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT added_at FROM asin_catalog WHERE asin = ?), ?), ?)`
          )
          .bind(row.asin, row.title, row.brand, row.category, row.subcategory, row.store, row.affiliate_url, row.search_keywords, row.asin, now, now)
      );
      await db.batch(stmts);
      inserted += chunk.length;
    } catch (e) {
      failed += chunk.length;
      errors.push({ chunkStart: i, error: e.message });
    }
  }

  return jsonResponse({ success: true, total: products.length, inserted, failed, errors: errors.slice(0, 20) });
}

// ─── ASIN catalog stats (public) ──────────────────────────────────────────────
async function handleCatalogStats(env) {
  const db = env.DB;
  const totalRow = await db.prepare(`SELECT COUNT(*) as c FROM asin_catalog`).first();
  const { results: byCategory } = await db
    .prepare(`SELECT category, COUNT(*) as count FROM asin_catalog WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC`)
    .all();
  return jsonResponse({
    success: true,
    data: {
      total_asins: totalRow?.c || 0,
      by_category: byCategory || [],
    },
    source: SOURCE,
    powered_by: POWERED_BY,
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────
export async function handleApi(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Secret-authenticated internal ingestion routes — exempt from the public
  // per-IP rate limiter (same reasoning as /admin/* and /sync in index.js).
  if (url.pathname === '/api/deals/import') {
    return handleDealsImport(request, env);
  }
  if (url.pathname === '/api/catalog/import') {
    return handleCatalogImport(request, env);
  }
  if (url.pathname === '/api/catalog/bulk-import') {
    return handleCatalogBulkImport(request, env);
  }

  const ip = clientIp(request);
  if (!checkRateLimit(ip)) {
    return errorResponse('Rate limit exceeded (60 requests/minute)', 429);
  }

  const db = env.DB;
  const siteUrl = env.SITE_URL || 'https://dealsping.in';
  const path = url.pathname;
  const startedAt = Date.now();

  try {
    // /api/deals/best
    if (path === '/api/deals/best') {
      const { deals, total, page, count } = await handleListEndpoint(db, 'best_deals', url, siteUrl);
      await logApiCall(db, path, url.search, count, Date.now() - startedAt);
      return jsonResponse(withDisclosure({ success: true, data: deals, count, total, page, source: SOURCE, powered_by: POWERED_BY }, deals));
    }

    // /api/deals/latest
    if (path === '/api/deals/latest') {
      const { deals, total, page, count } = await handleListEndpoint(db, 'latest_deals', url, siteUrl);
      await logApiCall(db, path, url.search, count, Date.now() - startedAt);
      return jsonResponse(withDisclosure({ success: true, data: deals, count, total, page, source: SOURCE, powered_by: POWERED_BY }, deals));
    }

    // /api/deals/trending
    if (path === '/api/deals/trending') {
      const { deals, total, page, count } = await handleListEndpoint(db, 'trending_deals', url, siteUrl);
      await logApiCall(db, path, url.search, count, Date.now() - startedAt);
      return jsonResponse(withDisclosure({ success: true, data: deals, count, total, page, source: SOURCE, powered_by: POWERED_BY }, deals));
    }

    // /api/deals/featured
    if (path === '/api/deals/featured') {
      const { deals, total, page, count } = await handleListEndpoint(db, 'featured_deals', url, siteUrl);
      await logApiCall(db, path, url.search, count, Date.now() - startedAt);
      return jsonResponse(withDisclosure({ success: true, data: deals, count, total, page, source: SOURCE, powered_by: POWERED_BY }, deals));
    }

    // /api/deals/search?q=
    if (path === '/api/deals/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return errorResponse('Missing required query parameter: q');
      const { limit, page, offset } = paginationParams(url);
      const like = `%${q}%`;

      const totalRow = await db
        .prepare(`SELECT COUNT(*) as c FROM deals WHERE active = 1 AND published = 1 AND title LIKE ?`)
        .bind(like)
        .first();
      const total = totalRow?.c || 0;

      const { results } = await db
        .prepare(
          `SELECT * FROM deals WHERE active = 1 AND published = 1 AND title LIKE ?
           ORDER BY deal_score DESC LIMIT ? OFFSET ?`
        )
        .bind(like, limit, offset)
        .all();

      const deals = (results || []).map((r) => cleanDeal(r, siteUrl));
      await logApiCall(db, path, url.search, deals.length, Date.now() - startedAt);
      return jsonResponse(withDisclosure({ success: true, data: deals, count: deals.length, total, page, source: SOURCE, powered_by: POWERED_BY }, deals));
    }

    // /api/deals/category/:category
    let m = path.match(/^\/api\/deals\/category\/([^/]+)$/);
    if (m) {
      const category = decodeURIComponent(m[1]);
      const { limit, page, offset } = paginationParams(url);

      const totalRow = await db
        .prepare(`SELECT COUNT(*) as c FROM deals WHERE active = 1 AND published = 1 AND LOWER(category) = LOWER(?)`)
        .bind(category)
        .first();
      const total = totalRow?.c || 0;

      const { results } = await db
        .prepare(
          `SELECT * FROM deals WHERE active = 1 AND published = 1 AND LOWER(category) = LOWER(?)
           ORDER BY deal_score DESC LIMIT ? OFFSET ?`
        )
        .bind(category, limit, offset)
        .all();

      const deals = (results || []).map((r) => cleanDeal(r, siteUrl));
      await logApiCall(db, path, url.search, deals.length, Date.now() - startedAt);
      return jsonResponse(withDisclosure({ success: true, data: deals, count: deals.length, total, page, source: SOURCE, powered_by: POWERED_BY }, deals));
    }

    // /api/deals/price?min=&max=
    if (path === '/api/deals/price') {
      const min = parseFloat(url.searchParams.get('min') || '0');
      const max = parseFloat(url.searchParams.get('max') || '999999999');
      const { limit, page, offset } = paginationParams(url);

      const totalRow = await db
        .prepare(`SELECT COUNT(*) as c FROM deals WHERE active = 1 AND published = 1 AND current_price BETWEEN ? AND ?`)
        .bind(min, max)
        .first();
      const total = totalRow?.c || 0;

      const { results } = await db
        .prepare(
          `SELECT * FROM deals WHERE active = 1 AND published = 1 AND current_price BETWEEN ? AND ?
           ORDER BY deal_score DESC LIMIT ? OFFSET ?`
        )
        .bind(min, max, limit, offset)
        .all();

      const deals = (results || []).map((r) => cleanDeal(r, siteUrl));
      await logApiCall(db, path, url.search, deals.length, Date.now() - startedAt);
      return jsonResponse(withDisclosure({ success: true, data: deals, count: deals.length, total, page, source: SOURCE, powered_by: POWERED_BY }, deals));
    }

    // /api/deals/store/:store
    m = path.match(/^\/api\/deals\/store\/([^/]+)$/);
    if (m) {
      const store = decodeURIComponent(m[1]);
      const { limit, page, offset } = paginationParams(url);

      const totalRow = await db
        .prepare(`SELECT COUNT(*) as c FROM deals WHERE active = 1 AND published = 1 AND LOWER(store) = LOWER(?)`)
        .bind(store)
        .first();
      const total = totalRow?.c || 0;

      const { results } = await db
        .prepare(
          `SELECT * FROM deals WHERE active = 1 AND published = 1 AND LOWER(store) = LOWER(?)
           ORDER BY deal_score DESC LIMIT ? OFFSET ?`
        )
        .bind(store, limit, offset)
        .all();

      const deals = (results || []).map((r) => cleanDeal(r, siteUrl));
      await logApiCall(db, path, url.search, deals.length, Date.now() - startedAt);
      return jsonResponse(withDisclosure({ success: true, data: deals, count: deals.length, total, page, source: SOURCE, powered_by: POWERED_BY }, deals));
    }

    // /api/lists/:list_type
    m = path.match(/^\/api\/lists\/([^/]+)$/);
    if (m) {
      const listType = decodeURIComponent(m[1]);
      const { deals, total, page, count } = await handleListEndpoint(db, listType, url, siteUrl);
      await logApiCall(db, path, url.search, count, Date.now() - startedAt);
      return jsonResponse(withDisclosure({ success: true, data: deals, count, total, page, source: SOURCE, powered_by: POWERED_BY }, deals));
    }

    // /api/categories
    if (path === '/api/categories') {
      const { results } = await db
        .prepare(
          `SELECT category, COUNT(*) as count FROM deals
           WHERE active = 1 AND published = 1 AND category IS NOT NULL
           GROUP BY category ORDER BY count DESC`
        )
        .all();
      await logApiCall(db, path, url.search, results?.length || 0, Date.now() - startedAt);
      return jsonResponse({ success: true, data: results || [], count: results?.length || 0, source: SOURCE, powered_by: POWERED_BY });
    }

    // /api/stats
    if (path === '/api/stats') {
      const totalRow = await db.prepare(`SELECT COUNT(*) as c FROM deals`).first();
      const activeRow = await db.prepare(`SELECT COUNT(*) as c FROM deals WHERE active = 1`).first();
      const catRow = await db.prepare(`SELECT COUNT(DISTINCT category) as c FROM deals WHERE category IS NOT NULL`).first();
      const lastSync = await db.prepare(`SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1`).first();

      const stats = {
        total_deals: totalRow?.c || 0,
        active_deals: activeRow?.c || 0,
        categories: catRow?.c || 0,
        last_sync: lastSync?.synced_at || null,
        last_sync_status: lastSync?.status || null,
      };
      await logApiCall(db, path, url.search, 1, Date.now() - startedAt);
      return jsonResponse({ success: true, data: stats, source: SOURCE, powered_by: POWERED_BY });
    }

    // /api/catalog/stats
    if (path === '/api/catalog/stats') {
      return handleCatalogStats(env);
    }

    // /api/deals/:id  (by id or slug) — must be checked AFTER the more specific routes above
    m = path.match(/^\/api\/deals\/([^/]+)$/);
    if (m) {
      const idOrSlug = decodeURIComponent(m[1]);
      const row = await db
        .prepare(`SELECT * FROM deals WHERE (id = ? OR slug = ?) AND active = 1 AND published = 1 LIMIT 1`)
        .bind(idOrSlug, idOrSlug)
        .first();

      if (!row) return errorResponse('Deal not found', 404);
      const deal = cleanDeal(row, siteUrl);
      await logApiCall(db, path, url.search, 1, Date.now() - startedAt);
      return jsonResponse(withDisclosure({ success: true, data: deal, source: SOURCE, powered_by: POWERED_BY }, [deal]));
    }

    return errorResponse('Unknown API endpoint', 404);
  } catch (e) {
    return errorResponse(`Internal error: ${e.message}`, 500);
  }
}
