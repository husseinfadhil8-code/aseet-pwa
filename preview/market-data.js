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
function marketFilters() {
  return {search: String($('goodsSearch')?.value || '').trim(), status: $('goodsStatusFilter')?.value || 'available',
    category: $('goodsCategoryFilter')?.value || '', area: $('goodsAreaFilter')?.value || '', max: $('goodsMaxPrice')?.value || ''};
}
function pageCursorFilter(cursor) {
  if (!cursor || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)
    || !/^[0-9T:.+Z-]+$/.test(cursor.created_at) || !Number.isFinite(Date.parse(cursor.created_at))) throw new Error('تعذّر قراءة مؤشر الصفحة. حدّث البيانات.');
  return `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`;
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
  if (filters.category) query = query.ilike('description', '%الصنف: ' + filters.category.replace(/[%_\\]/g, '\\$&') + '%');
  if (filters.area) query = query.eq('area', filters.area);
  if (filters.max) {
    const max = Number(filters.max);
    if (!Number.isSafeInteger(max) || max < 0) throw new Error('اكتب الحد الأعلى للسعر عدداً صحيحاً موجباً أو صفراً.');
    query = query.lte('asking_price', max);
  }
  if (cursor) query = query.or(pageCursorFilter(cursor));
  return query;
}
function updateGoodsPaging(message = '') {
  const button = $('loadMoreGoodsButton');
  if (button) {
    button.classList.toggle('hidden', !marketHasMore && !marketRequest);
    button.disabled = Boolean(marketRequest);
    button.textContent = marketRequest ? 'جارٍ تحميل الأغراض…' : 'تحميل المزيد من الأغراض';
  }
  const status = $('marketPagingStatus');
  if (status) {status.textContent = message; status.classList.toggle('hidden', !message);}
}
async function loadMarketGoods({reset = false, clearCache = false} = {}) {
  if (!db || !currentUser) return;
  if (!reset && marketRequest) return marketRequest;
  if (!reset && !marketHasMore) return;
  if(reset)clearTimeout(marketSearchTimer);
  const generation = reset ? ++marketGeneration : marketGeneration;
  const actor = currentUser.id;
  const filters = marketFilters();
  const cursor = reset ? null : marketCursor;
  const operation = (async () => {
    const result = await goodsPageQuery(filters, cursor);
    if (generation !== marketGeneration || currentUser?.id !== actor) return;
    if (result.error) throw result.error;
    const rows = result.data || [];
    // Validate before changing state; a malformed page must not poison the cursor.
    if (rows.length) pageCursorFilter(rows[rows.length - 1]);
    const previous = reset ? [] : (marketGoods || []);
    marketGoods = [...new Map([...previous, ...rows].map(row => [row.id, row])).values()];
    goods = [...new Map([...(clearCache ? [] : goods), ...rows].map(row => [row.id, row])).values()];
    marketCursor = rows.at(-1) || cursor;
    marketHasMore = rows.length === GOODS_PAGE_SIZE;
    if (reset) marketTotal = Number.isInteger(result.count) ? result.count : null;
    render();
  })();
  marketRequest = operation; updateGoodsPaging();
  try {await operation;} finally {
    if (generation === marketGeneration) {marketRequest = null; updateGoodsPaging();}
  }
}
window.loadMoreGoods = async function() {
  try {await loadMarketGoods();} catch (_) {updateGoodsPaging('تعذّر تحميل الصفحة. اضغط تحميل المزيد للمحاولة دون فقدان الأغراض السابقة.');}
};
window.scheduleGoodsSearch = function() {
  marketTotal=null;
  render();
  if (marketGoods === null) return; // Local fixtures and the initial empty shell.
  clearTimeout(marketSearchTimer);
  ++marketGeneration; marketRequest = null;
  marketSearchTimer = setTimeout(async () => {
    try {await loadMarketGoods({reset: true});} catch (error) {updateGoodsPaging(error.message || 'تعذّر البحث. حاول مجدداً.');}
  }, 300);
};
function resetMarketSession() {
  ++marketGeneration; clearTimeout(marketSearchTimer); marketRequest = null;
  marketGoods = null; marketCursor = null; marketTotal = null; marketHasMore = false;
  updateGoodsPaging();
}
