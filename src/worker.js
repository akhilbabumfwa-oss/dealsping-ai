// Production entry point.
// live/index.js is the exact bundle deployed on 2026-10-02 (downloaded with
// `wrangler init --from-dash`). Its readable source was never committed, and the
// other files in src/ are OLDER than it. Every non-gold route and every cron is
// delegated to it unchanged; only the Gold Market routes are handled here.
import live from '../live/index.js';
import { handleGold } from './gold/router.js';
import { liveQuote } from './gold/service.js';

// Records a genuine XAU/USD provider snapshot so the USA 1H/1D charts have
// continuous observations even when nobody has the page open.
export const GOLD_SNAPSHOT_CRON = '*/10 * * * *';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/gold/') || pathname.startsWith('/admin/gold/')) {
      return handleGold(request, env);
    }
    return live.fetch(request, env, ctx);
  },
  // The live handler runs a full Firebase sync for any cron string it does not
  // recognise, so the gold cron must never reach it.
  scheduled(event, env, ctx) {
    if (event.cron === GOLD_SNAPSHOT_CRON) {
      ctx.waitUntil(liveQuote(env));
      return;
    }
    return live.scheduled(event, env, ctx);
  },
};
