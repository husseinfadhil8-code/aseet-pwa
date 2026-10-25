"""Capture only synthetic interface state; all nonlocal network requests are blocked."""
import argparse,json,sys
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--root',default=str(Path(__file__).resolve().parents[1]));parser.add_argument('--output',required=True);args=parser.parse_args()
sys.path.insert(0,str(Path(args.root)/'scripts'))
from browser_comprehensive import ComprehensiveTests
ComprehensiveTests.setUpClass();test=ComprehensiveTests();test.setUp()
try:
 p=test.page;out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
 original=test.route
 def route(request):
  if request.request.url==test.origin+'/fixture-chair.svg':request.fulfill(content_type='image/svg+xml',body='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 420"><rect width="600" height="420" fill="#f1eee8"/><ellipse cx="300" cy="365" rx="140" ry="20" fill="#dcd9d3"/><g stroke="#795c3c" stroke-width="18" stroke-linecap="round"><path d="M210 270v85m180-85v85M200 200v80h200v-80"/></g><rect x="208" y="80" width="184" height="150" rx="32" fill="#9baf96"/><rect x="180" y="220" width="240" height="60" rx="22" fill="#7e987a"/></svg>')
  else:original(request)
 p.unroute('**/*');p.route('**/*',route)
 test.fixture()
 p.evaluate("""()=>{goods.forEach(g=>g.image_urls=[location.origin+'/fixture-chair.svg']);reps=[{id:'sender',full_name:'سارة أحمد',status:'approved',role:'rep'},{id:'rep2',full_name:'علي حسن',status:'pending',role:'rep'}];inquiries=Array.from({length:6},(_,i)=>({id:'inq'+i,goods_id:'good'+i,rep_id:'sender',buyer_name:'زبون تجريبي',buyer_phone:'00000000000',notes:'يرغب بمعرفة المقاسات المتاحة',created_at:'2026-10-25T10:00:00Z'}));sales=Array.from({length:5},(_,i)=>({id:'sale'+i,goods_id:'good'+i,rep_id:'sender',price:185000,total_commission:15000,rep_share:10000,customer_name:'زبون تجريبي',created_at:'2026-10-25T10:00:00Z'}));render();updatePushButton();}""")
 for width in [390,768]:
  p.set_viewport_size({'width':width,'height':844});p.wait_for_timeout(70)
  for tab in ['home','browse','account','inquiries','sales','reps','more','teamActivity']:
   p.evaluate('(tab)=>switchTab(tab)',tab);p.evaluate("document.querySelector('.content').scrollTop=0");p.wait_for_timeout(50)
   p.screenshot(path=str(out/(str(width)+'-'+tab+'.png')))
  if p.locator('#requestsView').count():
   p.evaluate("switchTab('requests')");p.screenshot(path=str(out/(str(width)+'-requests.png')))
  test.chat();p.screenshot(path=str(out/(str(width)+'-chat.png')))
 p.set_viewport_size({'width':390,'height':844});p.evaluate("profile.role='rep';sales[0].rep_id=currentUser.id;reps.push({id:currentUser.id,full_name:profile.full_name,status:'approved',role:'rep'});showApp();render();switchTab('myCommissions')");p.screenshot(path=str(out/'390-my-commissions.png'));p.evaluate("profile.role='admin';showApp();render()");test.chat()
 p.set_viewport_size({'width':390,'height':360});p.locator('#chatMessageInput').focus();p.wait_for_timeout(80);p.screenshot(path=str(out/'390-keyboard.png'))
 p.set_viewport_size({'width':390,'height':844});p.evaluate("document.querySelector('#appView').classList.add('hidden');document.querySelector('#welcomeView').classList.remove('hidden')");p.screenshot(path=str(out/'390-welcome.png'))
 p.locator('[data-entry=login]').click();p.screenshot(path=str(out/'390-login.png'))
 print(json.dumps({'screenshots':len(list(out.glob('*.png'))),'page_errors':test.errors,'synthetic_data_only':True}))
 assert not test.errors
finally:
 test.context.close();ComprehensiveTests.tearDownClass()
