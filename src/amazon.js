// DealsPing AI — On-demand Amazon catalog growth
//
// When a search comes up empty/thin, this fires a REAL Amazon Creators API
// searchItems call in the background (via ctx.waitUntil, never delaying the
// response) and saves real ASIN/title/brand into asin_catalog. This is the
// same credential/API as /home/ubuntu/asin-collector/collector.py's nightly
// sweep — just triggered live instead of waiting for 3am.
//
// Deliberately requests ONLY itemInfo.title + itemInfo.byLineInfo — no
// offersV2 (price/availability), no images. No price/rating data is ever
// fabricated or requested; if Amazon doesn't return it, we don't show it.
//
// D1 quota resilience: if D1 is unavailable (e.g. daily read/write quota
// exhausted), fetched results are buffered into KV instead of being silently
// dropped — see kvBuffer.js, flushed back to D1 by the midnight cron.

import { bufferToKv } from './kvBuffer.js';

const CREATORS_TOKEN_URL = 'https://api.amazon.co.uk/auth/o2/token';
const CREATORS_SEARCH_URL = 'https://creatorsapi.amazon/catalog/v1/searchItems';
const CREATORS_MARKETPLACE = 'www.amazon.in';
const AFFILIATE_TAG = 'webdealsping-21';
const DEDUP_WINDOW_SEC = 3600; // don't retry the same query within an hour

export function buildAsinAffiliateUrl(asin) {
  return `https://www.amazon.in/dp/${asin}?tag=${AFFILIATE_TAG}`;
}

function get(obj, ...path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

async function getAccessToken(env) {
  if (!env.AMAZON_CLIENT_ID || !env.AMAZON_CLIENT_SECRET) {
    throw new Error('AMAZON_CLIENT_ID/AMAZON_CLIENT_SECRET not configured');
  }
  const resp = await fetch(CREATORS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: env.AMAZON_CLIENT_ID,
      client_secret: env.AMAZON_CLIENT_SECRET,
      scope: 'creatorsapi::default',
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function searchAmazonProducts(token, query, itemCount = 5) {
  const payload = {
    keywords: query,
    itemCount,
    itemPage: 1,
    resources: ['itemInfo.title', 'itemInfo.byLineInfo'],
    partnerTag: AFFILIATE_TAG,
    partnerType: 'Associates',
    marketplace: CREATORS_MARKETPLACE,
  };
  const resp = await fetch(CREATORS_SEARCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-marketplace': CREATORS_MARKETPLACE,
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (data.errors || data.Errors) {
    throw new Error(`searchItems error: ${JSON.stringify(data.errors || data.Errors)}`);
  }

  const items = get(data, 'searchResult', 'items') || [];
  const results = [];
  for (const item of items) {
    const asin = item.asin;
    const title = get(item, 'itemInfo', 'title', 'displayValue');
    if (!asin || !title) continue;
    const brand = get(item, 'itemInfo', 'byLineInfo', 'brand', 'displayValue') || null;
    results.push({ asin, title, brand });
  }
  return results;
}

// Exported for reuse by kvBuffer.js's midnight flush (single source of truth
// for the upsert shape, whether writing live or replaying buffered results).
// Each row may carry its own `query` (used by the KV flush, where a single
// batch mixes rows from many different originally-searched queries); falls
// back to the shared `defaultQuery` param for the plain single-search case.
export async function upsertCatalogRows(db, rows, defaultQuery, source = 'on_demand_search') {
  if (!rows.length) return;
  const now = Math.floor(Date.now() / 1000);
  const stmts = rows.map((r) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO asin_catalog (
          asin, title, brand, category, subcategory, store, affiliate_url, search_keywords,
          source, added_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, 'amazon', ?, ?, ?,
          COALESCE((SELECT added_at FROM asin_catalog WHERE asin = ?), ?), ?)`
      )
      .bind(r.asin, r.title, r.brand, buildAsinAffiliateUrl(r.asin), r.query || defaultQuery, source, r.asin, now, now)
  );
  await db.batch(stmts);
}

async function logAttempt(db, normalizedQuery, resultsFound) {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT OR REPLACE INTO on_demand_search_log (query, attempted_at, results_found) VALUES (?, ?, ?)`
    )
    .bind(normalizedQuery, now, resultsFound)
    .run();
}

// ─── Main entrypoint — call via ctx.waitUntil(), never awaited on the request path ──
export async function triggerOnDemandCollection(env, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return;

  const db = env.DB;

  // Dedup check is best-effort: if D1 reads are unavailable (e.g. quota
  // exhausted — the exact failure mode this system is built to survive),
  // skip the check rather than aborting. Worst case during an outage is a
  // few redundant Amazon calls for the same query, which is an acceptable
  // trade-off against losing the collection attempt entirely.
  try {
    const recent = await db
      .prepare(`SELECT attempted_at FROM on_demand_search_log WHERE query = ?`)
      .bind(normalizedQuery)
      .first();
    const now = Math.floor(Date.now() / 1000);
    if (recent && now - recent.attempted_at < DEDUP_WINDOW_SEC) {
      return; // already tried recently — don't hammer Amazon for a repeat/dead query
    }
  } catch (e) {
    console.error('dedup check failed (D1 likely unavailable), proceeding anyway:', e.message);
  }

  let results;
  try {
    const token = await getAccessToken(env);
    results = await searchAmazonProducts(token, normalizedQuery);
  } catch (e) {
    // Amazon API itself failed — nothing to save, nothing to buffer.
    console.error('triggerOnDemandCollection: Amazon fetch failed:', e.message);
    return;
  }

  // Write path: try D1 first; fall back to KV buffer on any D1 failure so
  // real Amazon results are never silently dropped.
  try {
    await upsertCatalogRows(db, results, normalizedQuery);
    await logAttempt(db, normalizedQuery, results.length);
  } catch (e) {
    console.error('D1 write failed, buffering to KV instead:', e.message);
    try {
      await bufferToKv(env, normalizedQuery, results);
    } catch (kvError) {
      // Both D1 and KV failed — genuinely nothing more we can do; log and move on.
      console.error('KV buffer fallback also failed:', kvError.message);
    }
  }
}
