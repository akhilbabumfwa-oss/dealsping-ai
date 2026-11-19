// Preparation only. This tool never contacts a database or offers a remote flag.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const q=v=>v==null?'NULL':typeof v==='number'?(Number.isFinite(v)?String(v):'NULL'):"'"+String(v).replaceAll("'","''")+"'";
const insert=(table,cols,values)=>`INSERT OR IGNORE INTO ${table}(${cols}) VALUES(${values.map(q).join(',')});`;
export function stageSql(a){
 if(a.schemaVersion!==1||!/^[a-f0-9]{64}$/.test(a.source?.sha256)||!Array.isArray(a.rows)||!Array.isArray(a.records)||a.records.length>100000||a.summary.observations!==a.records.length||a.summary.sourceRows!==a.rows.length)throw Error('Invalid historical audit manifest');
 const source=a.source.sha256,now=Math.floor(Date.now()/1000),sql=['-- STAGING ONLY. Review required. Never publishes rates.'];
 sql.push(insert('gold_history_sources','id,filename,sha256,metadata_json,summary_json,sheets_json,imported_at,expected_rows,expected_records',[source,a.source.filename,source,JSON.stringify(a.source),JSON.stringify(a.summary),JSON.stringify(a.sheets),now,a.rows.length,a.records.length]));
 for(const r of a.rows)sql.push(insert('gold_history_rows','id,source_id,sheet,row_number,raw_cells_json',[r.id,source,r.sheet,r.row,JSON.stringify(r.cells)]));
 for(const r of a.records){
  if(!/^[a-f0-9]{64}$/.test(r.id)||!/^[a-f0-9]{64}$/.test(r.fingerprint)||!['accepted','pending_review','rejected','duplicate'].includes(r.status))throw Error('Invalid audited record');
  const cols='id,source_id,row_id,sheet,cell,field,kind,market,asset,purity,unit,original_date,original_time,timezone,observed_at,value_json,numeric_text,notes,flags_json,status,fingerprint';
  const values=[r.id,source,r.rowId,r.sheet,r.cell,r.field,r.kind,r.market,r.asset,r.purity,r.unit,r.date,r.time,r.timezone,r.at,JSON.stringify(r.value),r.numericValue,r.notes,JSON.stringify(r.flags)];
  sql.push(`INSERT OR IGNORE INTO gold_history_records(${cols}) SELECT ${values.map(q).join(',')},CASE WHEN EXISTS(SELECT 1 FROM gold_history_fingerprints WHERE fingerprint=${q(r.fingerprint)} AND record_id<>${q(r.id)}) THEN 'duplicate' ELSE ${q(r.status)} END,${q(r.fingerprint)};`);
  sql.push(insert('gold_history_fingerprints','fingerprint,record_id',[r.fingerprint,r.id]));
 }
 sql.push(`INSERT OR IGNORE INTO gold_history_completions(source_id,completed_at,row_count,record_count) SELECT ${q(source)},${now},${a.rows.length},${a.records.length} WHERE (SELECT COUNT(*) FROM gold_history_rows WHERE source_id=${q(source)})=${a.rows.length} AND (SELECT COUNT(*) FROM gold_history_records WHERE source_id=${q(source)})=${a.records.length};`);
 return sql.join('\n')+'\n';
}
if(import.meta.url===pathToFileURL(process.argv[1]).href){const [manifest,workbook,output]=process.argv.slice(2);if(!manifest||!workbook||!output)throw Error('Usage: node tools/stage-gold-history.mjs AUDIT.json ORIGINAL.xlsx OUTPUT.sql');const a=JSON.parse(fs.readFileSync(manifest,'utf8'));const sha=createHash('sha256').update(fs.readFileSync(workbook)).digest('hex');if(sha!==a.source.sha256)throw Error('Workbook hash does not match audit');fs.writeFileSync(output,stageSql(a));console.log(JSON.stringify({prepared:true,stagingOnly:true,source:sha,records:a.records.length,rows:a.rows.length,published:0}));}
