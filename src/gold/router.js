import { summary, history, saveRates, adminHistory } from './service.js';
import { GoldInputError } from './core.js';
import {historicalSources,historicalRecords,historicalPreview,approveHistorical,rejectHistorical} from './historical.js';
export async function readGoldBody(request) {
 if(Number(request.headers.get('content-length'))>64000)throw new GoldInputError('Request too large',413);
 const reader=request.body?.getReader();if(!reader)throw new GoldInputError('Invalid JSON');
 const chunks=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>64000){await reader.cancel();throw new GoldInputError('Request too large',413);}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new GoldInputError('Invalid JSON');}
}
function json(data, status = 200, admin = false) {
 return Response.json(data, { status, headers: { 'Cache-Control': admin || status !== 200 ? 'no-store' : 'public,max-age=30', ...(admin ? {} : { 'Access-Control-Allow-Origin': '*' }), 'X-Content-Type-Options': 'nosniff' } });
}
async function sameSecret(a, b) {
 if (!a || !b) return false;
 const hash = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
 const [x,y] = await Promise.all([hash(a),hash(b)]); let diff = 0;
 for (let i=0;i<x.length;i++) diff |= x[i]^y[i]; return diff === 0;
}
export async function handleGold(request, env) {
 const url = new URL(request.url), admin = url.pathname.startsWith('/admin/');
 try {
  if (admin) {
   // A dedicated gold secret, when set, is the only one accepted here so the Admin Panel never holds the Worker-wide ADMIN_SECRET.
   if (!(await sameSecret(request.headers.get('X-Admin-Secret'), env.GOLD_ADMIN_SECRET || env.ADMIN_SECRET))) return json({ error: 'Unauthorized' },401,true);
   if(request.method==='GET'){
    if(url.pathname==='/admin/gold/history-imports')return json({sources:await historicalSources(env)},200,true);
    if(url.pathname==='/admin/gold/history-records')return json({records:await historicalRecords(env,url.searchParams.get('source'),Number(url.searchParams.get('offset')||0))},200,true);
    if(url.pathname==='/admin/gold/history-preview')return json(await historicalPreview(env,url.searchParams.get('source'),url.searchParams.get('market')||'CLT',url.searchParams.get('range')||'1H'),200,true);
   }
   if(['/admin/gold/history-approve','/admin/gold/history-reject'].includes(url.pathname)){
    if(request.method!=='POST')return json({error:'Method not allowed'},405,true);
    if(env.GOLD_WRITES_ENABLED!=='true')return json({error:'Gold rate writes are disabled for this environment'},403,true);
    try{return json(await (url.pathname.endsWith('history-reject')?rejectHistorical:approveHistorical)(env,await readGoldBody(request),request.headers.get('X-Gold-Actor')?.slice(0,128)||'admin'),201,true);}catch(e){if(/constraint|UNIQUE/i.test(e.message))throw new GoldInputError('An observation was already published. Refresh the review list.',409);throw e;}
   }
   if (url.pathname !== '/admin/gold/rates') return json({ error: 'Not found' },404,true);
   if (request.method === 'GET') return json({ rates: await adminHistory(env) },200,true);
   if (request.method !== 'POST') return json({ error: 'Method not allowed' },405,true);
   if (env.GOLD_WRITES_ENABLED !== 'true') return json({ error: 'Gold rate writes are disabled for this environment' },403,true);
   const body=await readGoldBody(request);
   try { return json(await saveRates(env, body, request.headers.get('X-Gold-Actor')?.slice(0,128) || 'admin'),201,true); }
   catch (e) { if(e instanceof GoldInputError)return json({error:e.message},e.status,true);if(/constraint|UNIQUE/i.test(e.message))return json({error:'This record changed already. Refresh before saving.'},409,true);throw e; }
  }
  if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS'}});
  if (request.method !== 'GET') return json({ error:'Method not allowed' },405);
  if (url.pathname === '/api/gold/summary') return json(await summary(env));
  if (url.pathname === '/api/gold/history') {
   try { return json(await history(env,url.searchParams.get('market') || 'CLT',url.searchParams.get('range') || (url.searchParams.get('kind')==='usa'?'1D':'1H'),url.searchParams.get('kind') || 'kerala')); }
   catch (e) { if (e instanceof GoldInputError) return json({error:e.message},e.status); throw e; }
  }
  return json({error:'Not found'},404);
 } catch(e) { if(e instanceof GoldInputError)return json({error:e.message},e.status,admin);return json({error:'Gold market data is unavailable. Please retry.',unavailable:true},503,admin); }
}
