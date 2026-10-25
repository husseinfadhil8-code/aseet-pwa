"""Offline public-market UI isolation checks; no hosted data writes."""
import unittest
import browser_app_security as security

class PublicMarketTests(unittest.TestCase):
    setUpClass=classmethod(security.AppSecurityTests.setUpClass.__func__)
    tearDownClass=classmethod(security.AppSecurityTests.tearDownClass.__func__)
    setUp=security.AppSecurityTests.setUp
    tearDown=security.AppSecurityTests.tearDown
    route=security.AppSecurityTests.route

    def setUp(self):
        security.AppSecurityTests.setUp(self)
        original=self.page.evaluate
        self.page.evaluate=lambda expression,arg=None: original("""async ({expression,arg}) => {
          const fn=(0,eval)('('+expression+')');
          let timer;
          try{return await Promise.race([Promise.resolve().then(()=>typeof fn==='function'?fn(arg):fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Market test evaluation exceeded 8 seconds')),8000)})])}
          finally{clearTimeout(timer)}
        }""", {'expression':expression,'arg':arg})
        self.page.set_default_timeout(5000)

    def test_guest_market_visible_and_staff_hidden(self):
        self.assertTrue(self.page.locator("#publicMarket").is_visible())
        self.assertTrue(self.page.locator("#appView").evaluate("e => e.classList.contains('hidden')"))
        self.assertEqual(self.page.locator("#publicMarket .pm-cat").count(), 8)
        self.assertNotIn("المندوبين",self.page.locator("#publicMarket").inner_text())

    def test_opening_staff_ui_hides_public_overlay(self):
        self.page.evaluate("""() => {
          document.querySelector("#welcomeView").classList.add("hidden");
          document.querySelector("#appView").classList.remove("hidden");
        }""")
        self.page.wait_for_function("document.querySelector('#publicMarket').hidden")
        self.assertFalse(self.page.locator("#publicMarket").is_visible())

    def test_mock_market_products_render_and_open_details(self):
        self.page.evaluate("""async () => {
          const mock={id:'market-one',title:'تخم تركي نظيف',price:400000,area:'بغداد',category:'أثاث',condition:'used',negotiable:true,status:'active',seller_id:'seller-one',image_urls:[],description:'تخم عشرة مقاعد'};
          const query={
            select(){return this},order(){return this},range(){return this},
            eq(){return this},or(){return this},
            then(done){return Promise.resolve({data:[mock],error:null}).then(done)}
          };
          db={auth:{getUser:async()=>({data:{user:null}})},from:()=>query};
          await WaseetPublicMarket.show(null);
        }""")
        self.assertEqual(self.page.locator("#pmGrid .pm-card").count(),1)
        self.page.locator("#pmGrid .pm-card").click()
        self.assertTrue(self.page.locator("#pmSheet").is_visible())
        self.assertIn("تخم تركي نظيف",self.page.locator("#pmSheetBody").inner_text())

    def test_latest_request_wins_during_overlapping_loading(self):
        self.page.evaluate("""async () => {
          let finishOld;
          const slow=new Promise(resolve => {finishOld=resolve});
          let call=0,startFirst;const firstStarted=new Promise(resolve=>{startFirst=resolve});
          const old={id:'old',title:'طلب قديم',price:100,area:'بغداد',category:'أثاث',condition:'used',status:'active',seller_id:'seller',image_urls:[]};
          const newest={...old,id:'new',title:'النتيجة الجديدة'};
          const query=()=>({select(){return this},order(){return this},range(){return this},
            eq(){return this},or(){return this},
            then(done){if(++call===1){startFirst();return slow.then(done)}return Promise.resolve({data:[newest],error:null}).then(done)}
          });
          db={auth:{getUser:async()=>({data:{user:null}})},from:query};
          const prior=WaseetPublicMarket.show(null);
          await firstStarted;
          await WaseetPublicMarket.show(null);
          finishOld({data:[old],error:null});
          await prior;
        }""")
        self.assertEqual(self.page.locator("#pmGrid .pm-card").count(),1)
        self.assertIn("النتيجة الجديدة",self.page.locator("#pmGrid").inner_text())

    def test_multi_photo_gallery_uses_next_button(self):
        self.page.evaluate("""async () => {
          const mock={id:'g1',title:'إعلان صور',price:50,area:'بغداد',category:'أثاث',
            status:'active',seller_id:'seller',condition:'used',negotiable:false,
            image_urls:['https://example.com/one.jpg','https://example.com/two.jpg'],description:'اختبار'};
          const query={select(){return this},order(){return this},range(){return this},
            eq(){return this},or(){return this},
            then(done){return Promise.resolve({data:[mock],error:null}).then(done)}};
          db={auth:{getUser:async()=>({data:{user:null}})},from:()=>query};
          await WaseetPublicMarket.show(null);
        }""")
        self.page.locator("#pmGrid .pm-card").first.click()
        self.assertIn("1 / 2",self.page.locator("#pmSheetBody").inner_text())
        self.page.get_by_role("button",name="التالي ›").click()
        self.assertIn("2 / 2",self.page.locator("#pmSheetBody").inner_text())

    def test_favorites_navigation_is_reachable_without_staff_ui(self):
        favorite = self.page.locator('#publicMarket .pm-nav [data-pm="favorites"]')
        self.assertEqual(favorite.count(), 1)
        self.assertTrue(favorite.is_visible())
        favorite.click()
        self.assertTrue(self.page.locator('#pmSheet').is_visible())
        self.assertEqual(self.page.locator('#pmSheetTitle').inner_text(), 'حساب السوق العام')
        self.assertTrue(self.page.locator('#appView').evaluate("e => e.classList.contains('hidden')"))

    def test_six_bottom_navigation_actions_fit_on_phone(self):
        self.page.set_viewport_size({"width": 375, "height": 812})
        buttons = self.page.locator("#publicMarket .pm-nav button")
        self.assertEqual(buttons.count(), 6)
        geometry = buttons.evaluate_all("""items => {
          const nav = document.querySelector('#publicMarket .pm-nav').getBoundingClientRect();
          return items.map(item => {
            const r = item.getBoundingClientRect();
            return {inside:r.left >= nav.left - 1 && r.right <= nav.right + 1, width:r.width};
          });
        }""")
        self.assertTrue(all(item["inside"] and item["width"] > 0 for item in geometry))

    def test_market_search_is_not_rendered_as_html(self):
        self.page.locator("#pmSearch").fill("<img src=x onerror=alert(1)>")
        self.page.wait_for_timeout(500)
        self.assertEqual(self.page.locator("#publicMarket img[src=x]").count(),0)
        self.assertFalse(self.errors)

    def market_fixture(self, promoted=False):
        self.page.evaluate("""async promoted => {
          window.pmCalls=[];
          const user={id:'seller',email:'seller@example.invalid'};
          const item={id:'listing',title:'إعلان اختبار الترويج',price:5000,area:'بغداد',category:'أثاث',condition:'used',negotiable:true,status:'active',seller_id:user.id,image_urls:[]};
          let state=null;
          db={auth:{getUser:async()=>({data:{user}}),signOut:async()=>({})},
            rpc:async(name,args)=>{pmCalls.push({name,args});if(name==='market_request_promotion')state='awaiting_payment';if(name==='market_submit_payment')state='awaiting_verification';return {data:'order-id',error:null}},
            from:table=>{
              const q={select(){return this},order(){return this},range(){return this},eq(){return this},limit(){return this},maybeSingle(){return this},or(){return this},
                gte(k,v){pmCalls.push({op:'gte',k,v});return this},lte(k,v){pmCalls.push({op:'lte',k,v});return this},ilike(k,v){pmCalls.push({op:'ilike',k,v});return this},
                then(done){let data=[];if(table==='market_browse')data=[{...item,is_promoted:promoted}];if(table==='market_payment_settings')data={enabled:true,merchant_name:'تاجر اختباري',qr_url:'https://example.invalid/qr.png'};if(table==='market_promotions')data=state?[{id:'order-id',status:state}]:[];return Promise.resolve({data,error:null}).then(done)}};return q;
            }};
          profile={role:'rep',status:'pending'};
          await WaseetPublicMarket.show(user);
        }""", promoted)

    def test_payment_submission_only_requests_review(self):
        self.market_fixture()
        self.page.locator('#pmGrid .pm-card').click()
        self.page.get_by_role('button',name='⭐ ترويج الإعلان · ٥٬٠٠٠ د.ع').click()
        self.page.get_by_role('button',name='إنشاء طلب ترويج').click()
        self.page.get_by_role('button',name='دفعت — إرسال للتحقق').click()
        self.page.wait_for_function("document.querySelector('#pmSheetBody').textContent.includes('الحالة: بانتظار التحقق')")
        calls=self.page.evaluate('pmCalls')
        self.assertEqual([c['name'] for c in calls if 'name' in c],['market_request_promotion','market_submit_payment'])
        self.assertEqual(self.page.locator('.pm-sponsored').count(),0)
        self.assertIn('صورة الإيصال وحدها',self.page.locator('#pmSheetBody').inner_text())

    def test_sponsored_badge_comes_from_server_projection(self):
        self.market_fixture(promoted=True)
        self.assertEqual(self.page.locator('.pm-sponsored').inner_text(),'مموّل')
        self.assertNotIn('provider_transaction_id',self.page.locator('#pmGrid').inner_html())

    def test_filters_are_applied_to_server_query(self):
        self.market_fixture()
        self.page.locator('#pmMin').fill('1000')
        self.page.locator('#pmMax').fill('10000')
        self.page.locator('#pmArea').fill('بغداد')
        self.page.get_by_role('button',name='تطبيق الفلاتر').click()
        self.page.wait_for_function("pmCalls.some(c=>c.op==='lte')")
        calls=self.page.evaluate('pmCalls')
        self.assertIn({'op':'gte','k':'price','v':1000},calls)
        self.assertIn({'op':'lte','k':'price','v':10000},calls)
        self.assertIn({'op':'ilike','k':'area','v':'%بغداد%'},calls)

    def test_session_reset_clears_private_market_ui(self):
        self.market_fixture()
        self.page.locator('#publicMarket .pm-nav [data-pm="account"]').click()
        self.assertIn('seller@example.invalid',self.page.locator('#pmSheetBody').inner_text())
        self.page.evaluate('clearAccountState()')
        self.assertEqual(self.page.locator('#pmSheetBody').inner_text(),'')
        self.assertEqual(self.page.locator('#pmGrid').inner_text(),'')
        self.assertFalse(self.page.locator('#publicMarket').is_visible())

    def test_no_market_admin_controls_for_customer(self):
        self.market_fixture()
        for name in ['pmAdminPayments','pmAdminMembers','pmAdminReports']:
            self.assertFalse(self.page.locator('#'+name).is_visible())
        self.page.evaluate('()=>{WaseetMarketPayments.admin();WaseetMarketAdmin.show()}')
        self.assertFalse(self.page.locator('#pmSheet').is_visible())

    def test_market_layout_at_phone_and_tablet_widths(self):
        self.market_fixture()
        for width in [320,375,390,430,768]:
            self.page.set_viewport_size({'width':width,'height':812})
            self.assertTrue(self.page.locator('#publicMarket').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
            self.assertTrue(self.page.locator('#pmScroll').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))

if __name__=="__main__":
    unittest.main()
