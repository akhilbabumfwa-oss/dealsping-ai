// DealsPing AI — KV fallback buffer for D1 quota exhaustion
//
// When on-demand Amazon collection (amazon.js) fetches real product data but
// can't write it to D1 (e.g. daily read/write quota exhausted), the results
// are buffered here instead of being silently dropped. The midnight cron
// (index.js scheduled(), cron "0 0 * * *") flushes everything back to D1
// once quota resets.
//
// Key shape: kv_buffer:<timestamp>:<encoded query>
// Value: JSON { query, results: [{asin,title,brand}], buffered_at }

import { upsertCatalogRows } from './amazon.js';

const KV_PREFIX = 'kv_buffer:';
const FLUSH_CHUNK_SIZE = 500; // rows per D1 batch, per the requested chunking

export async function bufferToKv(env, query, results) {
  if (!env.DEALSPING_BUFFER) throw new Error('DEALSPING_BUFFER KV namespace not bound');
  if (!results || !results.length) return;

  const timestamp = Date.now();
  const key = `${KV_PREFIX}${timestamp}:${encodeURIComponent(query)}`;
  const value = JSON.stringify({
    query,
    results,
    buffered_at: Math.floor(timestamp / 1000),
  });
  await env.DEALSPING_BUFFER.put(key, value);
}

async function logFlush(db, { inserted, remaining, failed, durationMs, errorText }) {
  try {
    await db
      .prepare(
        `INSERT INTO sync_log (sync_type, deals_added, deals_updated, deals_removed, total_deals, status, error_text, duration_ms, synced_at)
         VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?)`
      )
      .bind(
        'kv_buffer_flush',
        inserted,
        remaining,
        failed > 0 ? 'partial_error' : 'success',
        errorText,
        durationMs,
        Math.floor(Date.now() / 1000)
      )
      .run();
  } catch (e) {
    console.error('logFlush failed:', e.message);
  }
}

// ─── List every buffered key (paginated) ───────────────────────────────────
async function listAllBufferedKeys(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: KV_PREFIX, cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

// ─── Main entrypoint — called by the midnight cron ─────────────────────────
export async function flushKvBufferToD1(env) {
  const startedAt = Date.now();
  const db = env.DB;
  const kv = env.DEALSPING_BUFFER;

  if (!kv) {
    console.error('flushKvBufferToD1: DEALSPING_BUFFER not bound');
    return { inserted: 0, remaining: 0, failed: 0 };
  }

  const keys = await listAllBufferedKeys(kv);
  if (keys.length === 0) {
    await logFlush(db, { inserted: 0, remaining: 0, failed: 0, durationMs: Date.now() - startedAt, errorText: null });
    return { inserted: 0, remaining: 0, failed: 0 };
  }

  // Load every buffered item up front. Group rows by their source KV key so
  // a key's rows are always inserted (and that key deleted) as one atomic
  // unit — never split across two D1 batches.
  const items = [];
  for (const key of keys) {
    try {
      const raw = await kv.get(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const rows = (parsed.results || []).map((r) => ({ ...r, query: parsed.query }));
      items.push({ key, rows });
    } catch (e) {
      console.error(`flushKvBufferToD1: failed to read/parse ${key}:`, e.message);
      // Leave this key in place — will retry next midnight.
    }
  }

  // Chunk by whole items, up to FLUSH_CHUNK_SIZE rows per chunk.
  const chunks = [];
  let current = { items: [], rowCount: 0 };
  for (const item of items) {
    if (current.rowCount + item.rows.length > FLUSH_CHUNK_SIZE && current.items.length > 0) {
      chunks.push(current);
      current = { items: [], rowCount: 0 };
    }
    current.items.push(item);
    current.rowCount += item.rows.length;
  }
  if (current.items.length) chunks.push(current);

  let inserted = 0;
  let failed = 0;
  let lastError = null;
  const keysToDelete = [];

  for (const chunk of chunks) {
    const flatRows = chunk.items.flatMap((i) => i.rows);
    try {
      await upsertCatalogRows(db, flatRows, null, 'kv_buffer_flush');
      inserted += flatRows.length;
      keysToDelete.push(...chunk.items.map((i) => i.key));
    } catch (e) {
      console.error('flushKvBufferToD1: chunk insert failed, leaving keys buffered for retry:', e.message);
      failed += chunk.items.length;
      lastError = e.message;
      // Do NOT delete these keys — next midnight's cron will retry them.
    }
  }

  // Only delete KV keys whose rows are confirmed committed to D1.
  for (const key of keysToDelete) {
    try {
      await kv.delete(key);
    } catch (e) {
      console.error(`flushKvBufferToD1: failed to delete confirmed key ${key}:`, e.message);
      // Row is safely in D1 already; a stray undeleted KV key just gets
      // re-inserted (harmlessly, INSERT OR REPLACE) next flush.
    }
  }

  const remaining = items.length - (keysToDelete.length);
  const durationMs = Date.now() - startedAt;
  await logFlush(db, { inserted, remaining, failed, durationMs, errorText: lastError });

  return { inserted, remaining, failed };
}
