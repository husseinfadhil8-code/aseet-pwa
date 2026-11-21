"""Synthetic local UI and simulated visual viewport coverage; no real Safari claim."""
from playwright.sync_api import sync_playwright, expect
from pathlib import Path
import json
results=[]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width,height in [(320,568),(390,844),(430,932),(768,1024)]:
  page=b.new_page(viewport={'width':width,'height':height});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.add_init_script('''const vv=new EventTarget();vv.height=innerHeight;vv.offsetTop=0;Object.defineProperty(window,'visualViewport',{value:vv});window.testCoveredBottom=n=>{vv.height=innerHeight-n;vv.dispatchEvent(new Event('resize'));};''')
  page.goto('http://127.0.0.1:4389');page.locator('#token').fill('admin-test-'*5);page.locator('#login button').click();expect(page.locator('#panel')).to_be_visible()
  assert page.locator('#panel > nav').evaluate('(e)=>getComputedStyle(e).position')=='static'
  for el in page.locator('#panel > nav button').all():
   rect=el.bounding_box();assert rect['height']>=44 and rect['width']>0
  before=page.locator('main').evaluate('(e)=>parseFloat(getComputedStyle(e).paddingBottom)')
  page.evaluate('testCoveredBottom(160)');page.wait_for_function("() => parseFloat(getComputedStyle(document.querySelector('main')).paddingBottom)>=200")
  after=page.locator('main').evaluate('(e)=>parseFloat(getComputedStyle(e).paddingBottom)');assert after-before>=160
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  page.evaluate('testCoveredBottom(0)');page.wait_for_function("() => getComputedStyle(document.documentElement).getPropertyValue('--covered-bottom').trim()==='0px'")
  assert not errors,errors
  if width==390:
   Path('/workspace/mandob-baghdad-artifacts').mkdir(exist_ok=True);page.screenshot(path='/workspace/mandob-baghdad-artifacts/admin-iphone-toolbar-layout.png',full_page=True)
  results.append({'width':width,'height':height,'reserved_covered_bottom':after-before,'js_errors':errors});page.close()
 b.close();print(json.dumps({'results':results,'actual_iPhone':False,'webkit_available':Path(p.webkit.executable_path).exists()}))
