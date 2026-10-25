"""Read-only goods paging regression tests; all API traffic intercepted."""
import unittest
import browser_app_security as security
class GoodsPagingTests(unittest.TestCase):
    setUpClass=classmethod(security.AppSecurityTests.setUpClass.__func__)
    tearDownClass=classmethod(security.AppSecurityTests.tearDownClass.__func__)
    setUp=security.AppSecurityTests.setUp
    tearDown=security.AppSecurityTests.tearDown
    route=security.AppSecurityTests.route
    def fixtures(self):
        self.page.evaluate("""()=>{
          document.querySelector('#splashScreen')?.remove();
          document.querySelector('#welcomeView').classList.add('hidden');
          document.querySelector('#appView').classList.remove('hidden');
          window.rows=(from,count,conversation)=>Array.from({length:count},(_,i)=>({
            id:'00000000-0000-0000-0000-'+String(from-i).padStart(12,'0'),created_at:'2026-10-24T10:00:00+00:00',
            title:'كرسي '+(from-i),area:'بغداد',status:'available',asking_price:1000,
            conversation_id:conversation,body:'رسالة '+(from-i),sender_id:'other'
          }));
          window.results=[];window.requests=[];window.readUpdates=0;
          db={from:table=>{
            const calls=[];const query={};
            for(const method of ['select','eq','or','ilike','lte','order','limit','in'])query[method]=(...args)=>{calls.push([method,...args]);return query;};
            query.then=(resolve,reject)=>{
              requests.push({table,calls});
              if(window.holdNext){window.holdNext=false;return new Promise(done=>window.finishPage=done).then(resolve,reject);}
              return Promise.resolve(results.shift()||{data:[]}).then(resolve,reject);
            };
            if(table==='chat_members')return {update:()=>{readUpdates++;const member={eq:()=>member};return member;}};
            return query;
          }};
        }""")

    def test_products_load_every_page_with_stable_cursor(self):
        self.fixtures()
        self.page.evaluate("""async()=>{
          results=[{data:rows(100,40),count:85},{data:rows(60,40),count:45},{data:rows(20,5),count:5}];
          await loadMarketGoods({reset:true,clearCache:true});
        }""")
        self.assertEqual(self.page.locator('[data-card-index]').count(),40)
        self.page.evaluate('async()=>{await loadMoreGoods();await loadMoreGoods();}')
        self.assertEqual(self.page.locator('[data-card-index]').count(),85)
        self.assertFalse(self.page.locator('#loadMoreGoodsButton').is_visible())
        self.assertIn('85',self.page.locator('#goodsResultCount').inner_text())
        self.assertTrue(self.page.evaluate("requests[1].calls.some(call=>call[0]==='or' && call[1].includes('id.lt.00000000-0000-0000-0000-000000000061'))"))
        self.assertTrue(self.page.evaluate("requests.every(r=>r.calls.some(c=>c[0]==='limit' && c[1]===40))"))
        self.assertNotIn('owner_phone',self.page.evaluate("requests[0].calls.find(c=>c[0]==='select')[1]"))

    def test_more_products_double_click_sends_once(self):
        self.fixtures()
        self.page.evaluate("""async()=>{results=[{data:rows(100,40)}];await loadMarketGoods({reset:true});holdNext=true;window.a=loadMoreGoods();window.b=loadMoreGoods();}""")
        self.assertEqual(self.page.evaluate('requests.length'),2)
        self.page.evaluate('async()=>{finishPage({data:rows(60,5)});await Promise.all([a,b]);}')
        self.assertEqual(self.page.evaluate('marketGoods.length'),45)

    def test_product_failure_keeps_page_and_allows_retry(self):
        self.fixtures()
        self.page.evaluate("""async()=>{results=[{data:rows(100,40)},{error:{message:'offline'}},{data:rows(60,2)}];await loadMarketGoods({reset:true});await loadMoreGoods();}""")
        self.assertEqual(self.page.evaluate('marketGoods.length'),40)
        self.assertIn('تعذّر',self.page.locator('#marketPagingStatus').inner_text())
        self.assertFalse(self.page.locator('#loadMoreGoodsButton').is_disabled())
        self.page.evaluate('async()=>await loadMoreGoods()')
        self.assertEqual(self.page.evaluate('marketGoods.length'),42)

    def test_new_search_wins_over_slow_old_request(self):
        self.fixtures()
        self.page.evaluate("""async()=>{holdNext=true;window.oldPage=loadMarketGoods({reset:true});results=[{data:rows(9,1),count:1}];await loadMarketGoods({reset:true,clearCache:true});finishPage({data:rows(100,40)});await oldPage;}""")
        self.assertEqual(self.page.evaluate('marketGoods.length'),1)
        self.assertTrue(self.page.evaluate("marketGoods[0].id.endsWith('000000000009')"))

    def test_search_is_server_side_and_literal_is_quoted(self):
        self.fixtures()
        value='كرسي,asking_price.lt.0)"'
        self.page.locator('#goodsSearch').fill(value)
        self.page.evaluate('async()=>{results=[{data:[],count:0}];await loadMarketGoods({reset:true});}')
        search=self.page.evaluate("requests[0].calls.find(c=>c[0]==='or')[1]")
        self.assertIn('title.ilike."*',search)
        self.assertIn('\\"',search)
        self.assertIn('description.ilike.',search)
        self.assertEqual(self.page.evaluate('marketTotal'),0)


    def test_server_row_cap_does_not_hide_remaining_results(self):
        self.fixtures()
        self.page.evaluate("""async()=>{results=[{data:rows(45,20),count:45},{data:rows(25,20),count:25},{data:rows(5,5),count:5}];
          await loadMarketGoods({reset:true,clearCache:true});await loadMoreGoods();await loadMoreGoods();}""")
        self.assertEqual(self.page.evaluate('marketGoods.length'),45)
        self.assertEqual(self.page.evaluate('marketTotal'),45)
        self.assertFalse(self.page.locator('#loadMoreGoodsButton').is_visible())

    def test_pending_search_cannot_load_more_with_an_old_cursor(self):
        self.fixtures()
        self.page.evaluate("async()=>{results=[{data:rows(100,40),count:80}];await loadMarketGoods({reset:true});results=[{data:rows(9,1),count:1}];}")
        self.page.locator('#goodsSearch').fill('كرسي')
        self.page.evaluate('async()=>await loadMoreGoods()')
        self.assertEqual(self.page.evaluate('requests.length'),1)
        self.page.wait_for_function('marketGoods.length===1')
        self.assertEqual(self.page.evaluate('requests.length'),2)

    def test_linked_sale_product_is_hydrated_without_adding_it_to_current_page(self):
        self.fixtures()
        self.page.evaluate("""async()=>{results=[{data:rows(40,40),count:90}];await loadMarketGoods({reset:true,clearCache:true});
          const older=rows(97,1)[0];older.title='عنوان سجل قديم';older.status='sold';results=[{data:[older],count:1}];
          await loadLinkedGoods([{goods_id:older.id}],()=>true);
          sales=[{id:'sale',goods_id:older.id,rep_id:'rep',rep_share:60,manager_share:40,total_commission:100,final_price:1000}];render();}""")
        self.assertEqual(self.page.locator('#goodsList>article').count(),40)
        self.assertIn('عنوان سجل قديم',self.page.locator('#salesList').inner_text())
        self.assertTrue(self.page.evaluate("requests[1].calls.some(c=>c[0]==='in'&&c[1]==='id')"))
        self.assertNotIn('owner_phone',self.page.evaluate("requests[1].calls.find(c=>c[0]==='select')[1]"))

    def test_linked_response_cannot_restore_cache_after_logout(self):
        self.fixtures()
        self.page.evaluate("""()=>{const actor=currentUser;holdNext=true;window.linked=loadLinkedGoods([{goods_id:rows(97,1)[0].id}],()=>currentUser===actor);clearAccountState();}""")
        self.page.evaluate('async()=>{finishPage({data:rows(97,1),count:1});await linked;}')
        self.assertEqual(self.page.evaluate('goods.length'),0)

    def test_sale_picker_uses_current_available_results_only(self):
        self.fixtures()
        self.page.evaluate("""async()=>{results=[{data:rows(40,3),count:3}];await loadMarketGoods({reset:true,clearCache:true});
          goods.push({...rows(97,1)[0],title:'غرض من بحث سابق'});prepareSaleDialog();}""")
        self.assertEqual(self.page.locator('#saleGoods option').count(),3)
        self.assertNotIn('بحث سابق',self.page.locator('#saleGoods').inner_text())


    def test_missing_count_does_not_assume_a_short_page_is_the_end(self):
        self.fixtures()
        self.page.evaluate("""async()=>{results=[{data:rows(40,20)},{data:rows(20,20)},{data:[]}];await loadMarketGoods({reset:true});await loadMoreGoods();await loadMoreGoods();}""")
        self.assertEqual(self.page.evaluate('marketGoods.length'),40)
        self.assertFalse(self.page.locator('#loadMoreGoodsButton').is_visible())

    def test_impossible_count_is_an_error_not_an_empty_inventory(self):
        self.fixtures()
        self.page.evaluate("async()=>{results=[{data:rows(40,40),count:80},{data:[],count:12}];await loadMarketGoods({reset:true});await loadMoreGoods();}")
        self.assertEqual(self.page.evaluate('marketGoods.length'),40)
        self.assertIn('تعذّر',self.page.locator('#marketPagingStatus').inner_text())


    def test_role_downgrade_clears_old_admin_views_and_rotates_request_identity(self):
        self.fixtures()
        self.page.evaluate("""async()=>{window.oldActor=currentUser;goods=[{id:'old'}];sales=[{id:'private'}];inquiries=[{id:'private-inquiry'}];
          showApp=()=>{};startPresenceTracking=()=>{};startRepStatusMonitoring=()=>{};refreshData=async()=>{};
          db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{role:'rep',status:'approved',permissions:{can_add_inquiry:false}}})})})})};
          await checkRepresentativeAccess();}""")
        self.assertTrue(self.page.evaluate('currentUser!==oldActor && currentUser.id===oldActor.id'))
        self.assertEqual(self.page.evaluate('profile.role'),'rep')
        self.assertEqual(self.page.evaluate('goods.length+sales.length+inquiries.length'),0)
        self.assertTrue(self.page.evaluate('marketGoods===null'))

    def test_linked_read_cap_is_followed_until_remaining_ids_are_resolved(self):
        self.fixtures()
        self.page.evaluate("""async()=>{const records=rows(100,3);results=[{data:records.slice(0,1),count:3},{data:records.slice(1),count:2}];
          await loadLinkedGoods(records.map(g=>({goods_id:g.id})),()=>true);}""")
        self.assertEqual(self.page.evaluate('goods.length'),3)
        self.assertEqual(self.page.evaluate('requests.length'),2)

if __name__=='__main__':unittest.main()
