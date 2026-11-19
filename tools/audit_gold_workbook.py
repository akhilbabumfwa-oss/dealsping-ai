"""Read-only workbook audit. No recalculation, writes to Excel, network or DB access."""
import argparse, collections, datetime as dt, hashlib, json, math, statistics
from decimal import Decimal
from pathlib import Path
import openpyxl

IST=dt.timezone(dt.timedelta(hours=5,minutes=30))
MARKETS={'CLT','TCR','EKM','PGT','CBE','MUM'}
def scalar(v):
    if isinstance(v,(dt.datetime,dt.date,dt.time)): return v.isoformat()
    return v
def digest(v): return hashlib.sha256(json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def audit(path, confirmed=False, now=None):
    now=now or dt.datetime.now(dt.timezone.utc)
    raw=Path(path).read_bytes();sha=hashlib.sha256(raw).hexdigest()
    w=openpyxl.load_workbook(path,data_only=False,keep_links=False)
    cached=openpyxl.load_workbook(path,data_only=True,keep_links=False)
    rows=[];records=[];missing=[];sheets=[];formulas=[]
    for sheet in w:
        headers=[str(c.value or '').strip() for c in sheet[1]]
        count=0
        for values in sheet.iter_rows(min_row=2):
            if all(c.value is None for c in values):continue
            cells={c.coordinate:{'value':scalar(c.value),'type':c.data_type,'format':c.number_format} for c in values}
            row={headers[i]:scalar(c.value) for i,c in enumerate(values)}
            row_id=digest([sha,sheet.title,values[0].row]);rows.append({'id':row_id,'sheet':sheet.title,'row':values[0].row,'cells':cells});count+=1
            date=str(row.get('Date') or '').strip();time=str(row.get('Time') or '').strip()
            notes=str(row.get('Note') or row.get('Change / Note') or '')
            for c,header in zip(values,headers):
                if header in ('Date','Time','Note','Change / Note') or not header:continue
                if c.value is None:
                    missing.append({'sheet':sheet.title,'cell':c.coordinate,'date':date,'field':header});continue
                value=scalar(c.value);is_number=isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)
                kind='OTHER';market=None;asset=header;purity=None;unit=None
                if sheet.title=='SPOT Rates':
                    if header in MARKETS:kind='SPOT';market=header;asset='GOLD';purity='24K' if confirmed else None;unit='INR/g' if confirmed else None
                    elif header.startswith('RTGS '):kind='RTGS';market=header[5:].strip();asset='GOLD';purity='24K' if confirmed else None;unit='INR/g' if confirmed else None
                    elif header=='INR':kind='CURRENCY'
                    else:kind='COMMODITY'
                elif sheet.title=='Kerala Gold Rate':
                    kind='RETAIL';market='KERALA';asset='SILVER' if 'Silver' in header else 'GOLD'
                    purity={'Gram (22K)':'22K','18k/750':'18K','14k':'14K','9k':'9K'}.get(header)
                    unit='currency/g' if header in ['Gram (22K)','Silver /g'] else 'Pavan' if header=='Pavan' else None
                elif sheet.title=='Market Open':kind='MARKET_OPEN'
                elif sheet.title=='Currency':kind='CURRENCY'
                measure='change' if 'Change' in header else 'high' if header.endswith(' HI') else 'low' if header.endswith(' LO') else 'price'
                flags=[];timestamp=None
                try:
                    day=dt.date.fromisoformat(date)
                    if not dt.date(2026,10,19)<=day<=dt.date(2026,11,19):flags.append('Outside supplied date interval')
                    if time:
                        parsed=dt.time.fromisoformat(time)
                        if not confirmed:flags.append('Timezone not confirmed')
                        else:
                            timestamp=int(dt.datetime.combine(day,parsed,IST).timestamp())
                            if timestamp>now.timestamp():flags.append('Observation is in the future at audit time')
                    else:flags.append('Observation time missing; no midnight invented')
                except ValueError:flags.append('Invalid original date or time')
                if c.data_type=='f':
                    formulas.append({'sheet':sheet.title,'cell':c.coordinate,'formula':c.value,'cached':scalar(cached[sheet.title][c.coordinate].value)})
                    flags.append('Formula value requires review; not recalculated')
                if not is_number:flags.append('Non-numeric or compound quote; not split or guessed')
                elif value<=0 and measure!='change':flags.append('Non-positive price/value')
                if kind in ('SPOT','RTGS'):
                    if not purity:flags.append('Purity not specified')
                    if not unit:flags.append('Currency/unit not specified')
                    if market not in MARKETS:flags.append('Unsupported market for spot publishing')
                    if is_number and Decimal(str(value)).as_tuple().exponent < -2:flags.append('Quoted precision exceeds two decimals; not rounded')
                else:flags.append('Separate '+kind.lower()+' series; not a 24K bullion spot quote')
                if unit in (None,'currency/g','Pavan'):flags.append('Full quote currency/unit not confirmed')
                if asset=='SILVER' and not purity:flags.append('Silver fineness missing')
                record={'id':digest([sha,sheet.title,c.coordinate]),'rowId':row_id,'sheet':sheet.title,'cell':c.coordinate,'field':header,'kind':kind,'measure':measure,'market':market,'asset':asset,'purity':purity,'unit':unit,'date':date,'time':time or None,'timezone':'Asia/Kolkata' if confirmed and time else None,'at':timestamp,'value':value,'numericValue':str(value) if is_number else None,'notes':notes,'flags':flags}
                record['fingerprint']=digest({k:record[k] for k in ['sheet','field','kind','market','asset','purity','unit','date','time','value']})
                records.append(record)
        sheets.append({'name':sheet.title,'state':sheet.sheet_state,'rows':count,'columns':headers,'dimensions':sheet.calculate_dimension()})
    # Identify conflicting same-series/timestamp quotes without choosing a winner.
    groups=collections.defaultdict(list);seen={}
    for r in records:
        key=tuple(r[k] for k in ['sheet','field','kind','market','date','time'])
        groups[key].append(r)
    for group in groups.values():
        if len({str(r['value']) for r in group})>1:
            for r in group:r['flags'].append('Conflicting values for the same series and timestamp')
    series=collections.defaultdict(list)
    for r in records:
        if r['numericValue'] is not None and r['measure']!='change':series[(r['sheet'],r['field'])].append(r)
    anomalies=[]
    for group in series.values():
        group.sort(key=lambda r:(r['date'],r['time'] or ''))
        for a,b in zip(group,group[1:]):
            av,bv=float(a['numericValue']),float(b['numericValue'])
            if av>0 and abs(bv-av)/av>.10:
                flag='More than 10% change from preceding recorded value'
                b['flags'].append(flag);anomalies.append({'sheet':b['sheet'],'cell':b['cell'],'priorCell':a['cell'],'priorValue':a['value'],'value':b['value'],'reason':flag})
    by_row=collections.defaultdict(list)
    for r in records:by_row[r['rowId']].append(r)
    for group in by_row.values():
        local=[r for r in group if r['kind']=='SPOT' and r['market'] in ['CLT','TCR','EKM','PGT'] and r['numericValue'] is not None]
        if len(local)>=3:
            median=statistics.median(float(r['numericValue']) for r in local)
            for r in local:
                if median>0 and abs(float(r['numericValue'])-median)/median>.05:
                    flag='More than 5% away from the same-row Kerala-city median';r['flags'].append(flag);anomalies.append({'sheet':r['sheet'],'cell':r['cell'],'value':r['value'],'comparison':median,'reason':flag})
        retail={r['field']:r for r in group if r['kind']=='RETAIL' and r['numericValue'] is not None}
        if 'Gram (22K)' in retail and 'Pavan' in retail and float(retail['Pavan']['numericValue'])!=8*float(retail['Gram (22K)']['numericValue']):
            for r in [retail['Gram (22K)'],retail['Pavan']]:r['flags'].append('Pavan/gram relationship differs from the workbook usual 8x pattern; units not inferred')
    for r in records:
        if r['fingerprint'] in seen:r['status']='duplicate';r['duplicateOf']=seen[r['fingerprint']]
        elif any(f.startswith(('Invalid original','Non-positive')) for f in r['flags']):r['status']='rejected'
        elif r['flags']:r['status']='pending_review'
        else:r['status']='accepted'
        seen.setdefault(r['fingerprint'],r['id'])
    counts=collections.Counter(r['status'] for r in records)
    counts={s:counts[s] for s in ['accepted','rejected','duplicate','pending_review']}
    coverage={}
    for kind in sorted({r['kind'] for r in records}):
        rs=[r for r in records if r['kind']==kind];days=sorted({r['date'] for r in rs})
        coverage[kind]={'records':len(rs),'dateFrom':days[0],'dateTo':days[-1],'dates':days,'missingDates':[(dt.date(2026,10,19)+dt.timedelta(days=i)).isoformat() for i in range(32) if (dt.date(2026,10,19)+dt.timedelta(days=i)).isoformat() not in days]}
    return {'schemaVersion':1,'source':{'filename':Path(path).name,'sha256':sha,'sizeBytes':len(raw),'auditedAt':now.isoformat(),'spotMetadataConfirmed':confirmed,'confirmation':'User confirmed SPOT/RTGS 24K INR/g and all recorded times IST' if confirmed else None},'sheets':sheets,'rows':rows,'records':records,'missingCells':missing,'formulas':formulas,'anomalies':anomalies,'summary':{'sourceRows':len(rows),'observations':len(records),'counts':counts,'bySheet':{s['name']:dict(collections.Counter(r['status'] for r in records if r['sheet']==s['name'])) for s in sheets},'byKind':coverage,'missingCells':len(missing),'formulas':len(formulas),'suspicious':len(anomalies)}}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('source');p.add_argument('--outdir',required=True);p.add_argument('--confirm-spot-metadata',action='store_true');a=p.parse_args()
    result=audit(a.source,a.confirm_spot_metadata);out=Path(a.outdir);out.mkdir(parents=True,exist_ok=True)
    (out/'workbook-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'audit-summary.json').write_text(json.dumps(result['summary'],ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'source':result['source'],'sheets':result['sheets'],'summary':result['summary'],'anomalies':result['anomalies']},ensure_ascii=False))
