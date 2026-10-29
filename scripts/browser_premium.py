"""Premium interactions: isolated synthetic state; all external requests blocked."""
import unittest
import browser_comprehensive as baseline

class PremiumInteractions(unittest.TestCase):
    setUpClass=classmethod(baseline.ComprehensiveTests.setUpClass.__func__)
    tearDownClass=classmethod(baseline.ComprehensiveTests.tearDownClass.__func__)
    setUp=baseline.ComprehensiveTests.setUp
    tearDown=baseline.ComprehensiveTests.tearDown
    route=baseline.ComprehensiveTests.route
    fixture=baseline.ComprehensiveTests.fixture

    def test_home_search_uses_existing_market_search(self):
        self.fixture()
        self.page.evaluate("window.scheduleGoodsSearch=()=>window.searchValue=document.querySelector('#goodsSearch').value")
        self.page.locator('#dashboardSearch').fill('ثلاجة')
        self.page.locator('.wd-search button').click()
        self.assertTrue(self.page.locator('#browseView').is_visible())
        self.assertEqual(self.page.evaluate('searchValue'),'ثلاجة')
        self.assertFalse(self.errors)

    def test_back_to_market_preserves_scroll_and_rejects_unauthorized_tab(self):
        self.fixture()
        self.page.set_viewport_size({'width':390,'height':844})
        self.page.evaluate("switchTab('browse');document.querySelector('.content').scrollTop=420")
        position=self.page.evaluate("document.querySelector('.content').scrollTop")
        self.page.evaluate("switchTab('account');switchTab('browse')")
        self.assertEqual(self.page.evaluate("document.querySelector('.content').scrollTop"),position)
        self.page.evaluate("profile.role='rep'")
        self.assertFalse(self.page.evaluate("switchTab('reps')"))
        self.assertTrue(self.page.locator('#browseView').is_visible())

    def test_rtl_gallery_and_fullscreen_photo_focus(self):
        self.fixture()
        self.page.set_viewport_size({'width':390,'height':844})
        self.page.evaluate("goods[0].image_urls=[location.origin+'/assets/waseet-icon.svg',location.origin+'/assets/waseet-market-hero.svg'];render();switchTab('browse')")
        track=self.page.locator('.waseet-swipe-track').first
        track.evaluate('n=>n.scrollLeft=-n.clientWidth')
        self.page.wait_for_function("document.querySelector('.waseet-photo-count').textContent.includes('2/2')")
        self.page.evaluate("openGoodDetails('good0')")
        self.page.locator('.waseet-details-gallery img').nth(1).click()
        self.assertTrue(self.page.locator('#photoViewer').is_visible())
        self.assertIn('2 / 2',self.page.locator('#photoViewer [role=status]').text_content())
        self.assertEqual(self.page.locator('#photoViewer img').count(),2)
        self.page.keyboard.press('Escape')
        self.assertFalse(self.page.locator('#photoViewer').is_visible())
        self.assertTrue(self.page.locator('#goodDetailsDialog').is_visible())
        self.assertFalse(self.errors)

if __name__=='__main__':unittest.main()
