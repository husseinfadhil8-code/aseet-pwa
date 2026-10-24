"""Browser regression tests. Requires Playwright and Chromium; no Supabase access.

Run: PYTHONDONTWRITEBYTECODE=1 python3 scripts/browser_app_security.py -v
"""
import os
import functools
import http.server
from pathlib import Path
import shutil
import threading
import unittest

from playwright.sync_api import sync_playwright


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class AppSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        cls.server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(root))
        )
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        engine=os.environ.get("WASEET_BROWSER","chromium")
        if engine not in ("chromium","webkit"):raise ValueError("Unsupported test browser")
        cls.browser = (cls.playwright.webkit.launch() if engine=="webkit" else
            cls.playwright.chromium.launch(executable_path=shutil.which("chromium"),args=["--no-sandbox"]))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.context = self.browser.new_context(service_workers="block")
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.route("**/*", self.route)
        self.page.goto(self.origin, wait_until="networkidle")
        self.page.evaluate("""() => {
            profile = {role: 'admin', status: 'approved'};
            currentUser = {id: 'audit-admin'};
            window.open = (...args) => { window.opened = args; return null; };
        }""")

    def route(self, route):
        if route.request.url == self.origin + "/vendor/supabase-2.118.0.js":
            # Stub only authentication initialization. All other external requests are blocked.
            route.fulfill(content_type="application/javascript", body="""
                window.supabase = {createClient: () => ({auth: {
                    getSession: async () => ({data: {session: null}})
                }})};
            """)
        elif route.request.url.startswith(self.origin + "/"):
            route.continue_()
        else:
            route.abort()

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def render_rep(self, name, status="approved"):
        self.page.evaluate("""({name,status}) => {
            reps = [{id:'audit-rep', full_name:name, status}];
            render();
        }""", {"name": name, "status": status})

    def open_details(self, urls, goods_id="audit-good"):
        self.page.evaluate("""({urls,id}) => {
            goods = [{id, title:'منتج اختبار', asking_price:250000,
                status:'available', image_urls:urls}];
            openGoodDetails(id);
        }""", {"urls": urls, "id": goods_id})

    def test_rep_name_injection_is_plain_text(self):
        name = "x',window.__injected=1,'<img src=x onerror=window.__injected=2>"
        self.render_rep(name)
        card = self.page.locator("#repsList > .product-card")
        self.assertIsNone(card.get_attribute("onclick"))
        card.evaluate("node => node.click()")
        self.assertEqual(self.page.locator("#manageRepTitle").text_content(), "إدارة المندوب: " + name)
        self.assertEqual(self.page.evaluate("activeManageRepId"), "audit-rep")
        self.assertFalse(self.page.evaluate("Boolean(window.__injected)"))
        self.assertEqual(self.page.locator("#repsList img").count(), 0)
        self.assertTrue(self.page.locator("#repManageDialog").evaluate("node => node.open"))

    def test_manage_button_preserves_quoted_name_and_status(self):
        self.render_rep("O'Connor أحمد", "restricted")
        self.page.locator("[data-manage-rep-index] button").evaluate("node => node.click()")
        self.assertEqual(self.page.locator("#manageRepTitle").text_content(), "إدارة المندوب: O'Connor أحمد")
        self.assertIn("مقيّد", self.page.locator("#manageRepBody").text_content())

    def test_push_button_does_not_open_management(self):
        self.render_rep("مندوب")
        self.page.evaluate("() => {window.testRepPushNotification = id => {window.pushTarget=id;};}")
        button = self.page.locator("[data-test-rep-push]")
        self.assertIsNone(button.get_attribute("onclick"))
        button.evaluate("node => node.click()")
        self.assertEqual(self.page.evaluate("window.pushTarget"), "audit-rep")
        self.assertFalse(self.page.locator("#repManageDialog").evaluate("node => node.open"))

    def test_repeated_render_binds_once_to_current_rep(self):
        self.render_rep("قديم")
        self.render_rep("جديد")
        self.page.evaluate("() => {window.manageCalls=0;window.openRepManage=(...args)=>{window.manageCalls++;window.manageArgs=args;};}")
        self.page.locator("[data-manage-rep-index]").evaluate("node=>node.click()")
        self.assertEqual(self.page.evaluate("window.manageCalls"), 1)
        self.assertEqual(self.page.evaluate("window.manageArgs"), ["audit-rep", "جديد", "approved"])

    def test_image_click_treats_injection_as_url_data(self):
        self.open_details(["https://example.invalid/a');window.__injected=1;//x"])
        image = self.page.locator(".waseet-details-gallery img")
        self.assertIsNone(image.get_attribute("onclick"))
        self.assertIsNone(image.get_attribute("onerror"))
        image.evaluate("node => node.click()")
        self.assertFalse(self.page.evaluate("Boolean(window.__injected)"))
        opened = self.page.evaluate("window.opened")
        self.assertTrue(opened[0].startswith("https://example.invalid/"))
        self.assertEqual(opened[1:], ["_blank", "noopener,noreferrer"])

    def test_only_http_and_https_image_urls_are_accepted(self):
        rejected = ["javascript:alert(1)", "data:image/png;base64,AA", "file:///tmp/a",
                    "ftp://example.invalid/a", "blob:https://example.invalid/a", "//example.invalid/a",
                    "/relative.png", "https://", "http://[invalid", "", None, "java\nscript:alert(1)"]
        for value in rejected:
            with self.subTest(value=value):
                self.assertIsNone(self.page.evaluate("value => getSafeImageUrl(value)", value))
        self.open_details(["javascript:alert(1)", "data:image/png;base64,AA"])
        self.assertEqual(self.page.locator(".waseet-details-gallery img").count(), 0)
        self.assertEqual(self.page.locator(".waseet-details-no-image").count(), 1)

    def test_valid_images_open_and_error_handler_still_hides_image(self):
        urls = ["http://example.invalid/one.png", "https://example.invalid/two.png?x=1&y=2"]
        self.open_details(urls)
        images = self.page.locator(".waseet-details-gallery img")
        self.assertEqual(images.count(), 2)
        for index, url in enumerate(urls):
            image = images.nth(index)
            image.evaluate("node=>node.click()")
            self.assertEqual(self.page.evaluate("window.opened"), [url, "_blank", "noopener,noreferrer"])
            image.evaluate("node=>node.dispatchEvent(new Event('error'))")
            self.assertEqual(image.evaluate("node=>node.style.display"), "none")

    def test_detail_actions_pass_id_as_data(self):
        goods_id = "id');window.__injected=1;//x"
        self.open_details([], goods_id)
        self.page.evaluate("""() => {
            window.shareSingleGoodOnWhatsApp=id=>{window.shareId=id;};
            window.editGoods=id=>{window.editId=id;};
        }""")
        self.page.locator('[data-good-action="share"]').click()
        self.assertEqual(self.page.evaluate("window.shareId"), goods_id)
        self.page.locator('[data-good-action="edit"]').click()
        self.assertEqual(self.page.evaluate("window.editId"), goods_id)
        self.assertFalse(self.page.locator("#goodDetailsDialog").evaluate("node=>node.open"))
        self.assertFalse(self.page.evaluate("Boolean(window.__injected)"))

    def test_rep_has_share_but_no_edit_action(self):
        self.page.evaluate("profile.role='rep'")
        self.open_details([])
        self.assertEqual(self.page.locator('[data-good-action="share"]').count(), 1)
        self.assertEqual(self.page.locator('[data-good-action="edit"]').count(), 0)

    def test_legacy_image_sources_remain_supported(self):
        urls = self.page.evaluate("""() => getGoodImageUrls({
            image_urls:'["https://example.invalid/a.png"]',
            image_url:'https://example.invalid/a.png | http://example.invalid/b.png',
            description:'صور الغرض: https://example.invalid/c.png'
        })""")
        self.assertEqual(urls, ["https://example.invalid/a.png", "http://example.invalid/b.png", "https://example.invalid/c.png"])

    def prepare_sale(self):
        self.page.evaluate("""() => {
            goods=[{id:'test-good',title:'غرض اختبار',status:'available'}];
            reps=[{id:'test-rep',full_name:'مندوب اختبار',status:'approved'}];
            prepareSaleDialog('test-good');
            const form=document.getElementById('saleForm');
            form.elements.price.value='1000';
            form.elements.totalCommission.value='100';
            form.elements.repCommission.value='60';
            window.alerts=[];
            window.alert=message=>window.alerts.push(message);
            window.refreshed=0;
            refreshData=async()=>{window.refreshed++;};
            sendPushEvent=async(event,payload)=>{window.pushEvent={event,payload};return {ok:true};};
            window.rpcCalls=[];
            db.from=()=>{throw new Error('Unexpected direct table operation');};
            db.rpc=async(name,payload)=>{
                window.rpcCalls.push({name,payload});
                return {data:'test-sale',error:null};
            };
        }""")

    def test_sale_uses_only_atomic_rpc_and_preserves_success_flow(self):
        self.prepare_sale()
        self.page.evaluate("() => handleSaveSale()")
        self.assertEqual(self.page.evaluate("window.rpcCalls"), [{"name":"record_sale", "payload":{
            "p_goods_id":"test-good", "p_rep_id":"test-rep", "p_final_price":1000,
            "p_total_commission":100, "p_rep_share":60}}])
        self.assertEqual(self.page.evaluate("window.pushEvent"), {"event":"sale", "payload":{"saleId":"test-sale"}})
        self.assertEqual(self.page.evaluate("window.refreshed"), 1)
        self.assertFalse(self.page.locator("#saleDialog").evaluate("node=>node.open"))
        self.assertIn("تم تسجيل البيع بنجاح", self.page.evaluate("window.alerts"))

    def test_sale_failure_preserves_form_and_does_not_notify(self):
        self.prepare_sale()
        self.page.evaluate("""() => {db.rpc=async()=>({data:null,error:{message:'الغرض غير متاح للبيع'}});}""")
        self.page.evaluate("() => handleSaveSale()")
        self.assertTrue(self.page.locator("#saleDialog").evaluate("node=>node.open"))
        self.assertEqual(self.page.locator('#saleForm [name="price"]').input_value(), "1000")
        self.assertFalse(self.page.evaluate("Boolean(window.pushEvent)"))
        self.assertEqual(self.page.evaluate("window.refreshed"), 0)
        self.assertFalse(self.page.locator('#saleForm button[onclick="handleSaveSale()"]').is_disabled())
        self.assertIn("تعذّر تسجيل البيع", self.page.evaluate("window.alerts[0]"))

    def test_double_click_sends_one_request_and_reenables_button(self):
        self.prepare_sale()
        self.page.evaluate("""() => {
            db.rpc=(name,payload)=>new Promise(resolve=>{
                window.rpcCalls.push({name,payload});window.finishSale=resolve;
            });
            window.firstSale=handleSaveSale();
        }""")
        self.assertTrue(self.page.locator('#saleForm button[onclick="handleSaveSale()"]').is_disabled())
        self.page.evaluate("() => handleSaveSale()")
        self.assertEqual(self.page.evaluate("window.rpcCalls.length"), 1)
        self.page.evaluate("async()=>{window.finishSale({data:'test-sale',error:null});await window.firstSale;}")
        self.assertFalse(self.page.locator('#saleForm button[onclick="handleSaveSale()"]').is_disabled())
        self.assertEqual(self.page.evaluate("document.getElementById('saleForm').dataset.saving"), None)

    def test_sale_rejects_non_admin_and_unsafe_amounts(self):
        self.prepare_sale()
        self.page.evaluate("profile.role='rep'")
        self.page.evaluate("() => handleSaveSale()")
        self.assertEqual(self.page.evaluate("window.rpcCalls"), [])
        self.page.evaluate("profile.role='admin'")
        for value in ["1.5", "9007199254740992", "0", "-1"]:
            with self.subTest(value=value):
                self.page.locator('#saleForm [name="price"]').fill(value)
                self.page.evaluate("() => handleSaveSale()")
                self.assertEqual(self.page.evaluate("window.rpcCalls"), [])

    def test_missing_rpc_never_falls_back_to_separate_writes(self):
        self.prepare_sale()
        self.page.evaluate("() => {db.rpc=async()=>({data:null,error:{code:'PGRST202',message:'RPC not installed'}});}")
        self.page.evaluate("() => handleSaveSale()")
        self.assertFalse(self.page.evaluate("Boolean(window.pushEvent)"))
        self.assertTrue(self.page.locator("#saleDialog").evaluate("node=>node.open"))
        self.assertIn("RPC not installed", self.page.evaluate("window.alerts[0]"))


if __name__ == "__main__":
    unittest.main()
