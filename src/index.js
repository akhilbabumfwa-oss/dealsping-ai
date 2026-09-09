// DealsPing AI — Main Worker Router
// Routes:
//   /api/*                    → api.js (public REST API)
//   /mcp                      → mcp.js (MCP tool server)
//   /.well-known/mcp.json     → MCP manifest
//   /.well-known/ai-plugin.json → ChatGPT plugin manifest
//   /openapi.yaml             → OpenAPI spec (for AI platform discovery)
//   /admin/*                  → admin.js (protected by X-Admin-Secret)
//   /sync                     → manual sync trigger (protected by X-Sync-Secret)
//   /dashboard                → admin dashboard UI
//   /health                   → health check
// Cron triggers handle scheduled sync / list rebuild / category rotation.

import { handleApi } from './api.js';
import { handleMcp, mcpManifest } from './mcp.js';
import { handleAdmin } from './admin.js';
import { runSync } from './sync.js';
import { rebuildAiLists, rotateCategories } from './engine.js';
import { flushKvBufferToD1 } from './kvBuffer.js';

import dashboardHtml from '../dashboard/index.html';
import aiPluginJson from '../openai-plugin/ai-plugin.json';
import openapiYaml from '../openai-plugin/openapi.yaml';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret, X-Sync-Secret',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── API ──────────────────────────────────────────────────────────────
      if (path.startsWith('/api/')) {
        return handleApi(request, env, url);
      }

      // ── MCP ──────────────────────────────────────────────────────────────
      if (path === '/mcp') {
        return handleMcp(request, env, ctx);
      }

      if (path === '/.well-known/mcp.json') {
        return json(mcpManifest(env));
      }

      if (path === '/.well-known/ai-plugin.json') {
        return new Response(
          typeof aiPluginJson === 'string' ? aiPluginJson : JSON.stringify(aiPluginJson),
          { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }

      if (path === '/openapi.yaml') {
        return new Response(openapiYaml, {
          headers: { 'Content-Type': 'text/yaml', ...CORS_HEADERS },
        });
      }

      // ── Admin ────────────────────────────────────────────────────────────
      if (path.startsWith('/admin/')) {
        return handleAdmin(request, env, url);
      }

      // ── Manual sync trigger (separate secret from admin) ────────────────
      if (path === '/sync') {
        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        const provided = request.headers.get('X-Sync-Secret') || url.searchParams.get('secret');
        if (!env.SYNC_SECRET || provided !== env.SYNC_SECRET) {
          return json({ success: false, error: 'Unauthorized' }, 401);
        }
        const result = await runSync(env, { triggeredBy: 'manual_endpoint' });
        return json({ success: result.success, data: result });
      }

      // ── Dashboard UI ─────────────────────────────────────────────────────
      if (path === '/dashboard' || path === '/dashboard/') {
        return new Response(dashboardHtml, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // ── Health check ─────────────────────────────────────────────────────
      if (path === '/health') {
        try {
          const activeRow = await env.DB.prepare(`SELECT COUNT(*) as c FROM deals WHERE active = 1`).first();
          const lastSync = await env.DB.prepare(`SELECT synced_at FROM sync_log ORDER BY synced_at DESC LIMIT 1`).first();
          return json({ status: 'ok', deals: activeRow?.c || 0, last_sync: lastSync?.synced_at || null });
        } catch (e) {
          return json({ status: 'error', error: e.message }, 500);
        }
      }

      if (path === '/' || path === '') {
        return json({
          name: 'DealsPing AI',
          description: "India's deal discovery platform — AI-ready deal search API + MCP server",
          endpoints: {
            api: '/api/*',
            mcp: '/mcp',
            mcp_manifest: '/.well-known/mcp.json',
            openapi: '/openapi.yaml',
            dashboard: '/dashboard',
            health: '/health',
          },
        });
      }

      return json({ success: false, error: 'Not found' }, 404);
    } catch (e) {
      return json({ success: false, error: `Unhandled error: ${e.message}` }, 500);
    }
  },

  // ── Scheduled (cron) handler ─────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    // "0 */6 * * *"  → Firebase sync every 6 hours (this window includes
    //                  midnight UTC too — a separate invocation from the
    //                  "0 0 * * *" trigger below; different cron string,
    //                  different table (deals vs asin_catalog/KV), no conflict)
    // "0 2 */2 * *"  → Rebuild AI lists every 2 days at 2am
    // "0 3 */4 * *"  → Category rotation every 4 days at 3am
    // "0 0 * * *"    → Flush KV fallback buffer to D1, daily at midnight UTC
    if (cron === '0 */6 * * *') {
      ctx.waitUntil(runSync(env, { triggeredBy: 'cron_sync' }));
    } else if (cron === '0 2 */2 * *') {
      ctx.waitUntil(rebuildAiLists(env.DB));
    } else if (cron === '0 3 */4 * *') {
      ctx.waitUntil(rotateCategories(env.DB));
    } else if (cron === '0 0 * * *') {
      ctx.waitUntil(flushKvBufferToD1(env));
    } else {
      // Fallback: run a sync so nothing silently no-ops on an unrecognized schedule.
      ctx.waitUntil(runSync(env, { triggeredBy: `cron_${cron}` }));
    }
  },
};
