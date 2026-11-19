import {GoldInputError,MARKETS,PERIODS,nowSeconds,validateSpotBatch} from './core.js';
const list=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results||[];
export function checkedSource(id){if(!/^[a-f0-9]{64}$/.test(id||''))throw new GoldInputError('Invalid historical source');return id;}
export function historyCoverage(points,now=nowSeconds()){
 const ordered=points.filter(p=>Number.isFinite(p.at)&&Number.isFinite(p.price)&&p.price>0&&p.at<=now).sort((a,b)=>a.at-b.at);
 const availableRanges=Object.entries(PERIODS).filter(([,seconds])=>ordered.some(p=>p.at>=now-seconds)).map(([range])=>range);
 return {firstAt:ordered[0]?.at??null,lastAt:ordered.at(-1)?.at??null,observationCount:ordered.length,availableRanges,recordedSpanSeconds:ordered.length>1?ordered.at(-1).at-ordered[0].at:0};
}
export function observationStats(points){const p=points.filter(x=>Number.isFinite(x.price)&&Number.isFinite(x.at)).sort((a,b)=>a.at-b.at);return {high:p.length?Math.max(...p.map(x=>x.price)):null,low:p.length?Math.min(...p.map(x=>x.price)):null,change:p.length>1?p.at(-1).price-p[0].price:null,changeBasis:'Last minus first actual observation in the selected range'};}
export function lastRecordedRate(points){
 const valid=points.filter(p=>Number.isFinite(p.at)&&Number.isFinite(p.price)&&p.price>0).sort((a,b)=>a.at-b.at),last=valid.at(-1);
 if(!last)return null;
 const previous=valid.findLast(p=>p.at<last.at);
 return {price:last.price,at:new Date(last.at*1000).toISOString(),change:previous?last.price-previous.price:null,changeBasis:'Previous recorded comparable SPOT observation; not necessarily the previous day',kind:'historical_recorded',verified:false,stale:true,purity:'24K',unit:'INR/g',rateType:'SPOT',sheet:last.sheet,cell:last.cell,label:'Last Recorded Rate — Historical, Not Live'};
}
async function sourceReady(db,source){checkedSource(source);if(!await db.prepare('SELECT source_id FROM gold_history_completions WHERE source_id=?').bind(source).first())throw new GoldInputError('Historical import is incomplete or unavailable',404);}
export async function historicalSources(env){const sources=await list(env.DB,'SELECT s.*,c.completed_at FROM gold_history_sources s LEFT JOIN gold_history_completions c ON c.source_id=s.id ORDER BY s.imported_at DESC');return sources.map(s=>({id:s.id,filename:s.filename,sha256:s.sha256,complete:!!s.completed_at,summary:JSON.parse(s.summary_json),metadata:JSON.parse(s.metadata_json)}));}
export async function historicalRecords(env,source,offset=0){await sourceReady(env.DB,source);if(!Number.isInteger(offset)||offset<0||offset>100000)throw new GoldInputError('Invalid record offset');const records=await list(env.DB,`SELECT r.*,COALESCE(d.decision,CASE WHEN x.record_id IS NOT NULL THEN 'reject' END) AS decision,COALESCE(d.provenance,x.provenance) AS decision_provenance,x.reason AS rejection_reason FROM gold_history_records r LEFT JOIN gold_history_decisions d ON d.record_id=r.id LEFT JOIN gold_history_rejections x ON x.record_id=r.id WHERE r.source_id=? ORDER BY CASE r.status WHEN 'accepted' THEN 0 ELSE 1 END,r.kind DESC,r.observed_at,r.cell LIMIT 100 OFFSET ?`,source,offset);return records.map(r=>({...r,value:JSON.parse(r.value_json),flags:JSON.parse(r.flags_json)}));}
export async function historicalPreview(env,source,market,range){
 await sourceReady(env.DB,source);if(!MARKETS.includes(market)||!Object.hasOwn(PERIODS,range))throw new GoldInputError('Invalid historical market or range');
 const now=nowSeconds();const all=await list(env.DB,"SELECT observed_at AS at,CAST(numeric_text AS REAL) AS price,cell,sheet FROM gold_history_records WHERE source_id=? AND kind='SPOT' AND asset='GOLD' AND purity='24K' AND unit='INR/g' AND market=? AND status='accepted' AND observed_at<=? AND NOT EXISTS(SELECT 1 FROM gold_history_rejections x WHERE x.record_id=gold_history_records.id) ORDER BY observed_at",source,market,now);
 const points=all.filter(p=>p.at>=now-PERIODS[range]);return {points,reference:[],coverage:historyCoverage(all,now),stats:observationStats(points),lastRecorded:lastRecordedRate(all),gapSeconds:null, maxDateGapDays:null,connectObservations:true,preview:true,verified:false,kind:'historical_review',limitation:'LOCAL REVIEW ONLY — unverified workbook observations. Original timestamps preserved. The line connects recorded observations across missing periods; intermediate prices were not recorded. These records are not published live rates.'};
}
export async function approveHistorical(env,body,actor){
 const source=checkedSource(body?.source);await sourceReady(env.DB,source);
 if(body?.confirmPublication!==true||body?.verified!==true||body?.confirmMetadata!==true||!Array.isArray(body.recordIds)||!body.recordIds.length||body.recordIds.length>120||new Set(body.recordIds).size!==body.recordIds.length)throw new GoldInputError('Explicitly review and confirm 1–120 unique observations before publishing');
 if(body.recordIds.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw new GoldInputError('Invalid historical record');
 // Bound parameters stay below 100; bulk preflight also fits the free D1 query budget.
 const found=[],reviewed=[];
 for(let i=0;i<body.recordIds.length;i+=40){const ids=body.recordIds.slice(i,i+40),slots=ids.map(()=>'?').join(',');found.push(...await list(env.DB,`SELECT * FROM gold_history_records WHERE source_id=? AND id IN (${slots})`,source,...ids));reviewed.push(...await list(env.DB,`SELECT record_id FROM gold_history_decisions WHERE record_id IN (${slots}) UNION ALL SELECT record_id FROM gold_history_rejections WHERE record_id IN (${slots})`,...ids,...ids));}
 if(reviewed.length)throw new GoldInputError('Observation already reviewed',409);
 const byId=new Map(found.map(r=>[r.id,r])),selected=body.recordIds.map(id=>byId.get(id));
 if(selected.some(r=>!r||r.status!=='accepted'||!['SPOT','RTGS'].includes(r.kind)||r.asset!=='GOLD'||r.purity!=='24K'||r.unit!=='INR/g'||r.timezone!=='Asia/Kolkata'||JSON.parse(r.flags_json).length))throw new GoldInputError('Only accepted, fully specified city SPOT/RTGS observations can be published');
 const times=selected.map(r=>r.observed_at),markets=[...new Set(selected.map(r=>r.market))];
 const existing=await list(env.DB,`SELECT market,rate_type,effective_at FROM gold_spot_rates WHERE metal='GOLD' AND purity='24K' AND effective_at>=? AND effective_at<=? AND market IN (${markets.map(()=>'?').join(',')})`,Math.min(...times),Math.max(...times),...markets);
 const keys=new Set(existing.map(r=>[r.market,r.rate_type,r.effective_at].join('|')));
 if(selected.some(r=>keys.has([r.market,r.kind,r.observed_at].join('|'))))throw new GoldInputError('An observation already exists for this series/time; use an audited correction',409);
 const now=nowSeconds(),provenance=env.GOLD_DEMO_MODE==='true'?'test':'admin_verified';
 const rates=validateSpotBatch({mode:'quick_paste',verified:true,confirmMetadata:true,source:'Historical workbook '+source.slice(0,12),rawMessage:'Manually reviewed historical workbook observations',rates:selected.map(r=>({market:r.market,rateType:r.kind,metal:r.asset,purity:r.purity,unit:r.unit,price:r.numeric_text,effectiveAt:new Date(r.observed_at*1000).toISOString()}))},now);
 const statements=[];
 for(let i=0;i<rates.length;i++){const r=rates[i],original=selected[i],id=crypto.randomUUID();statements.push(env.DB.prepare('INSERT INTO gold_spot_rates(id,market,price_paise,effective_at,created_at,created_by,provenance,verified_at,rate_type,metal,purity,quote_unit,quoted_price_paise,source_name,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,r.market,r.pricePaise,r.effectiveAt,now,actor,provenance,provenance==='test'?null:now,r.rateType,r.metal,r.purity,r.unit,r.quotedPricePaise,'Historical Excel observation — manually approved',source));statements.push(env.DB.prepare('INSERT INTO gold_history_decisions(id,record_id,spot_id,reviewed_at,reviewed_by,decision,provenance) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),original.id,id,now,actor,'approve',provenance));}
 await env.DB.batch(statements);return {saved:rates.length,testOnly:provenance==='test'};
}

