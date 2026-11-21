"""Virtual Chromium authenticator only; route transport is local, not production TLS or iPhone."""
from playwright.sync_api import sync_playwright,expect
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 c=b.new_context(viewport={'width':390,'height':844})
 def route(r):
  response=c.request.fetch('http://127.0.0.1:4390'+r.request.url.split('admin.example.test',1)[1],method=r.request.method,headers=r.request.headers, data=r.request.post_data, max_redirects=0)
  r.fulfill(response=response)
 c.route('https://admin.example.test/**',route)
 page=c.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 session=c.new_cdp_session(page);session.send('WebAuthn.enable');session.send('WebAuthn.addVirtualAuthenticator',{'options':{'protocol':'ctap2','transport':'internal','hasResidentKey':True,'hasUserVerification':True,'isUserVerified':True,'automaticPresenceSimulation':True}})
 page.goto('https://admin.example.test/login');page.locator('details').evaluate('(el)=>el.open=true');page.locator('#code').fill('x'*43);page.locator('#enroll button').click();expect(page.locator('#status')).to_contain_text('تم حفظ مفتاح المرور')
 page.locator('#signin').click();page.wait_for_url('https://admin.example.test/');expect(page.locator('#panel')).to_be_visible();expect(page.locator('#login')).to_be_hidden()
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
 assert '__Host-mandob_session' not in page.evaluate('document.cookie')
 page.get_by_role('button',name='إلغاء كل الجلسات',exact=True).click();page.wait_for_url('https://admin.example.test/login');assert not errors,errors
 print({'virtual_authenticator':'registration/login/revoke passed','viewport':[390,844],'js_errors':errors,'real_iPhone':False})
 b.close()
