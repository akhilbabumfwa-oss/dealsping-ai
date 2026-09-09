// DealsPing AI — Firebase (Firestore REST API) → D1 Sync
// Uses the plain REST API, NOT the Firebase JS SDK (Workers-friendly, no SDK weight).

import { calcDealScore, calcFreshness, extractDiscountPct, rebuildAiLists } from './engine.js';

const FIRESTORE_COLLECTIONS = ['deals', 'monitored_deals'];
const PAGE_SIZE = 300;
const SYNC_USER_AGENT = 'DealsPing-AI-Sync/1.0 (automated)';

// ─── Firestore REST value decoder ─────────────────────────────────────────────
// Firestore REST documents wrap every field in a typed envelope, e.g.
// { stringValue: "x" } or { integerValue: "5" } or { mapValue: { fields: {...} } }.
function decodeValue(value) {
  if (value == null) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return parseInt(value.integerValue, 10);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return new Date(value.timestampValue).getTime();
  if ('arrayValue' in value) {
    const vals = value.arrayValue.values || [];
    return vals.map(decodeValue);
  }
  if ('mapValue' in value) {
    return decodeFields(value.mapValue.fields || {});
  }
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('referenceValue' in value) return value.referenceValue;
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [key, val] of Object.entries(fields || {})) {
    out[key] = decodeValue(val);
  }
  return out;
}

// name looks like: projects/{p}/databases/(default)/documents/deals/{docId}
function docIdFromName(name) {
  const parts = name.split('/');
  return parts[parts.length - 1];
}

// ─── Fetch one collection (paginated) from Firestore REST API ────────────────
async function fetchCollection(env, collectionName) {
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collectionName}`;
  let pageToken = null;
  const docs = [];

  do {
    const url = new URL(baseUrl);
    url.searchParams.set('key', env.FIREBASE_API_KEY);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': SYNC_USER_AGENT },
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Firestore fetch failed [${collectionName}] ${resp.status}: ${text.slice(0, 300)}`);
    }

    const json = await resp.json();
    const pageDocs = json.documents || [];
    for (const d of pageDocs) {
      docs.push({ id: docIdFromName(d.name), fields: decodeFields(d.fields) });
    }
    pageToken = json.nextPageToken || null;
  } while (pageToken);

  return docs;
}

// ─── Map a decoded Firebase deal doc → D1 row ─────────────────────────────────
function mapDealToRow(firebaseId, f, sourceCollection) {
  const mrp = Number(f.mrp) || null;
  const price = Number(f.price) || null;
  const discountPct = extractDiscountPct(f.discount, mrp, price);

  const firebaseCreatedMs = typeof f.createdAt === 'number' ? f.createdAt : null;
  const firebaseUpdatedMs = typeof f.updatedAt === 'number' ? f.updatedAt : null;

  const freshness = calcFreshness(firebaseCreatedMs);

  const couponCode = f.couponCode || null;
  const bankOffer = f.bankOffer || null;

  const dealScore = calcDealScore({
    discount_pct: discountPct,
    freshness_score: freshness,
    current_price: price,
    trending: !!f.trending,
    featured: !!f.featured,
    coupon_code: couponCode,
    bank_offer: bankOffer,
  });

  const image = f.image || (Array.isArray(f.images) && f.images[0]) || null;

  return {
    id: `${sourceCollection}_${firebaseId}`,
    firebase_id: firebaseId,
    title: f.title || 'Untitled Deal',
    slug: f.slug || null,
    store: f.store || 'amazon',
    category: f.category || null,
    subcategory: f.subcategory || null,
    current_price: price,
    original_price: mrp,
    discount_pct: discountPct,
    discount_text: f.discount || null,
    affiliate_url: f.affiliateLink || null,
    original_url: f.originalLink || null,
    asin: f.asin || null,
    image_url: image,
    active: f.active === false ? 0 : 1,
    published: f.published === false ? 0 : 1,
    featured: f.featured ? 1 : 0,
    trending: f.trending ? 1 : 0,
    coupon_code: couponCode,
    coupon_discount: f.couponDiscount != null ? Number(f.couponDiscount) : null,
    bank_offer: bankOffer,
    deal_score: dealScore,
    freshness_score: freshness,
    deal_type: f.type || 'single',
    source_channel: f.source_channel || null,
    firebase_created_at: firebaseCreatedMs ? Math.floor(firebaseCreatedMs / 1000) : null,
    firebase_updated_at: firebaseUpdatedMs ? Math.floor(firebaseUpdatedMs / 1000) : null,
  };
}

