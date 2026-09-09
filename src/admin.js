// DealsPing AI — Admin Dashboard API (protected by ADMIN_SECRET header)

import { runSync } from './sync.js';
import { rebuildAiLists, rotateCategories } from './engine.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function unauthorized() {
  return json({ success: false, error: 'Unauthorized — missing or invalid X-Admin-Secret header' }, 401);
}

function checkAuth(request, env) {
  if (!env.ADMIN_SECRET) return false; // fail closed if not configured
  const provided = request.headers.get('X-Admin-Secret');
  return provided && provided === env.ADMIN_SECRET;
}

export async function handleAdmin(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!checkAuth(request, env)) return unauthorized();

  const db = env.DB;
  const path = url.pathname;

  try {
    // GET /admin/stats
    if (path === '/admin/stats' && request.method === 'GET') {
      const totalRow = await db.prepare(`SELECT COUNT(*) as c FROM deals`).first();
      const activeRow = await db.prepare(`SELECT COUNT(*) as c FROM deals WHERE active = 1`).first();
      const expiredRow = await db.prepare(`SELECT COUNT(*) as c FROM deals WHERE active = 0`).first();
      const catRow = await db.prepare(`SELECT COUNT(DISTINCT category) as c FROM deals WHERE category IS NOT NULL`).first();
      const lastSync = await db.prepare(`SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1`).first();
      const lastRotation = await db.prepare(`SELECT * FROM category_rotation ORDER BY created_at DESC LIMIT 1`).first();
      const apiCallsToday = await db
        .prepare(`SELECT COUNT(*) as c FROM api_log WHERE created_at >= ?`)
        .bind(Math.floor(Date.now() / 1000) - 86400)
        .first();

      return json({
        success: true,
        data: {
          total_deals: totalRow?.c || 0,
          active_deals: activeRow?.c || 0,
          expired_deals: expiredRow?.c || 0,
          categories: catRow?.c || 0,
          last_sync: lastSync?.synced_at || null,
          last_sync_status: lastSync?.status || null,
          last_rotation: lastRotation?.created_at || null,
          api_calls_last_24h: apiCallsToday?.c || 0,
        },
      });
    }

    // GET /admin/sync-log
    if (path === '/admin/sync-log' && request.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 100);
      const { results } = await db
        .prepare(`SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT ?`)
        .bind(limit)
        .all();
      return json({ success: true, data: results || [] });
    }

    // GET /admin/top-deals
    if (path === '/admin/top-deals' && request.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 50);
      const { results } = await db
        .prepare(`SELECT * FROM deals WHERE active = 1 ORDER BY deal_score DESC LIMIT ?`)
        .bind(limit)
        .all();
      return json({ success: true, data: results || [] });
    }

    // GET /admin/failed-imports
    if (path === '/admin/failed-imports' && request.method === 'GET') {
      const { results } = await db
        .prepare(`SELECT * FROM sync_log WHERE status = 'error' ORDER BY synced_at DESC LIMIT 20`)
        .all();
      return json({ success: true, data: results || [] });
    }

    // POST /admin/sync
    if (path === '/admin/sync' && request.method === 'POST') {
      const result = await runSync(env, { triggeredBy: 'admin_manual' });
      return json({ success: result.success, data: result });
    }

    // POST /admin/rebuild-lists
    if (path === '/admin/rebuild-lists' && request.method === 'POST') {
      const result = await rebuildAiLists(db);
      return json({ success: true, data: result });
    }

    // POST /admin/rotate
    if (path === '/admin/rotate' && request.method === 'POST') {
      const result = await rotateCategories(db);
      return json({ success: true, data: result });
    }

    // POST /admin/deal/:id/disable
    let m = path.match(/^\/admin\/deal\/([^/]+)\/disable$/);
    if (m && request.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const res = await db
        .prepare(`UPDATE deals SET active = 0, updated_at = ? WHERE id = ? OR firebase_id = ?`)
        .bind(Math.floor(Date.now() / 1000), id, id)
        .run();
      return json({ success: true, data: { changes: res.meta?.changes || 0 } });
    }

    // POST /admin/deal/:id/feature
    m = path.match(/^\/admin\/deal\/([^/]+)\/feature$/);
    if (m && request.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const res = await db
        .prepare(`UPDATE deals SET featured = 1, updated_at = ? WHERE id = ? OR firebase_id = ?`)
        .bind(Math.floor(Date.now() / 1000), id, id)
        .run();
      return json({ success: true, data: { changes: res.meta?.changes || 0 } });
    }

    return json({ success: false, error: 'Unknown admin endpoint' }, 404);
  } catch (e) {
    return json({ success: false, error: `Internal error: ${e.message}` }, 500);
  }
}
