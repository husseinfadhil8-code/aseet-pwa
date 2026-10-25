/* Bounded, stable keyset pages. Only public listing columns cross the API. */
const GOODS_FIELDS = 'id,title,description,area,asking_price,agreed_commission,status,created_by,created_at';
const GOODS_PAGE_SIZE = 40;
let marketGoods = null;
let marketCursor = null;
let marketHasMore = false;
let marketTotal = null;
let marketGeneration = 0;
let marketRequest = null;
let marketSearchTimer = null;
let marketNeedsReset = false;
function marketFilters() {
  return {search: String($('goodsSearch')?.value || '').trim(), status: $('goodsStatusFilter')?.value || 'available',
    category: $('goodsCategoryFilter')?.value || '', area: $('goodsAreaFilter')?.value || '', max: $('goodsMaxPrice')?.value || ''};
}
function literalSearch(text) {
  // JSON string quoting also escapes PostgREST quoted-literal delimiters.
  const escaped=text.replace(/[\\%_*]/g, char=>'\\'+char);
  return JSON.stringify('*'+escaped+'*');
}
function goodsPageQuery(filters, cursor) {
  let query = db.from('goods').select(GOODS_FIELDS, {count: 'exact'})
    .order('created_at', {ascending: false}).order('id', {ascending: false}).limit(GOODS_PAGE_SIZE);
  if (filters.status !== 'all') {
    if (!['available', 'reserved', 'sold', 'archived'].includes(filters.status)) throw new Error('حالة الغرض غير صحيحة.');
    query = query.eq('status', filters.status);
  }
  if (filters.search) query = query.or(['title', 'area', 'description'].map(field => `${field}.ilike.${literalSearch(filters.search)}`).join(','));
  if(filters.category==='غير مصنف')query=query.or('description.is.null,description.not.ilike.*الصنف:*');
  else if (filters.category) query = query.ilike('description', '%الصنف: ' + filters.category.replace(/[%_\\]/g, '\\$&') + '%');
  if(filters.area)query=query.ilike('area','%'+filters.area.replace(/[\\%_*]/g,char=>'\\'+char)+'%');
  if (filters.max) {
    const max = Number(filters.max);
    if (!Number.isSafeInteger(max) || max < 0) throw new Error('اكتب الحد الأعلى للسعر عدداً صحيحاً موجباً أو صفراً.');
    query = query.lte('asking_price', max);
  }
  if (cursor) query = query.or(pageCursorFilter(cursor));
  return query;
}
function updateGoodsPaging(message = '') {
  const busy=Boolean(marketRequest || marketSearchTimer);
  $('goodsList')?.setAttribute('aria-busy',String(busy));
  const button = $('loadMoreGoodsButton');
  if (button) {
    button.classList.toggle('hidden', !marketHasMore && !marketNeedsReset && !marketRequest && !marketSearchTimer);
    button.disabled = Boolean(marketRequest || marketSearchTimer);
    button.textContent = marketSearchTimer?'جارٍ البحث…':marketRequest ? 'جارٍ تحميل الأغراض…' : marketNeedsReset ? 'إعادة تحميل النتائج' : 'تحميل المزيد من الأغراض';
  }
  const status = $('marketPagingStatus');
  if (status) {status.textContent = message; status.classList.toggle('hidden', !message);}
}
function updateGoodsEmptyState(){
  const empty=$('emptyGoods');if(!empty)return;
  const visible=releaseVisibleGoods();
  empty.classList.toggle('hidden',visible.length>0);
  const filters=marketFilters();
  const filtered=filters.search || filters.max || filters.area || filters.category || filters.status!=='available';
  empty.textContent=filtered?'لا توجد أغراض تطابق الفلاتر الحالية. جرّب مسح الفلاتر أو تغيير البحث.':'لا توجد أغراض متاحة حالياً.';
}
async function loadMarketGoods({reset = false, clearCache = false} = {}) {
  if (!db || !currentUser || !profile) return;
  if(!reset && marketSearchTimer)return;
  // A failed filter refresh must restart from page one. The displayed rows and
  // cursor still belong to the previous successful query until this succeeds.
  if (!reset && marketNeedsReset && !marketRequest) reset = true;
  if (!reset && marketRequest) return marketRequest;
  if (!reset && !marketHasMore) return;
  if(reset){marketNeedsReset=true;clearTimeout(marketSearchTimer);marketSearchTimer=null;if(marketGoods===null)marketGoods=releaseVisibleGoods();}
  const generation = reset ? ++marketGeneration : marketGeneration;
  const actor=currentUser,role=profile.role,status=profile.status;
  const valid=()=>generation===marketGeneration && currentUser===actor && profile?.role===role && profile?.status===status;
  const filters = marketFilters();
  const cursor = reset ? null : marketCursor;
  const operation = (async () => {
    let result;try{result=await goodsPageQuery(filters,cursor);}catch(error){if(valid())throw error;return;}
    if(!valid())return;
    if (result.error) throw result.error;
    const rows=result.data||[];
    if(!Array.isArray(rows) || (Number.isInteger(result.count) && result.count<rows.length))throw new Error('Unexpected page count');
    if(!rows.length && Number.isInteger(result.count) && result.count>0)throw new Error('Unexpected empty page');
    // Validate before changing state; a malformed page must not poison the cursor.
    if (rows.length) pageCursorFilter(rows[rows.length - 1]);
    const previous = reset ? [] : (marketGoods || []);
    marketGoods = [...new Map([...previous, ...rows].map(row => [row.id, row])).values()];
    goods = [...new Map([...(clearCache ? [] : goods), ...rows].map(row => [row.id, row])).values()];
    marketCursor = rows.at(-1) || cursor;
    marketHasMore=rows.length>0 && (!Number.isInteger(result.count)||result.count>rows.length);
    if (reset) marketTotal = Number.isInteger(result.count) ? result.count : null;
    marketNeedsReset=false;
    render();
  })();
  marketRequest = operation; updateGoodsPaging();
  try {await operation;return true;} finally {
    if (generation === marketGeneration) {marketRequest = null; updateGoodsPaging();}
  }
}
window.loadMoreGoods=async function(){
  const actor=currentUser,operation=loadMarketGoods(),generation=marketGeneration;
  try{await operation;}catch(_){if(currentUser===actor && generation===marketGeneration)updateGoodsPaging('تعذّر تحميل النتائج. أعد المحاولة دون فقدان الأغراض السابقة.');}
};
window.scheduleGoodsSearch=function(){
  if(marketGoods===null){render();return;}
  clearTimeout(marketSearchTimer);marketTotal=null;marketNeedsReset=true;++marketGeneration;marketRequest=null;
  const actor=currentUser,generation=marketGeneration;
  marketSearchTimer=setTimeout(async()=>{
    marketSearchTimer=null;
    try{await loadMarketGoods({reset:true});}
    catch(_){if(currentUser===actor && marketGeneration===generation+1)updateGoodsPaging('تعذّر البحث. النتائج السابقة محفوظة؛ أعد المحاولة.');}
  },300);
  updateGoodsPaging('جارٍ البحث… تبقى النتائج السابقة حتى اكتماله.');
};
window.clearGoodsFilters=function(){
  for(const id of ['goodsSearch','goodsMaxPrice','goodsCategoryFilter','goodsAreaFilter']){
    const field=$(id);if(field)field.value='';
  }
  if($('goodsStatusFilter'))$('goodsStatusFilter').value='available';
  scheduleGoodsSearch();
};
function resetMarketSession(){
  ++marketGeneration;clearTimeout(marketSearchTimer);marketSearchTimer=null;marketRequest=null;
  marketGoods=null;marketCursor=null;marketTotal=null;marketHasMore=false;marketNeedsReset=false;updateGoodsPaging();
}
async function loadLinkedGoods(records,valid){
  // Preserve sale/inquiry labels when the referenced product is outside the current page.
  const known=new Set(goods.map(g=>String(g.id)));
  const ids=[...new Set(records.map(row=>row.goods_id).filter(id=>id && !known.has(String(id))))];
  let warning=false;
  const chunks=[];for(let i=0;i<ids.length;i+=100)chunks.push(ids.slice(i,i+100));
  for(let i=0;i<chunks.length;i+=4){
    await Promise.all(chunks.slice(i,i+4).map(async batch=>{
      let pending=batch;
      try{
        while(pending.length && valid()){
          const result=await db.from('goods').select(GOODS_FIELDS,{count:'exact'}).in('id',pending).limit(pending.length);
          if(!valid())return;if(result.error)throw result.error;
          const rows=result.data||[];
          // Do not overwrite a more recent active-page row with a linked-record response.
          const latest=new Set(goods.map(g=>String(g.id)));
          goods.push(...rows.filter(row=>!latest.has(String(row.id))));
          if(!rows.length || (Number.isInteger(result.count)&&result.count<=rows.length))break;
          const received=new Set(rows.map(row=>String(row.id)));const next=pending.filter(id=>!received.has(String(id)));
          if(next.length===pending.length){warning=true;break;}pending=next;
        }
      }catch(_){if(valid())warning=true;}
    }));
    if(!valid())return warning;
  }
  return warning;
}