// ─── Upsert a batch of rows into D1 ────────────────────────────────────────────
async function upsertRows(db, rows) {
  const now = Math.floor(Date.now() / 1000);
  const stmts = rows.map((r) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO deals (
          id, firebase_id, title, slug, store, category, subcategory,
          current_price, original_price, discount_pct, discount_text,
          affiliate_url, original_url, asin, image_url,
          active, published, featured, trending,
          coupon_code, coupon_discount, bank_offer,
          deal_score, freshness_score, deal_type, source_channel,
          firebase_created_at, firebase_updated_at,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          COALESCE((SELECT created_at FROM deals WHERE id = ?), ?), ?
        )`
      )
      .bind(
        r.id, r.firebase_id, r.title, r.slug, r.store, r.category, r.subcategory,
        r.current_price, r.original_price, r.discount_pct, r.discount_text,
        r.affiliate_url, r.original_url, r.asin, r.image_url,
        r.active, r.published, r.featured, r.trending,
        r.coupon_code, r.coupon_discount, r.bank_offer,
        r.deal_score, r.freshness_score, r.deal_type, r.source_channel,
        r.firebase_created_at, r.firebase_updated_at,
        r.id, now, now
      )
  );

  const CHUNK = 25; // keep D1 batch payload small (bind params add up fast)
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await db.batch(stmts.slice(i, i + CHUNK));
  }
}

// ─── Mark deals inactive if no longer present in the latest Firebase fetch ────
// D1 caps bound parameters at 100 per statement, which makes a NOT IN(...)
// list of Firebase ids unsafe once the collection grows past ~100 docs.
// Instead: reset all rows to inactive *before* the sync's upserts run (see
// runSync), leaving their updated_at untouched. Rows upserted this pass get
// updated_at bumped to "now" by upsertRows. Anything still inactive with a
// stale updated_at afterward was genuinely absent from the latest fetch.
async function resetAllActiveFlags(db) {
  await db.prepare(`UPDATE deals SET active = 0 WHERE active = 1`).run();
}

async function countDeactivatedSince(db, syncStartEpoch) {
  const row = await db
    .prepare(`SELECT COUNT(*) as c FROM deals WHERE active = 0 AND updated_at < ?`)
    .bind(syncStartEpoch)
    .first();
  return row?.c || 0;
}

// ─── Main sync entrypoint ──────────────────────────────────────────────────────
export async function runSync(env, { triggeredBy = 'manual' } = {}) {
  const startedAt = Date.now();
  const db = env.DB;

  if (!env.FIREBASE_API_KEY) {
    await logSync(db, { sync_type: triggeredBy, status: 'error', error_text: 'FIREBASE_API_KEY not set', duration_ms: Date.now() - startedAt });
    return { success: false, error: 'FIREBASE_API_KEY not set' };
  }

  let updated = 0;
  let skippedCount = 0;
  const allRows = [];

  try {
    // Fetch + map everything first. Nothing is written to D1 until every
    // collection has been fetched successfully, so a Firebase outage never
    // leaves D1 partially reset.
    for (const collectionName of FIRESTORE_COLLECTIONS) {
      let docs;
      try {
        docs = await fetchCollection(env, collectionName);
      } catch (e) {
        await logSync(db, {
          sync_type: triggeredBy,
          status: 'error',
          error_text: `Fetch failed [${collectionName}]: ${e.message}`,
          duration_ms: Date.now() - startedAt,
        });
        return { success: false, error: e.message, collection: collectionName };
      }

      for (const doc of docs) {
        try {
          const f = doc.fields;
          // Only sync active + published deals
          if (f.active === false || f.published === false) continue;
          allRows.push(mapDealToRow(doc.id, f, collectionName));
        } catch (e) {
          skippedCount++;
          // individual deal failure — skip, continue
        }
      }
    }

    // All fetches succeeded — safe to reset + upsert now.
    await resetAllActiveFlags(db);
    if (allRows.length) {
      await upsertRows(db, allRows);
      updated = allRows.length;
    }

    const deactivated = await countDeactivatedSince(db, Math.floor(startedAt / 1000));

    const { results: countRows } = await db.prepare(`SELECT COUNT(*) as c FROM deals WHERE active = 1`).all();
    const totalActive = countRows?.[0]?.c ?? 0;

    // Rebuild AI lists after every sync
    await rebuildAiLists(db);

    const durationMs = Date.now() - startedAt;
    await logSync(db, {
      sync_type: triggeredBy,
      deals_added: 0,
      deals_updated: updated,
      deals_removed: deactivated,
      total_deals: totalActive,
      status: 'success',
      duration_ms: durationMs,
    });

    return {
      success: true,
      synced: updated,
      deactivated,
      total_active: totalActive,
      skipped: skippedCount,
      duration_ms: durationMs,
    };
  } catch (e) {
    await logSync(db, {
      sync_type: triggeredBy,
      status: 'error',
      error_text: e.message,
      duration_ms: Date.now() - startedAt,
    });
    return { success: false, error: e.message };
  }
}

async function logSync(db, { sync_type, deals_added = 0, deals_updated = 0, deals_removed = 0, total_deals = 0, status, error_text = null, duration_ms = 0 }) {
  try {
    await db
      .prepare(
        `INSERT INTO sync_log (sync_type, deals_added, deals_updated, deals_removed, total_deals, status, error_text, duration_ms, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(sync_type, deals_added, deals_updated, deals_removed, total_deals, status, error_text, duration_ms, Math.floor(Date.now() / 1000))
      .run();
  } catch (_) {
    // Never let logging failure break the sync response.
  }
}
