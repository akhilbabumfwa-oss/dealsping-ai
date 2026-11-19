export const MARKETS = ['CLT', 'TCR', 'EKM', 'PGT', 'CBE', 'MUM'];
export const PERIODS = { '1H': 3600, '1D': 86400, '1W': 604800, '1M': 2592000, '3M': 7776000, '6M': 15552000, '1Y': 31536000 };
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export class GoldInputError extends Error { constructor(message, status=400) { super(message); this.status=status; } }
export const istDay = seconds => new Date((seconds + 19800) * 1000).toISOString().slice(0, 10);
export function estimateGold(weight, purity, rate) {
 if (!Number.isFinite(weight) || weight <= 0 || weight > 100000 || ![24,22,18,14].includes(purity) || !Number.isFinite(rate) || rate <= 0) return null;
 return Math.round(weight * rate * purity / 24 * 100) / 100;
}
export function validateSpotBatch(input, now = nowSeconds()) {
 const quick=input?.mode==='quick_paste';
 if(input?.mode!==undefined&&!quick)throw new GoldInputError('Unsupported import mode');
 if (!Array.isArray(input?.rates) || !input.rates.length || input.rates.length > (quick?120:6)) throw new GoldInputError(quick?'Enter one to 120 observations':'Enter one to six market rates');
 const source=String(input.source||'').trim();
 if(quick&&(input.confirmMetadata!==true||source.length<3||source.length>240||typeof input.rawMessage!=='string'||!input.rawMessage.trim()||input.rawMessage.length>12000))throw new GoldInputError('Confirm the source, date/time, purity and units before publishing');
 if(input.verified!==true)throw new GoldInputError('Confirm that the bullion spot observations have been verified');
 const markets = new Set();
 return input.rates.map(row => {
  if (!row || !MARKETS.includes(row.market)) throw new GoldInputError('Use supported markets');
  const rateType=quick?row.rateType:'SPOT',metal=quick?row.metal:'GOLD',purity=quick?row.purity:'24K',unit=quick?row.unit:'INR/g';
  if(!quick&&((row.rateType&&row.rateType!=='SPOT')||(row.metal&&row.metal!=='GOLD')||(row.purity&&row.purity!=='24K')||(row.unit&&row.unit!=='INR/g')))throw new GoldInputError('Use Quick Paste with explicit metadata for non-24K spot rates');
  const grams={'INR/g':1,'INR/8g':8,'INR/10g':10,'INR/kg':1000}[unit];
  if(!['SPOT','RTGS'].includes(rateType)||!['GOLD','SILVER'].includes(metal)||!(metal==='GOLD'?['24K','22K','18K']:['999','925']).includes(purity)||!grams)throw new GoldInputError('Every observation requires an explicit rate type, metal, purity and INR unit');
  if(quick&&row.supersedes)throw new GoldInputError('Quick Paste appends new observations; use the correction workflow for revisions');
  if(!quick&&markets.has(row.market))throw new GoldInputError('Use unique supported markets');
  if(!quick)markets.add(row.market);
  // Decimal money is converted once; missing/blank/zero values never become a valid rate.
  const raw = String(row.price ?? '');
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) throw new GoldInputError('Enter a positive INR rate with at most two decimals');
  const quotedPricePaise=Math.round(Number(raw)*100),pricePaise = Math.round(quotedPricePaise/grams);
  if (!Number.isSafeInteger(quotedPricePaise)||quotedPricePaise>100000000000||pricePaise <= 0 || pricePaise > 100000000) throw new GoldInputError('Rate is outside the supported range');
  const date=String(row.effectiveAt).slice(0,10),dayMs=Date.parse(date+'T00:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(dayMs)||new Date(dayMs).toISOString().slice(0,10)!==date)throw new GoldInputError('Invalid observation date');
  const ms = Date.parse(row.effectiveAt);
  if (!Number.isFinite(ms) || !/(Z|[+-]\d\d:\d\d)$/.test(String(row.effectiveAt))) throw new GoldInputError('Effective time must include its timezone');
  const effectiveAt = Math.floor(ms / 1000);
  if(quick){const key=[row.market,rateType,metal,purity,effectiveAt].join('|');if(markets.has(key))throw new GoldInputError('Duplicate observation in this batch');markets.add(key);}
  if (effectiveAt < now - 366 * 86400 || effectiveAt > now + 7 * 86400) throw new GoldInputError('Effective time must be within the past year or next seven days');
  const supersedes = row.supersedes || null;
  const reason = String(row.reason || '').trim();
  if (supersedes && (!/^[\w-]{1,80}$/.test(supersedes) || reason.length < 8 || reason.length > 1000)) throw new GoldInputError('Corrections require a record ID and a reason (8–1000 characters)');
  return { market: row.market, pricePaise, quotedPricePaise,rateType,metal,purity,unit,source:quick?source:'Manual bullion spot',effectiveAt, supersedes, reason };
 });
}
export function currentRate(spots, references, now = nowSeconds()) {
 const verified=(r,kind)=>r.provenance===kind&&Number.isFinite(r.verified_at)&&r.verified_at>0&&r.verified_at<=now;
 const valid = spots.filter(r => r.effective_at <= now&&verified(r,'admin_verified'));
 references=references.filter(r=>verified(r,'reference_verified'));
 const today = valid.find(r => istDay(r.effective_at) === istDay(now));
 const reference = references.find(r => r.effective_at <= now && istDay(r.effective_at) === istDay(now));
 const row = today || reference || valid[0] || references.find(r => r.effective_at <= now);
 if (!row) return null;
 const kind = valid.includes(row) ? 'manual_spot' : 'jewellery_reference';
 const previousDay=istDay(row.effective_at-86400);
 const previous = (kind === 'manual_spot' ? valid : references).find(r => r.effective_at < row.effective_at && istDay(r.effective_at) === previousDay);
 return { price: row.price_paise / 100, kind, source: row.source_name || 'Manual bullion spot', label:kind==='manual_spot'?'Manual Update':'Jewellery reference',at: new Date(row.effective_at * 1000).toISOString(), verified:true,provenance:row.provenance,verifiedAt:new Date(row.verified_at*1000).toISOString(),stale: istDay(row.effective_at) !== istDay(now), change: previous ? (row.price_paise - previous.price_paise) / 100 : null };
}
// Preserve actual gaps. Manual observations must never be smoothed into invented history.
export function segmentHistory(points, maxGapSeconds) {
 const groups = [];
 for (const point of points) {
  const group = groups.at(-1);
  if (!group || point.at - group.at(-1).at > maxGapSeconds) groups.push([point]);
  else group.push(point);
 }
 return groups;
}
