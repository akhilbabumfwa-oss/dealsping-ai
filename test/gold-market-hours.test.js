// Regression: on Sat 21 Nov 2026 the USA chart was a flat line at $3,539 from Friday's close.
// The providers repeat the last close with the request time as its timestamp, and the
// 10-minute cron stored each answer as a new observation.
import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {xauMarketOpen,lastXauTradingTime} from '../src/gold/core.js';
import {history,liveQuote,summary} from '../src/gold/service.js';
const s=iso=>Date.parse(iso)/1000;
const SATURDAY='2026-11-21T10:00:00Z',FRIDAY_CLOSE=s('2026-11-20T22:00:00Z');
function environment(){
 const sqlite=new DatabaseSync(':memory:');
 for(const f of ['005_gold_live.sql','006_gold_rate_provenance.sql','007_gold_quick_paste.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const DB={prepare(sql){return{bind(...args){const st=sqlite.prepare(sql);return{async first(){return st.get(...args)||null},async all(){return{results:st.all(...args)}},async run(){return st.run(...args)}}}}}};
 return {DB,sqlite};
}
const observe=(env,at,price)=>env.sqlite.prepare('INSERT INTO gold_observations(symbol,observed_at,price,source) VALUES(?,?,?,?)').run('XAUUSD',at,price,'xaus.com');
// xaus.com while the market is shut: the last close, stamped with the request time and marked fresh.
const repeatedClose=()=>async url=>{const inr=String(url).includes('currency=INR');return Response.json({xau:{price:inr?330000:3539,currency:inr?'INR':'USD',unit:'troy_oz'},spot_usd_oz:3539,fx_rate:93.25,updated_at:new Date().toISOString(),data_state:{status:'fresh'}});};
test('XAU/USD trading hours follow New York time, including the daily break and DST',()=>{
 for(const [iso,open] of [['2026-11-20T21:59:00Z',true],['2026-11-20T22:00:00Z',false],[SATURDAY,false],['2026-11-22T22:59:00Z',false],['2026-11-22T23:00:00Z',true],['2026-11-18T22:30:00Z',false],['2026-11-18T23:00:00Z',true],['2026-07-17T20:59:00Z',true],['2026-07-17T21:00:00Z',false],['2026-07-19T22:00:00Z',true]])assert.equal(xauMarketOpen(s(iso)),open,iso);
 assert.equal(lastXauTradingTime(s(SATURDAY)),FRIDAY_CLOSE-1);
 assert.equal(lastXauTradingTime(s('2026-11-18T15:00:00Z')),s('2026-11-18T15:00:00Z'));
});
test('while the market is shut, repeated provider quotes are not stored and the quote reads closed',async t=>{
 mock.timers.enable({apis:['Date'],now:Date.parse(SATURDAY)});t.after(()=>mock.timers.reset());
 const env=environment(),original=globalThis.fetch;globalThis.fetch=repeatedClose();
 try{
  const q=await liveQuote(env);
  assert.equal(q.price,3539);assert.equal(q.marketStatus,'closed');
  assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM gold_observations').get().n,0);
 }finally{globalThis.fetch=original;env.sqlite.close()}
});
test('on a weekend the 1H/1D charts show the last session, without the flat repeated-close rows',async t=>{
 mock.timers.enable({apis:['Date'],now:Date.parse(SATURDAY)});t.after(()=>mock.timers.reset());
 const env=environment(),original=globalThis.fetch;globalThis.fetch=repeatedClose();
 try{
  observe(env,s('2026-11-19T21:30:00Z'),3500);                 // Thursday close
  observe(env,FRIDAY_CLOSE-1800,3530);observe(env,FRIDAY_CLOSE-600,3538.82);
  for(let at=FRIDAY_CLOSE+600;at<s(SATURDAY);at+=600)observe(env,at,3539); // rows the old cron wrote
  const day=await history(env,'CLT','1D','usa');
  assert.deepEqual(day.points.map(p=>p.price),[3530,3538.82]);
  assert.equal(day.marketClosed,true);assert.match(day.limitation,/Market closed/);
  assert.deepEqual((await history(env,'CLT','1H','usa')).points.map(p=>p.price),[3530,3538.82]);
  // The daily change is Friday's move against Thursday's close, not +0.00%.
  const sum=await summary(env);
  assert.equal(sum.usa.marketStatus,'closed');assert.equal(Math.round(sum.usa.change*100)/100,39);
 }finally{globalThis.fetch=original;env.sqlite.close()}
});
