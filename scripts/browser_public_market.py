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

    def test_market_search_is_not_rendered_as_html(self):
        self.page.locator("#pmSearch").fill("<img src=x onerror=alert(1)>")
        self.page.wait_for_timeout(500)
        self.assertEqual(self.page.locator("#publicMarket img[src=x]").count(),0)
        self.assertFalse(self.errors)

if __name__=="__main__":
    unittest.main()
