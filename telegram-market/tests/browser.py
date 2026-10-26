"""Mini App browser flows with explicitly synthetic HTTP fixtures; not hosted proof."""
import unittest,threading,http.server,functools,os,shutil,json,base64
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
class BrowserTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'miniapp')));cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start();cls.origin='http://127.0.0.1:'+str(cls.server.server_port);cls.p=sync_playwright().start();cls.browser=cls.p.webkit.launch() if os.environ.get('WASEET_BROWSER')=='webkit' else cls.p.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox'])
 @classmethod
 def tearDownClass(cls):cls.browser.close();cls.p.stop();cls.server.shutdown();cls.server.server_close();cls.thread.join()
 def setUp(self):
  self.context=self.browser.new_context(viewport={'width':390,'height':844});self.page=self.context.new_page();self.page.set_default_timeout(6000);self.errors=[];self.calls=[];self.role='market';self.logged=True;self.ads=[];self.orders=[];self.image=0;self.private_media=False;self.authorized_media=0
  self.page.on('pageerror',lambda e:self.errors.append(str(e)));self.page.route('**/*',self.route)
 def tearDown(self):self.context.close();self.assertEqual(self.errors,[])
 def fixture(self):return {'id':'00000000-0000-0000-0000-000000000099','owner_id':'member-one','title':'إعلان اختباري','category':'أثاث','area':'بغداد','price':5000,'condition':'used','negotiable':True,'description':'وصف اختباري','images':[],'status':'active'}
 def route(self,r):
  url=r.request.url
  if url=='https://telegram.org/js/telegram-web-app.js':
   r.fulfill(content_type='application/javascript',body="window.Telegram={WebApp:{initData:'synthetic-test-data',initDataUnsafe:{user:{id:1,role:'admin'}},ready(){},expand(){},openTelegramLink(url){window.sharedLink=url},onEvent(name,fn){if(name==='themeChanged')window.testTheme=fn},openInvoice(url,cb){window.invoiceOpened=url;cb('paid')}}};");return
  if '/api/' in url:
   payload=json.loads(r.request.post_data or '{}') if r.request.method=='POST' and '/api/images' not in url else {};self.calls.append({'path':url.split('/api/')[1],'body':payload});data={}
   if '/api/listings' in url:data={'data':self.ads,'promotionStars':50}
   elif '/api/images' in url:self.image+=1;data={'id':'00000000-0000-0000-0000-'+str(self.image).zfill(12)}
   elif '/api/invoice' in url:data={'invoice':'https://t.me/$synthetic','order':'order-one'}
   else:
    action=payload.get('action');result={}
    if action=='me':
     if not self.logged:r.fulfill(status=401,json={'error':'telegram_session_required'});return
     result={'id':'member-one','name':'مستخدم اختبار','role':self.role}
    elif action=='rep_application':result={'application':None,'training':{}}
    elif action=='lesson':result={'lessons':[1,2,3,4,5]}
    elif action=='quiz':result={'passed':True,'score':5}
    elif action=='rep_apply':result={'id':'application-one','status':'pending'}
    elif action=='rep_requests':result=[]
    elif action in ['mine','favorites']:result=self.ads
    elif action in ['orders']:result=self.orders
    elif action=='thread':result={'id':'thread-one','title':'محادثة اختبار'}
    elif action=='inbox':result=[{'id':'thread-one','title':'محادثة اختبار'}]
    elif action=='messages':result=[{'sender_id':'another','body':'<img src=x onerror=window.injected=1>'}]
    elif action=='rep':result={'sales':[],'commission_iqd':0}
    elif action=='admin':result={'stats':{'users':150,'listings':90,'stars_received':500},'users':[],'listings':[],'reports':[],'orders':[],'support':[]}
    data={'data':result}
   r.fulfill(json=data);return
  if '/media/' in url and self.private_media and not r.request.headers.get('x-telegram-init-data'):r.fulfill(status=404,body='Not found');return
  if '/media/' in url and r.request.headers.get('x-telegram-init-data'):self.authorized_media+=1
  if '/media/' in url:r.fulfill(content_type='image/png',body=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII='));return
  if url.startswith(self.origin):r.continue_()
  else:r.abort()
 def open(self):self.page.goto(self.origin,wait_until='networkidle')
 def test_01_no_demo_listings_or_local_storage(self):
  self.open();self.assertEqual(self.page.locator('.card').count(),0);self.assertIn('لا توجد إعلانات',self.page.locator('#status').inner_text());self.assertEqual(self.page.evaluate('localStorage.length'),0)
 def test_02_rtl_phone_and_tablet_no_horizontal_overflow(self):
  self.ads=[self.fixture()];self.open()
  for width in [320,375,390,430,768]:
   self.page.set_viewport_size({'width':width,'height':844});self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));self.assertEqual(self.page.locator('html').get_attribute('dir'),'rtl')
 def test_03_untrusted_listing_text_is_not_html(self):
  ad=self.fixture();ad['title']='<img src=x onerror=window.injected=1>';self.ads=[ad];self.open();self.assertEqual(self.page.locator('img[src=x]').count(),0);self.assertIsNone(self.page.evaluate('window.injected'))
 def test_04_account_authority_comes_from_server_not_initDataUnsafe(self):
  self.open();self.page.locator('#account').click();self.assertIn('حساب سوق',self.page.locator('#sheetBody').inner_text());self.assertEqual(self.page.get_by_role('button',name='لوحة الإدارة').count(),0);self.assertEqual(self.page.get_by_role('button',name='المندوب والعمولات').count(),0)
 def test_05_anonymous_write_rejected(self):
  self.logged=False;self.open();self.page.locator('[data-nav=add]').click();self.page.locator('#toast').wait_for(state='visible');self.assertIn('داخل تلغرام',self.page.locator('#toast').inner_text());self.assertFalse(self.page.locator('#sheet').is_visible())
 def test_06_photo_gallery_contains_and_swipes(self):
  ad=self.fixture();ad['images']=['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002'];self.ads=[ad];self.open();self.page.locator('.card').click();self.assertEqual(self.page.locator('.gallery img').count(),2);self.assertEqual(self.page.locator('.gallery img').first.evaluate('e=>getComputedStyle(e).objectFit'),'contain');self.assertEqual(self.page.locator('.gallery').evaluate('e=>getComputedStyle(e).scrollSnapType'),'x mandatory')
 def test_07_messaging_keeps_untrusted_body_plain(self):
  ad=self.fixture();ad['owner_id']='another';self.ads=[ad];self.open();self.page.locator('.card').click();self.page.get_by_role('button',name='راسل البائع').click();self.page.locator('.bubble').wait_for();self.assertEqual(self.page.locator('img[src=x]').count(),0);self.assertIn('<img',self.page.locator('.bubble').inner_text())
 def test_08_invoice_callback_never_activates_or_mutates_order(self):
  self.ads=[self.fixture()];self.open();self.page.locator('.card').click();self.page.get_by_role('button',name='ترويج بـStars').click();self.page.get_by_role('button',name='عرض فاتورة Stars').click();self.page.wait_for_function('Boolean(window.invoiceOpened)');self.assertFalse(any(c['body'].get('action') in ('payment','activate','paid') for c in self.calls));self.assertIn('تأكيد الدفع',self.page.locator('#toast').inner_text())
 def test_09_admin_all_record_statistics_is_separate(self):
  self.role='admin';self.open();self.page.locator('#account').click();self.page.get_by_role('button',name='لوحة الإدارة').click();self.page.wait_for_function("document.querySelector('#sheetBody').textContent.includes('150')");self.assertIn('Stars',self.page.locator('#sheetBody').inner_text())
 def test_10_photo_limit_checked_before_upload(self):
  self.open();self.page.locator('[data-nav=add]').click();self.page.locator('input[name=title]').fill('إعلان جديد صحيح');self.page.locator('input[name=price]').fill('5000');self.page.locator('input[name=area]').fill('بغداد');file={'name':'test.png','mimeType':'image/png','buffer':base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=')};self.page.locator('input[type=file]').set_input_files([file]*6);self.page.get_by_role('button',name='نشر الإعلان').click();self.assertIn('الحد الأعلى',self.page.locator('#toast').inner_text());self.assertEqual(self.image,0)
 def test_11_five_photos_compressed_uploaded_and_bound_to_listing(self):
  self.open();self.page.locator('[data-nav=add]').click();self.page.locator('input[name=title]').fill('إعلان خمس صور');self.page.locator('input[name=price]').fill('25000');self.page.locator('input[name=area]').fill('بغداد');data=(ROOT.parent/'assets/waseet-192.png').read_bytes();files=[{'name':f'photo-{i}.png','mimeType':'image/png','buffer':data} for i in range(5)];self.page.locator('input[type=file]').set_input_files(files);self.page.get_by_role('button',name='نشر الإعلان',exact=True).click();self.assertEqual(self.image,0);self.page.get_by_role('button',name='تأكيد ونشر الإعلان',exact=True).click();self.page.wait_for_function("!document.querySelector('#sheet').open");self.assertEqual(self.image,5);saved=next(c['body']['data'] for c in self.calls if c['body'].get('action')=='save');self.assertEqual(len(set(saved['images'])),5)
 def test_12_owners_hidden_photo_uses_authenticated_fetch_not_public_url(self):
  self.open();ad=self.fixture();ad['status']='hidden';ad['images']=['00000000-0000-0000-0000-000000000001'];self.ads=[ad];self.private_media=True;self.page.locator('[data-nav=mine]').click();self.page.wait_for_function("document.querySelector('.photo img')?.src.startsWith('blob:')");self.assertGreater(self.authorized_media,0)
 def test_13_preview_does_not_write_until_confirmed(self):
  self.open();self.page.locator('[data-nav=add]').click();self.page.locator('input[name=title]').fill('إعلان للمعاينة');self.page.locator('input[name=price]').fill('10000');self.page.locator('input[name=area]').fill('بغداد');self.page.get_by_role('button',name='نشر الإعلان',exact=True).click();self.assertTrue(self.page.locator('.preview').is_visible());self.assertFalse(any(c['body'].get('action')=='save' for c in self.calls));self.page.locator('input[name=title]').fill('عنوان بعد التعديل');self.assertEqual(self.page.locator('.preview').count(),0)
 def test_14_theme_tour_and_header_navigation(self):
  self.open();self.page.locator('#tour').click();self.assertEqual(self.page.locator('.tour-step').count(),3);self.page.get_by_role('button',name='ابدأ التصفح').click();self.assertEqual(self.page.evaluate("localStorage.getItem('waseet-tour-seen')"),'1');self.page.locator('#updates').click();self.assertIn('تحديثاتك',self.page.locator('#sheetTitle').inner_text());self.page.locator('#close').click();self.page.evaluate("window.Telegram.WebApp.colorScheme='dark';window.testTheme()");self.assertEqual(self.page.locator('html').get_attribute('data-theme'),'dark');self.page.wait_for_timeout(200);self.assertTrue(self.page.locator('#searchForm button').evaluate("e=>{const c=getComputedStyle(e),lum=s=>{const a=s.match(/\\d+/g).slice(0,3).map(v=>{v=+v/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return a[0]*.2126+a[1]*.7152+a[2]*.0722},x=lum(c.color),y=lum(c.backgroundColor);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)>=4.5}"))
 def test_15_card_contains_all_photos_without_opening_details(self):
  ad=self.fixture();ad['images']=['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002'];self.ads=[ad];self.open();self.assertEqual(self.page.locator('.card-gallery img').count(),2);self.assertEqual(self.page.locator('.card-gallery').evaluate('e=>getComputedStyle(e).scrollSnapType'),'x mandatory');self.assertFalse(self.page.locator('#sheet').is_visible())
 def test_16_share_uses_registered_market_short_name(self):
  self.open();self.page.locator('#shareMarket').click();url=self.page.evaluate('window.sharedLink');from urllib.parse import urlparse,parse_qs
  self.assertEqual(urlparse(url).path,'/share/url');self.assertEqual(parse_qs(urlparse(url).query)['url'],['https://t.me/WaseetIraqMarketBot/market'])
 def test_17_guest_login_uses_registered_app_and_does_not_create_account(self):
  self.open();self.page.evaluate("window.Telegram.WebApp.initData=''");self.page.locator('[data-nav=add]').click();link=self.page.locator('#sheetBody a');self.assertEqual(link.get_attribute('href'),'https://t.me/WaseetIraqMarketBot/market');self.assertFalse(any(c['body'].get('action')=='save' for c in self.calls))
 def test_18_academy_saves_each_lesson_and_server_result_before_application(self):
  self.open();self.page.locator('#account').click();self.page.get_by_role('button',name='انضم كمندوب لدى وسيط',exact=True).click();self.page.get_by_role('button',name='ابدأ التدريب والاختبار').click()
  for lesson in range(4):self.page.get_by_role('button',name='الدرس التالي',exact=True).click()
  self.page.get_by_role('button',name='ابدأ الاختبار',exact=True).click()
  for i in range(5):self.page.locator('input[name=q'+str(i)+'][value="1"]').check()
  self.page.locator('#sheetBody input[type=checkbox]').check();self.page.get_by_role('button',name='اعتماد نتيجة الاختبار').click();self.page.get_by_role('button',name='قدّم طلب انضمام').click();self.page.get_by_role('button',name='متابعة طلب الانضمام').click();self.page.locator('input[name=fullName]').fill('مندوب اختباري');self.page.locator('input[name=governorate]').fill('بغداد');self.page.locator('#sheetBody input[type=checkbox]').check();self.page.get_by_role('button',name='إرسال الطلب للإدارة').click();self.page.wait_for_function("document.querySelector('#sheetBody').textContent.includes('application-one')");self.assertEqual(len([c for c in self.calls if c['body'].get('action')=='lesson']),5);self.assertTrue(any(c['body'].get('action')=='quiz' for c in self.calls));self.assertFalse(any(c['body'].get('action')=='support' for c in self.calls));self.assertFalse(any(c['body'].get('action')=='admin_user' for c in self.calls))
 def test_19_owner_ui_does_not_offer_assigning_another_admin(self):
  self.role='admin';self.open();self.page.locator('#account').click();self.page.get_by_role('button',name='لوحة الإدارة').click();self.page.get_by_role('button',name='طلبات انضمام المندوبين').click();self.page.wait_for_function("document.querySelector('#sheetBody').textContent.includes('لا توجد طلبات')");self.assertEqual(self.page.get_by_role('button',name='تعيين مدير').count(),0)
if __name__=='__main__':unittest.main(verbosity=2)
