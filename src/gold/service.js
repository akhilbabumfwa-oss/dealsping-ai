import { MARKETS, PERIODS, nowSeconds, currentRate, validateSpotBatch, GoldInputError } from './core.js';
import {historyCoverage,observationStats,lastRecordedRate} from './historical.js';
const inflight = new Map();
const results = r => r.results || [];
const rows = async (db, sql, ...args) => results(await db.prepare(sql).bind(...args).all());
export async function cached(env, key, ttl, loader, now = nowSeconds()) {
 const old = await env.DB.prepare('SELECT * FROM gold_api_cache WHERE key=?').bind(key).first();
 if (old && old.expires_at > now) return { ...JSON.parse(old.payload), cached: true };
 if (inflight.has(key)) return inflight.get(key);
 const promise = (async () => {
  try {
   const value = await loader();
   await env.DB.prepare('INSERT INTO gold_api_cache(key,payload,expires_at,fetched_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at,fetched_at=excluded.fetched_at').bind(key, JSON.stringify(value), now + ttl, now).run();
   return value;
  } catch {
   const fallback = old ? { ...JSON.parse(old.payload), stale: true, unavailable: true } : { price: null, points: [], unavailable: true };
   // Persist a short failure backoff: repeated visitors must not hammer an unavailable provider.
   await env.DB.prepare('INSERT INTO gold_api_cache(key,payload,expires_at,fetched_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at').bind(key, JSON.stringify(fallback), now + 30, old?.fetched_at ?? now).run();
   return fallback;
  } finally { inflight.delete(key); }
 })();
 inflight.set(key, promise);
 return promise;
}
async function provider(path, key) {
 const response = await fetch('https://api.gold-api.com' + path, {
  headers: key ? { 'x-api-key': key } : {}, signal: AbortSignal.timeout(7000),
 });
 if (!response.ok) throw Error('Market provider unavailable');
 return response.json();
}
export async function liveQuote(env, currency = 'USD') {
 const quote=await cached(env, 'live:' + currency, 30, async () => {
  const raw = await provider('/price/XAU/' + currency);
  const at = Date.parse(raw.updatedAt);
  if (raw.symbol !== 'XAU' || raw.currency !== currency || !Number.isFinite(raw.price) || raw.price <= 0 || !Number.isFinite(at) || at > Date.now() + 60000) throw Error('Invalid market quote');
  // Store the original provider timestamp, never a synthetic bucket timestamp.
  if (currency === 'USD') await env.DB.prepare('INSERT OR IGNORE INTO gold_observations(symbol,observed_at,price,source) VALUES(?,?,?,?)').bind('XAUUSD', Math.floor(at / 1000), raw.price, 'gold-api.com').run();
  return { price: raw.price, at: raw.updatedAt, source: 'gold-api.com', kind: 'international_spot', verified:true,provenance:'provider_validated',exchangeRate: Number.isFinite(raw.exchangeRate) && raw.exchangeRate > 0 ? raw.exchangeRate : null, stale: Date.now() - at > 300000 };
 });
 // This provider has no documented session-status field. Closure must be explicitly
 // confirmed by the operator; an old timestamp alone never means "market closed".
 return {...quote,marketStatus:env.GOLD_MARKET_STATUS==='closed'?'closed':'unknown',stale:quote.stale===true||!Number.isFinite(Date.parse(quote.at))||Date.now()-Date.parse(quote.at)>300000};
}
const spotSql = `SELECT s.* FROM gold_spot_rates s WHERE market=? AND rate_type='SPOT' AND metal='GOLD' AND purity='24K' AND effective_at<=? AND provenance='admin_verified' AND verified_at>0 AND verified_at<=? AND NOT EXISTS(SELECT 1 FROM gold_spot_rates c WHERE c.supersedes=s.id AND c.provenance='admin_verified' AND c.verified_at>0 AND c.effective_at<=? AND c.verified_at<=?) ORDER BY effective_at DESC,created_at DESC LIMIT 64`;
export async function marketRate(db, market, now = nowSeconds()) {
 const spots = await rows(db, spotSql, market, now, now, now, now);
 const references = await rows(db, `SELECT r.*,s.name AS source_name FROM gold_reference_rates r JOIN gold_reference_sources s ON s.id=r.source_id WHERE r.market=? AND r.effective_at<=? AND r.provenance='reference_verified' AND r.verified_at>0 AND r.verified_at<=? AND s.permission_verified_at>0 AND s.permission_verified_at<=? ORDER BY r.effective_at DESC LIMIT 64`, market, now, now, now);
 return { market, price:null,at:null,verified:false,...currentRate(spots, references, now) };
}
export async function summary(env) {
 const [usa, inr, markets] = await Promise.all([liveQuote(env), liveQuote(env, 'INR'), Promise.all(MARKETS.map(m => marketRate(env.DB, m)))]);
 const dayStart=Math.floor(Date.now()/86400000)*86400;
 const previous = await env.DB.prepare('SELECT price FROM gold_observations WHERE symbol=? AND observed_at>=? AND observed_at<? ORDER BY observed_at DESC LIMIT 1').bind('XAUUSD',dayStart-86400,dayStart).first();
 return { demo: env.GOLD_DEMO_MODE === 'true', markets, usa: { ...usa, change: previous && usa.price ? usa.price - previous.price : null }, fx: { price: inr.exchangeRate ?? null, at: inr.at ?? null, stale: inr.stale ?? false, source: 'gold-api.com currency conversion', change: null }, serverTime: new Date().toISOString() };
}
async function dailyHistory(env) {
 if (!env.GOLD_API_KEY) return { points: [], limitation: 'Historical API key not configured. Only observations collected since setup are available.' };
 return cached(env, 'history:daily:year', 86400, async () => {
  const now = nowSeconds(), hour = Math.floor(now / 3600);
  const budget = await env.DB.prepare('INSERT INTO gold_provider_budget(hour,requests) VALUES(?,1) ON CONFLICT(hour) DO UPDATE SET requests=requests+1 WHERE requests<8 RETURNING requests').bind(hour).first();
  if (!budget) throw Error('Historical request budget exhausted');
  const q = new URLSearchParams({ symbol: 'XAU', startTimestamp: String(now - PERIODS['1Y']), endTimestamp: String(now), groupBy: 'day', aggregation: 'avg', orderBy: 'asc' });
  const raw = await provider('/history?' + q, env.GOLD_API_KEY);
  if (!Array.isArray(raw)) throw Error('Invalid history');
  const points = raw.map(p => ({ at: Date.parse(p.day + 'T00:00:00Z') / 1000, price: p.avg_price })).filter(p => Number.isFinite(p.at) && Number.isFinite(p.price) && p.price > 0 && p.at <= now);
  return { points, kind: 'daily_average', source: 'gold-api.com', limitation: 'Free provider history is daily average data; it is not intraday ticks.' };
 });
}
export async function history(env, market, range, kind) {
 if (!Object.hasOwn(PERIODS,range) || !['usa','kerala'].includes(kind) || (kind !== 'usa' && !MARKETS.includes(market))) throw new GoldInputError('Invalid market or range');
 if (kind === 'usa' && !['1H','1D','1W','1M','3M','1Y'].includes(range)) throw new GoldInputError('Unsupported USA range');
 if (kind !== 'usa' && !['1H','1D','1W','1M','3M','6M','1Y'].includes(range)) throw new GoldInputError('Unsupported Kerala range');
 const now = nowSeconds(), start = now - PERIODS[range];
 if (kind === 'usa') {
  if (['1H','1D'].includes(range)) {
   const data = await rows(env.DB, 'SELECT observed_at AS at,price FROM gold_observations WHERE symbol=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at LIMIT 3000', 'XAUUSD', start, now);
   return { points: data, kind: 'observed_spot', gapSeconds: 1800, limitation: 'Actual snapshots collected since setup. Missing periods remain gaps; no synthetic history.' };
  }
  const daily = await dailyHistory(env);
  if (!daily.points.length) {
   const observed=await rows(env.DB,'SELECT * FROM (SELECT observed_at AS at,price FROM gold_observations WHERE symbol=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at DESC LIMIT 3000) ORDER BY at','XAUUSD',start,now);
   return {...daily,points:observed,kind:'observed_spot',gapSeconds:1800,limitation:(daily.limitation||'Historical provider unavailable.')+' Showing only actual snapshots collected since setup; coverage may be incomplete.'};
  }
 return { ...daily, gapSeconds: 3 * 86400, points: daily.points.filter(p => p.at >= start && p.at <= now), limitation: daily.unavailable ? 'Historical provider is unavailable. Cached observations may be stale; retry later.' : daily.limitation };
 }
 const manual = await rows(env.DB, `SELECT s.effective_at AS at,s.price_paise/100.0 AS price FROM gold_spot_rates s WHERE s.market=? AND s.rate_type='SPOT' AND s.metal='GOLD' AND s.purity='24K' AND s.effective_at>=? AND s.effective_at<=? AND s.provenance='admin_verified' AND s.verified_at>0 AND s.verified_at<=? AND NOT EXISTS(SELECT 1 FROM gold_spot_rates c WHERE c.supersedes=s.id AND c.provenance='admin_verified' AND c.verified_at>0 AND c.effective_at<=? AND c.verified_at<=?) ORDER BY s.effective_at LIMIT 3000`, market, start, now, now, now, now);
 const reference = await rows(env.DB, `SELECT r.effective_at AS at,r.price_paise/100.0 AS price,s.name AS source FROM gold_reference_rates r JOIN gold_reference_sources s ON s.id=r.source_id WHERE r.market=? AND r.effective_at>=? AND r.effective_at<=? AND r.provenance='reference_verified' AND r.verified_at>0 AND r.verified_at<=? AND s.permission_verified_at>0 AND s.permission_verified_at<=? ORDER BY r.effective_at LIMIT 3000`, market, start, now, now, now);
 const recorded=await rows(env.DB,"SELECT effective_at AS at,price_paise/100.0 AS price FROM gold_spot_rates s WHERE market=? AND rate_type='SPOT' AND metal='GOLD' AND purity='24K' AND provenance='admin_verified' AND verified_at>0 AND verified_at<=? AND effective_at<=? AND NOT EXISTS(SELECT 1 FROM gold_spot_rates c WHERE c.supersedes=s.id AND c.provenance='admin_verified' AND c.verified_at>0 AND c.verified_at<=? AND c.effective_at<=?) ORDER BY effective_at",market,now,now,now,now);
 return { points: manual, reference, coverage:historyCoverage(recorded,now),stats:observationStats(manual),lastRecorded:lastRecordedRate(recorded), verified:true, demo:env.GOLD_DEMO_MODE==='true', kind: 'manual_spot', gapSeconds:null,maxDateGapDays:null,connectObservations:true, limitation: 'Manual bullion spot observations and permitted jewellery reference history are separate series. Lines connect actual recorded observations across missing periods; intermediate prices were not recorded. Curves are visual guides, not additional price observations. Longer ranges require recorded coverage.' };
}
export async function saveRates(env, body, actor) {
 const now = nowSeconds(), rates = validateSpotBatch(body, now);
 const statements = [],batchId=body.mode==='quick_paste'?crypto.randomUUID():null;
 if(batchId)statements.push(env.DB.prepare('INSERT INTO gold_rate_imports(id,source_name,raw_message,created_at,created_by,provenance) VALUES(?,?,?,?,?,?)').bind(batchId,body.source.trim(),body.rawMessage,now,actor,env.GOLD_DEMO_MODE==='true'?'test':'admin_verified'));
 for (const r of rates) {
  if(batchId){const existing=await env.DB.prepare('SELECT id FROM gold_spot_rates WHERE market=? AND rate_type=? AND metal=? AND purity=? AND effective_at=? LIMIT 1').bind(r.market,r.rateType,r.metal,r.purity,r.effectiveAt).first();if(existing)throw new GoldInputError('An observation already exists for this market, series and time. Use the audited correction workflow.',409);}
  if (r.supersedes) {
   const old = await env.DB.prepare('SELECT * FROM gold_spot_rates WHERE id=?').bind(r.supersedes).first();
   if (!old || old.market !== r.market || old.effective_at !== r.effectiveAt||old.rate_type!==r.rateType||old.metal!==r.metal||old.purity!==r.purity||old.quote_unit!==r.unit) throw new GoldInputError('A correction must retain the original market, series, unit and effective time');
  }
  const old=await env.DB.prepare("SELECT price_paise FROM gold_spot_rates WHERE market=? AND rate_type=? AND metal=? AND purity=? AND effective_at<=? AND provenance='admin_verified' ORDER BY effective_at DESC,created_at DESC LIMIT 1").bind(r.market,r.rateType,r.metal,r.purity,now).first();
  if (old?.price_paise && Math.abs(r.pricePaise-old.price_paise)/old.price_paise>.2&&body.confirmLargeChange!==true) throw new GoldInputError('Large price change: review and explicitly confirm before saving',409);
  statements.push(env.DB.prepare('INSERT INTO gold_spot_rates(id,market,price_paise,effective_at,created_at,created_by,supersedes,correction_reason,provenance,verified_at,rate_type,metal,purity,quote_unit,quoted_price_paise,source_name,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),r.market,r.pricePaise,r.effectiveAt,now,actor,r.supersedes,r.reason||null,env.GOLD_DEMO_MODE==='true'?'test':'admin_verified',env.GOLD_DEMO_MODE==='true'?null:now,r.rateType,r.metal,r.purity,r.unit,r.quotedPricePaise,r.source,batchId));
 }
 await env.DB.batch(statements); // D1 batch is atomic; unique correction constraint prevents competing revisions.
 return { saved: rates.length, scheduled: rates.filter(r => r.effectiveAt > now).length, testOnly:env.GOLD_DEMO_MODE==='true' };
}
export async function adminHistory(env) {
 return rows(env.DB, `SELECT s.*,CASE WHEN EXISTS(SELECT 1 FROM gold_spot_rates c WHERE c.supersedes=s.id) THEN 1 ELSE 0 END AS corrected FROM gold_spot_rates s ORDER BY created_at DESC,rowid DESC LIMIT 100`);
}
