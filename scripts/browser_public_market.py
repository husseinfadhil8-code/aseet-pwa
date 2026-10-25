"""Offline public-market UI isolation checks; no hosted data writes."""
import unittest
import browser_app_security as security

class PublicMarketTests(unittest.TestCase):
    setUpClass=classmethod(security.AppSecurityTests.setUpClass.__func__)
    tearDownClass=classmethod(security.AppSecurityTests.tearDownClass.__func__)
    setUp=security.AppSecurityTests.setUp
    tearDown=security.AppSecurityTests.tearDown
    route=security.AppSecurityTests.route

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
          let call=0;
          const old={id:'old',title:'طلب قديم',price:100,area:'بغداد',category:'أثاث',condition:'used',status:'active',seller_id:'seller',image_urls:[]};
          const newest={...old,id:'new',title:'النتيجة الجديدة'};
          const query=()=>({select(){return this},order(){return this},range(){return this},
            eq(){return this},or(){return this},
            then(done){return (++call===1?slow:Promise.resolve({data:[newest],error:null})).then(done)}
          });
          db={auth:{getUser:async()=>({data:{user:null}})},from:query};
          const prior=WaseetPublicMarket.show(null);
          await Promise.resolve();
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

if __name__=="__main__":
    unittest.main()
