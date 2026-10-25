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

    def test_market_search_is_not_rendered_as_html(self):
        self.page.locator("#pmSearch").fill("<img src=x onerror=alert(1)>")
        self.page.wait_for_timeout(500)
        self.assertEqual(self.page.locator("#publicMarket img[src=x]").count(),0)
        self.assertFalse(self.errors)

if __name__=="__main__":
    unittest.main()
