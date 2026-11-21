import test, {mock} from 'node:test';
// These tests record live snapshots, which only happens while XAU/USD trades: pin the clock to a Wednesday.
mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-18T15:00:00Z')});
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {estimateGold,validateSpotBatch,segmentHistory,istDay,nowSeconds,currentRate} from '../src/gold/core.js';
import {handleGold} from '../src/gold/router.js';
import {cached,history,liveQuote,marketRate,saveRates,summary,adminHistory} from '../src/gold/service.js';
function environment(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../migrations/005_gold_live.sql',import.meta.url),'utf8'));
 sqlite.exec(readFileSync(new URL('../migrations/006_gold_rate_provenance.sql',import.meta.url),'utf8'));
 sqlite.exec(readFileSync(new URL('../migrations/007_gold_quick_paste.sql',import.meta.url),'utf8'));
 const DB={
  prepare(sql){return {bind(...args){const stmt=sqlite.prepare(sql);return {async first(){return stmt.get(...args)||null},async all(){return {results:stmt.all(...args)}},async run(){return stmt.run(...args)}}}};},
  async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out}catch(e){sqlite.exec('ROLLBACK');throw e}}
 };
 return {DB,sqlite,ADMIN_SECRET:'test-only-secret',GOLD_WRITES_ENABLED:'true'};
}
test('a dedicated GOLD_ADMIN_SECRET replaces the Worker-wide secret for gold admin routes',async()=>{
 const env={...environment(),GOLD_ADMIN_SECRET:'gold-only-secret'};
 assert.equal((await handleGold(request('/admin/gold/rates','GET',undefined,'test-only-secret'),env)).status,401);
 assert.equal((await handleGold(request('/admin/gold/rates','GET',undefined,'gold-only-secret'),env)).status,200);
});
const row=(market='CLT',price='12140',at=nowSeconds()-60)=>({market,price,effectiveAt:new Date(at*1000).toISOString()});
const request=(path,method='GET',body,secret='test-only-secret')=>new Request('https://local.test'+path,{method,headers:{'X-Admin-Secret':secret,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
test('calculator covers all purities and rejects invalid/missing rates',()=>{for(const k of [24,22,18,14])assert.equal(estimateGold(10,k,12140),Math.round(121400*k/24*100)/100);for(const w of [0,-1,NaN,Infinity,100001])assert.equal(estimateGold(w,24,12140),null);assert.equal(estimateGold(10,20,12140),null);assert.equal(estimateGold(10,24,null),null)});
test('validation rejects malformed money, duplicate markets, missing timezone and null rows',()=>{for(const price of ['',0,-1,'1e4','NaN','12.345'])assert.throws(()=>validateSpotBatch({verified:true,rates:[row('CLT',price)]}));for(const rates of [[null],[row(),row()],[]])assert.throws(()=>validateSpotBatch({rates}));assert.throws(()=>validateSpotBatch({verified:true,rates:[{...row(),effectiveAt:'2026-11-19T10:42'}]}));assert.equal(validateSpotBatch({verified:true,rates:[row('CLT','12140.25')]})[0].pricePaise,1214025)});
test('IST date boundaries and gaps are retained',()=>{assert.equal(istDay(Date.parse('2026-11-18T18:31Z')/1000),'2026-11-19');assert.deepEqual(segmentHistory([{at:1},{at:2},{at:100}],10).map(g=>g.length),[2,1])});
test('a week-old price must not be presented as a daily change',()=>{const now=Date.parse('2026-11-19T08:00Z')/1000;const today={effective_at:now,price_paise:1214000,provenance:'admin_verified',verified_at:now},old={...today,effective_at:now-7*86400,price_paise:1200000};assert.equal(currentRate([today,old],[],now).change,null);assert.equal(currentRate([today,{...old,effective_at:now-86400}],[],now).change,140)});
test('unauthenticated/disabled writes fail closed and requests are bounded',async()=>{const env=environment();assert.equal((await handleGold(request('/admin/gold/rates','POST',{verified:true,rates:[row()]},'bad'),env)).status,401);env.GOLD_WRITES_ENABLED='false';assert.equal((await handleGold(request('/admin/gold/rates','POST',{verified:true,rates:[row()]}),env)).status,403);env.GOLD_WRITES_ENABLED='true';assert.equal((await handleGold(request('/admin/gold/rates','POST',{x:'a'.repeat(65000)}),env)).status,413);assert.equal((await handleGold(request('/admin/gold/rates','POST',{verified:true,rates:[null]}),env)).status,400);env.sqlite.close()});
test('D1-compatible SQL saves atomic batches, excludes future rates, retains corrections',async()=>{const env=environment(),at=nowSeconds()-60;await saveRates(env,{verified:true,rates:[row('CLT','12140',at),row('TCR','12120',nowSeconds()+3600)]},'test-admin');assert.equal((await marketRate(env.DB,'CLT')).price,12140);assert.equal((await marketRate(env.DB,'TCR')).price,null);const first=(await adminHistory(env)).find(r=>r.market==='CLT');await saveRates(env,{verified:true,rates:[{...row('CLT','12150',at),supersedes:first.id,reason:'Correcting a typo'}]},'test-editor');assert.equal((await marketRate(env.DB,'CLT')).price,12150);assert.equal((await adminHistory(env)).length,3);assert.equal((await history(env,'CLT','1D','kerala')).points.length,1);const conflict=await handleGold(request('/admin/gold/rates','POST',{verified:true,rates:[{...row('CLT','12160',at),supersedes:first.id,reason:'Second competing correction'}]}),env);assert.equal(conflict.status,409);assert.equal((await adminHistory(env)).length,3);env.sqlite.close()});
test('large changes need explicit confirmation and never partially save a batch',async()=>{const env=environment();await saveRates(env,{verified:true,rates:[row()]},'test');await assert.rejects(saveRates(env,{verified:true,rates:[row('TCR','12000'),row('CLT','30000')]},'test'),/Large price/);assert.equal((await adminHistory(env)).length,1);await saveRates(env,{verified:true,rates:[row('CLT','30000')],confirmLargeChange:true},'test');assert.equal((await adminHistory(env)).length,2);env.sqlite.close()});
test('today manual spot wins over licensed reference; missing dates remain missing',async()=>{const env=environment(),now=nowSeconds();env.sqlite.prepare('INSERT INTO gold_reference_sources VALUES(?,?,?,?,?)').run('demo','Test permitted reference','https://example.test','https://example.test/permission',now-100);env.sqlite.prepare('INSERT INTO gold_reference_rates(id,market,price_paise,effective_at,source_id,provenance,verified_at) VALUES(?,?,?,?,?,?,?)').run('ref','CLT',1200000,now-90,'demo','reference_verified',now-100);assert.equal((await marketRate(env.DB,'CLT')).kind,'jewellery_reference');await saveRates(env,{verified:true,rates:[row('CLT','12140',now-60)]},'test');const rate=await marketRate(env.DB,'CLT');assert.equal(rate.kind,'manual_spot');assert.equal(rate.change,null);const h=await history(env,'CLT','1M','kerala');assert.equal(h.points.length,1);assert.equal(h.reference.length,1);assert.equal((await marketRate(env.DB,'CBE')).price,null);env.sqlite.close()});
test('current quote caching and outage backoff preserve stale values',async()=>{const env=environment();let count=0;const loader=async()=>{count++;return {price:4120}};assert.equal((await cached(env,'test',30,loader,1000)).price,4120);await cached(env,'test',30,loader,1001);assert.equal(count,1);const failed=async()=>{count++;throw Error('upstream unavailable')};assert.equal((await cached(env,'test',30,failed,1031)).stale,true);await cached(env,'test',30,failed,1032);assert.equal(count,2);env.sqlite.close()});
test('xaus.com live quote, INR conversion and daily history need no key, share caches and keep real timestamps',async()=>{
 const env=environment(),original=globalThis.fetch,seen=[];
 const day=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10),updated=new Date(Date.now()-20000).toISOString();
 globalThis.fetch=async url=>{url=String(url);seen.push(url);
  if(url.includes('/history'))return Response.json({symbol:'XAUUSD',unit:'troy_oz',points:[{d:day(500),c:2000},{d:day(200),c:3900},{d:day(2),c:3550},{d:'bad',c:1},{d:day(1),c:-5}]});
  const inr=url.includes('currency=INR');
  return Response.json({xau:{price:inr?330000:3539,currency:inr?'INR':'USD',unit:'troy_oz'},spot_usd_oz:3539,fx_rate:93.25,updated_at:updated,data_state:{status:'fresh'}});};
 try{
  const s=await summary(env);
  assert.equal(s.usa.price,3539);assert.equal(s.usa.source,'xaus.com');assert.equal(s.usa.at,updated);assert.equal(s.usa.stale,false);
  assert.equal(s.fx.price,93.25);assert.match(s.fx.source,/xaus\.com/);
  await summary(env);assert.equal(seen.filter(u=>u.includes('/spot')).length,2);
  assert.ok(seen.every(u=>u.startsWith('https://xaus.com/api/v1/')));
  assert.equal((await history(env,'CLT','1D','usa')).points.length,1);
  const year=await history(env,'CLT','1Y','usa');
  assert.deepEqual(year.points.map(p=>p.price),[3900,3550]);assert.equal(year.source,'xaus.com');assert.equal(year.kind,'daily_close');
  assert.equal((await history(env,'CLT','6M','usa')).points.length,1);
  await history(env,'CLT','1M','usa');assert.equal(seen.filter(u=>u.includes('/history')).length,1);
 }finally{globalThis.fetch=original;env.sqlite.close()}});
test('gold-api.com serves the live quote when xaus.com fails; history falls back to recorded snapshots within budget',async()=>{
 const env=environment(),original=globalThis.fetch;let history_calls=0;
 globalThis.fetch=async url=>{url=String(url);
  if(url.startsWith('https://xaus.com')){if(url.includes('/history'))history_calls++;return new Response('',{status:429})}
  return Response.json({symbol:'XAU',currency:url.endsWith('/INR')?'INR':'USD',price:3541,exchangeRate:93.1,updatedAt:new Date().toISOString()});};
 try{
  const q=await liveQuote(env);assert.equal(q.price,3541);assert.equal(q.source,'gold-api.com');
  const h=await history(env,'CLT','1Y','usa');assert.equal(h.kind,'observed_spot');assert.equal(h.points.length,1);assert.match(h.limitation,/actual snapshots/);
  env.sqlite.exec('UPDATE gold_api_cache SET expires_at=0;UPDATE gold_provider_budget SET requests=8');
  await history(env,'CLT','1Y','usa');assert.equal(history_calls,1);
 }finally{globalThis.fetch=original;env.sqlite.close()}});
test('invalid ranges/types and internal database failures have safe statuses',async()=>{const env=environment();for(const query of ['kind=wrong','kind=usa&range=2Y','market=BAD'])assert.equal((await handleGold(request('/api/gold/history?'+query),env)).status,400);env.sqlite.exec('DROP TABLE gold_spot_rates');const response=await handleGold(request('/admin/gold/rates'),env);assert.equal(response.status,503);assert.doesNotMatch(JSON.stringify(await response.json()),/SQL|table|gold_spot_rates/);env.sqlite.close()});
