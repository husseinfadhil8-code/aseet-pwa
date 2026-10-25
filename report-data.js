/* Complete bounded reads of existing account records; never publish partial totals.
 * Individual requests are not a transaction snapshot. RLS remains authoritative.
 */
const REPORT_PAGE_SIZE=200;
const REPORT_MAX_PAGES=50;
async function readReportRows(table,{repId=null,valid=()=>true}={}){
  if(!['sales','inquiries'].includes(table))throw new Error('Unexpected report table');
  const rows=[],seen=new Set();let cursor=null;
  for(let page=0;page<REPORT_MAX_PAGES;page++){
    if(!valid())return {data:[],stale:true};
    let query=db.from(table).select('*',{count:'exact'})
      .order('created_at',{ascending:false}).order('id',{ascending:false}).limit(REPORT_PAGE_SIZE);
    if(repId!==null){if(table!=='sales')throw new Error('Unexpected representative filter');query=query.eq('rep_id',repId);}
    if(cursor)query=query.or(pageCursorFilter(cursor));
    const result=await query;
    if(!valid())return {data:[],stale:true};
    if(result.error)throw result.error;
    const batch=result.data;
    const counted=Number.isInteger(result.count) && result.count>=0;
    if(!Array.isArray(batch) || (counted && result.count<batch.length)
      || (!batch.length && counted && result.count>0))throw new Error('Incomplete report page');
    // Validate every identity before accepting this page. A duplicate or broken
    // cursor must not replace a complete old ledger with misleading totals.
    for(const row of batch){
      pageCursorFilter(row);
      if(seen.has(row.id))throw new Error('Repeated report row');
      seen.add(row.id);
    }
    rows.push(...batch);
    if(!batch.length || (counted && result.count===batch.length))return {data:rows};
    cursor=batch.at(-1);
  }
  const error=new Error('Report exceeds safe page limit');error.code='REPORT_PAGE_LIMIT';throw error;
}