export async function rejectHistorical(env,body,actor){
 const source=checkedSource(body?.source);await sourceReady(env.DB,source);
 const ids=body?.recordIds,reason=typeof body?.reason==='string'?body.reason.trim():'';
 if(body?.confirmRejection!==true||!Array.isArray(ids)||!ids.length||ids.length>120||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))||reason.length<8||reason.length>1000)throw new GoldInputError('Confirm 1–120 unique observations and give a rejection reason (8–1000 characters)');
 const found=[],reviewed=[];
 for(let i=0;i<ids.length;i+=40){const chunk=ids.slice(i,i+40),slots=chunk.map(()=>'?').join(',');found.push(...await list(env.DB,`SELECT id FROM gold_history_records WHERE source_id=? AND id IN (${slots})`,source,...chunk));reviewed.push(...await list(env.DB,`SELECT record_id FROM gold_history_decisions WHERE record_id IN (${slots}) UNION ALL SELECT record_id FROM gold_history_rejections WHERE record_id IN (${slots})`,...chunk,...chunk));}
 if(found.length!==ids.length)throw new GoldInputError('Observation is not in this source');
 if(reviewed.length)throw new GoldInputError('Observation already reviewed',409);
 const now=nowSeconds(),provenance=env.GOLD_DEMO_MODE==='true'?'test':'admin_verified';
 await env.DB.batch(ids.map(id=>env.DB.prepare('INSERT INTO gold_history_rejections(record_id,reviewed_at,reviewed_by,reason,provenance) VALUES(?,?,?,?,?)').bind(id,now,actor,reason,provenance)));
 return {rejected:ids.length,testOnly:provenance==='test'};
}
