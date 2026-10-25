"""Safe full-interface review: synthetic state, external requests blocked, no hosted writes."""
import base64,json,os,functools,http.server,threading,urllib.request,urllib.error
from pathlib import Path
import unittest
import browser_app_security as security

class ComprehensiveTests(unittest.TestCase):
    setUpClass=classmethod(security.AppSecurityTests.setUpClass.__func__)
    tearDownClass=classmethod(security.AppSecurityTests.tearDownClass.__func__)
    setUp=security.AppSecurityTests.setUp
    tearDown=security.AppSecurityTests.tearDown
    def route(self,route):
        if route.request.url.startswith('blob:'+self.origin+'/'):route.continue_()
        else:security.AppSecurityTests.route(self,route)
    def fixture(self,role='admin'):
        self.page.evaluate("""role=>{
          document.querySelector('#splashScreen')?.remove();
          window.initChatFeature=async()=>{};window.refreshData=async()=>{};window.loadTeamActivity=async()=>{};
          profile={id:'audit-admin',full_name:'أحمد الربيعي',role,status:'approved',username:'audit.rep',username_locked:true};
          currentUser={id:'audit-admin',email:'audit@example.invalid'};
          goods=Array.from({length:18},(_,i)=>({id:'good'+i,title:'كرسي خشبي بحالة ممتازة '+i,created_at:new Date(2026,9,24-i).toISOString(),area:'بغداد — المنصور',status:i===2?'reserved':'available',asking_price:185000,description:'الصنف: أثاث\\nقطعة مناسبة للمنزل',image_urls:[]}));
          reps=[];sales=[];inquiries=[];showApp();render();
        }""",role)
    def chat(self):
        self.page.evaluate("""()=>{
          switchTab('chat');activeChatId='conversation';
          chatPeople=[{id:'sender',full_name:'سارة أحمد',role:'rep',avatar_url:location.origin+'/assets/waseet-icon.svg'}];
          chatConversations=[{id:'conversation',kind:'group',displayTitle:'مجموعة المندوبين'}];
          chatMessagePages.set('conversation',{hasOlder:true,rows:Array.from({length:24},(_,i)=>({id:'message'+i,sender_id:i%4===0?currentUser.id:'sender',body:i===20?'نص طويل '+('كلمة'.repeat(50))+' https://example.invalid/test':'رسالة تجريبية آمنة '+i,created_at:new Date(2026,9,24,10,i).toISOString()}))});
          document.querySelector('#chatListPanel').classList.add('hidden');document.querySelector('#chatConversationPanel').classList.remove('hidden');renderMessagePage('conversation');
        }""")
    def bounds(self,selector,viewport=True):
        box=self.page.locator(selector).bounding_box();self.assertIsNotNone(box,selector)
        self.assertGreaterEqual(box['x'],-1,selector)
        self.assertLessEqual(box['x']+box['width'],self.page.viewport_size['width']+1,selector)
        if viewport:
            self.assertGreaterEqual(box['y'],-1,selector)
            self.assertLessEqual(box['y']+box['height'],self.page.viewport_size['height']+1,selector)
        return box
    def test_all_tabs_layout_and_page_ends_at_requested_widths(self):
        self.fixture()
        tabs=['home','browse','inquiries','chat','account','more','sales','myCommissions','teamActivity','reps','requests']
        for width in [320,360,375,390,393,414,430,768]:
            for height in [568,844]:
                self.page.set_viewport_size({'width':width,'height':height})
                self.page.wait_for_function("Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--viewport-height'))-innerHeight)<2")
                self.page.evaluate("document.documentElement.style.setProperty('--safe-bottom','34px');document.documentElement.style.setProperty('--safe-top','24px')")
                for tab in tabs:
                    with self.subTest(width=width,height=height,tab=tab):
                        if tab=='myCommissions':self.page.evaluate("profile.role='rep';showApp();render()")
                        self.page.evaluate('(tab)=>switchTab(tab)',tab)
                        self.bounds('.header');nav=self.bounds('.bottom-nav')
                        self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth<=innerWidth+1 && document.querySelector('.content').scrollWidth<=document.querySelector('.content').clientWidth+1"))
                        if tab=='account':target=self.page.get_by_role('button',name='تسجيل الخروج',exact=True)
                        elif tab=='browse':target=self.page.locator('#goodsList .waseet-market-card').last
                        else:
                            if tab=='myCommissions':self.page.evaluate("profile.role='admin';showApp();render()")
                            continue
                        self.page.evaluate("document.querySelector('.content').scrollTop=document.querySelector('.content').scrollHeight");box=target.bounding_box()
                        self.assertLessEqual(box['y']+box['height'],nav['y']+1)
                self.page.evaluate("document.documentElement.style.removeProperty('--safe-bottom');document.documentElement.style.removeProperty('--safe-top')")
    def test_chat_composer_and_reading_surface_with_short_keyboard_viewports(self):
        self.fixture();self.chat()
        for width in [320,360,375,390,393,414,430,768]:
            for height in [320,400,568,844]:
                with self.subTest(width=width,height=height):
                    self.page.set_viewport_size({'width':width,'height':height})
                    self.page.locator('#chatMessageInput').focus();self.page.wait_for_timeout(30)
                    self.bounds('#chatMessageInput');self.bounds('#chatSendButton')
                    messages=self.bounds('#chatMessages');self.assertGreater(messages['height'],25)
                    self.assertTrue(self.page.evaluate("document.querySelector('#chatMessages').scrollWidth<=document.querySelector('#chatMessages').clientWidth+1"))
        self.assertEqual(self.page.locator('#chatMessages a').count(),1)
        self.assertEqual(self.page.locator('#chatMessages a').get_attribute('rel'),'noopener noreferrer')
    def test_every_dialog_is_scrollable_and_close_is_reachable(self):
        self.fixture();self.page.set_viewport_size({'width':320,'height':568})
        ids=self.page.locator('dialog').evaluate_all("nodes=>nodes.map(n=>n.id).filter(id=>!['photoViewer','notificationsDialog'].includes(id))")
        for name in ids:
            with self.subTest(dialog=name):
                self.page.evaluate("id=>{const node=document.getElementById(id);if(!node.open)node.showModal();}",name)
                box=self.bounds('#'+name)
                self.assertLessEqual(box['height'],540)
                buttons=self.page.locator('#'+name+' button:visible')
                if buttons.count():buttons.last.scroll_into_view_if_needed();self.bounds('#'+name+' button:visible >> nth='+str(buttons.count()-1))
                self.page.evaluate('id=>document.getElementById(id).close()',name)
    def test_avatar_shapes_failure_and_refresh_across_account_and_chat(self):
        self.fixture();self.chat()
        self.page.evaluate("profile.avatar_url=location.origin+'/assets/waseet-icon.svg';renderAccountView();renderMessagePage('conversation');")
        for selector in ['#bottomAccountAvatar','#accountAvatar','#chatMessages .waseet-avatar']:
            node=self.page.locator(selector).first
            result=node.evaluate("n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height,radius:getComputedStyle(n).borderRadius})")
            self.assertAlmostEqual(result['width'],result['height'],delta=1);self.assertEqual(result['radius'],'50%')
        self.page.evaluate("profile.avatar_url=location.origin+'/missing-profile.png';renderAccountView();")
        self.page.wait_for_function("!document.querySelector('#bottomAccountAvatar img')")
        self.assertEqual(self.page.locator('#bottomAccountAvatar img').count(),0)
        self.assertIn('أ',self.page.locator('#bottomAccountAvatar').text_content())
    def test_profile_upload_is_square_single_flight_and_updates_all_avatars(self):
        self.fixture();self.page.evaluate("switchTab('account')")
        data=self.page.evaluate("""()=>{const c=document.createElement('canvas');c.width=80;c.height=140;c.getContext('2d').fillRect(0,0,80,140);return c.toDataURL('image/png').split(',')[1];}""")
        self.page.evaluate("""()=>{window.uploads=0;window.avatarWrites=0;db={storage:{from:()=>({upload:(_path,blob)=>{uploads++;window.savedAvatarBlob=blob;return new Promise(resolve=>window.finishAvatar=resolve);},getPublicUrl:()=>({data:{publicUrl:location.origin+'/assets/waseet-icon.svg'}})})},rpc:async()=>{avatarWrites++;return {};}};}""")
        self.page.locator('#profilePhotoInput').set_input_files({'name':'portrait.png','mimeType':'image/png','buffer':base64.b64decode(data)})
        self.page.wait_for_function('uploads===1');self.page.evaluate('uploadProfilePhoto()')
        self.assertEqual(self.page.evaluate('uploads'),1)
        self.page.evaluate('finishAvatar({})');self.page.wait_for_function('avatarWrites===1 && !profilePhotoSaving')
        size=self.page.evaluate("""async()=>{const image=new Image();const url=URL.createObjectURL(savedAvatarBlob);image.src=url;await image.decode();URL.revokeObjectURL(url);return [image.naturalWidth,image.naturalHeight];}""")
        self.assertEqual(size,[80,80]);self.assertEqual(self.page.locator('#bottomAccountAvatar img').count(),1)
        self.assertIn('تم تحديث',self.page.locator('#profilePhotoStatus').text_content())
    def test_profile_upload_does_not_mutate_a_switched_account(self):
        self.fixture()
        self.page.evaluate("""()=>{window.avatarWrites=0;window.uploads=0;db={storage:{from:()=>({upload:()=>{uploads++;return new Promise(r=>window.finishAvatar=r)},getPublicUrl:()=>({data:{publicUrl:location.origin+'/assets/waseet-icon.svg'}})})},rpc:async()=>{avatarWrites++;return {}}};}""")
        data=self.page.evaluate("()=>{const c=document.createElement('canvas');c.width=c.height=10;return c.toDataURL().split(',')[1]}")
        self.page.locator('#profilePhotoInput').set_input_files({'name':'a.png','mimeType':'image/png','buffer':base64.b64decode(data)})
        self.page.wait_for_function('uploads===1');self.page.evaluate("currentUser={id:'other-account'};finishAvatar({})")
        self.page.wait_for_function('!profilePhotoSaving');self.assertEqual(self.page.evaluate('avatarWrites'),0)
    def test_saved_push_subscription_never_flashes_a_gate_or_toggles_itself(self):
        self.fixture('rep')
        self.page.evaluate("""()=>{currentUser.created_at=new Date().toISOString();window.gateOpens=0;window.subscribes=0;window.unsubscribes=0;window.deviceSub={endpoint:'https://example.invalid/push',toJSON:()=>({}),unsubscribe:()=>{unsubscribes++;}};Object.defineProperty(window,'Notification',{configurable:true,value:{permission:'granted'}});Object.defineProperty(window,'PushManager',{configurable:true,value:function(){}});Object.defineProperty(navigator.serviceWorker,'register',{configurable:true,value:()=>new Promise(r=>window.finishRegistration=r)});db={from:()=>({upsert:async()=>({})})};const dialog=document.querySelector('#notificationGateDialog');const open=dialog.showModal.bind(dialog);dialog.showModal=()=>{gateOpens++;open()};pushCheckState='unknown';pushSubscription=null;window.gatePending=showNotificationGate();}""")
        self.assertEqual(self.page.evaluate('gateOpens'),0)
        self.page.evaluate("finishRegistration({pushManager:{getSubscription:async()=>deviceSub,subscribe:()=>{subscribes++}}})")
        self.page.evaluate('async()=>await gatePending')
        self.assertEqual(self.page.evaluate('[gateOpens,subscribes,unsubscribes]'),[0,0,0])
    def test_login_is_single_flight_and_errors_never_echo_private_details(self):
        self.page.evaluate("""()=>{window.loginCalls=0;window.authAlerts=[];window.alert=m=>authAlerts.push(m);db={auth:{signInWithPassword:()=>{loginCalls++;return new Promise(r=>window.finishLogin=r)}}};document.querySelector('#loginEmail').value='audit@example.invalid';document.querySelector('#loginPassword').value='synthetic-password';window.loginOne=handleLogin();handleLogin();}""")
        self.assertEqual(self.page.evaluate('loginCalls'),1)
        self.page.evaluate("async()=>{finishLogin({error:{code:'invalid_credentials',message:'PRIVATE AUTH DETAIL'}});await loginOne;}")
        self.assertNotIn('PRIVATE',self.page.evaluate('authAlerts.join()'))
        self.assertIn('البريد',self.page.evaluate('authAlerts.join()'))
    def test_real_service_worker_loads_the_public_shell_offline(self):
        # Stop a dedicated origin server rather than using WebKit's offline
        # emulation, which can fail navigation internally before dispatching SW.
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(security.QuietHandler,directory=str(Path(__file__).resolve().parents[1])))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        origin=f'http://127.0.0.1:{server.server_port}'
        context=self.browser.new_context(service_workers='allow');stopped=False
        try:
            page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
            page.route('**/*',lambda route:route.continue_() if route.request.url.startswith(origin+'/') else route.abort())
            page.goto(origin,wait_until='networkidle')
            page.wait_for_function('Boolean(navigator.serviceWorker.controller)',timeout=20000)
            server.shutdown();server.server_close();thread.join();stopped=True
            with self.assertRaises(urllib.error.URLError):urllib.request.urlopen(origin,timeout=2)
            page.reload(wait_until='domcontentloaded');page.wait_for_timeout(250)
            self.assertTrue(page.locator('#welcomeView').is_visible())
            page.locator('[data-entry=login]').click();self.assertTrue(page.locator('#loginEmail').is_visible())
            self.assertEqual(errors,[])
        finally:
            context.close()
            if not stopped:server.shutdown();server.server_close();thread.join()

    def test_public_sharing_excludes_marked_owner_contacts_and_fees(self):
        self.fixture()
        self.page.evaluate(r"""()=>{goods=[{id:'private-detail',title:'كرسي',status:'available',asking_price:1000,description:'تفاصيل إضافية: اسم صاحب الغرض: PRIVATE OWNER\nعمولة الإدارة: PRIVATE FEE\nowner_phone: PRIVATE PHONE'}];shareSingleGoodOnWhatsApp('private-detail');}""")
        self.assertNotIn('PRIVATE',self.page.evaluate('decodeURIComponent(opened[0])'))
        self.page.evaluate("shareSingleGoodOnFacebook('private-detail')")
        self.assertNotIn('PRIVATE',self.page.evaluate('decodeURIComponent(opened[0])'))
    def test_safe_area_simulation_keeps_composer_and_modal_controls_accessible(self):
        self.fixture();self.chat()
        for width in [320,390,768]:
            for height in [360,844]:
                self.page.set_viewport_size({'width':width,'height':height})
                self.page.evaluate("document.documentElement.style.setProperty('--safe-top','47px');document.documentElement.style.setProperty('--safe-bottom','34px')")
                self.page.locator('#chatMessageInput').focus();self.page.wait_for_timeout(40)
                self.bounds('#chatSendButton');self.bounds('#chatMessageInput')
        self.page.set_viewport_size({'width':390,'height':568})
        self.page.evaluate("document.activeElement.blur();showDialog('inquiryDialog')")
        self.page.wait_for_timeout(40);box=self.bounds('#inquiryDialog')
        self.assertGreaterEqual(box['y'],47);self.assertLessEqual(box['y']+box['height'],534)

    def test_notification_settings_navigate_without_toggling_a_subscription(self):
        self.fixture()
        self.page.evaluate("window.toggles=0;window.togglePushNotifications=()=>toggles++;document.querySelector('#notificationsDialog').show()")
        self.page.locator('.waseet-popover-settings').click()
        self.assertEqual(self.page.evaluate('toggles'),0)
        self.assertTrue(self.page.locator('#accountView').is_visible())
    def test_an_old_push_check_cannot_overwrite_a_new_account_check(self):
        self.fixture()
        self.page.evaluate("""()=>{window.registrations=0;window.boundUsers=[];Object.defineProperty(window,'Notification',{configurable:true,value:{permission:'granted'}});Object.defineProperty(window,'PushManager',{configurable:true,value:function(){}});Object.defineProperty(navigator.serviceWorker,'register',{configurable:true,value:async()=>({pushManager:{getSubscription:()=>{registrations++;return registrations===1?new Promise(r=>window.finishOldPush=r):Promise.resolve({endpoint:'https://example.invalid/new',toJSON:()=>({})})}}})});db={from:()=>({upsert:async payload=>{boundUsers.push(payload.user_id);return {}}})};pushCheckState='unknown';pushSubscription=null;window.firstCheck=initPushNotifications();}""")
        self.page.wait_for_function('registrations===1')
        self.page.evaluate("async()=>{currentUser={id:'new-account'};await initPushNotifications();finishOldPush(null);await firstCheck;}")
        self.assertEqual(self.page.evaluate('pushCheckState'),'enabled')
        self.assertEqual(self.page.evaluate('boundUsers'),['new-account'])

    def test_offline_banner_and_safe_return_to_online(self):
        self.fixture();self.context.set_offline(True);self.page.wait_for_timeout(50)
        self.assertIn('غير محدثة',self.page.locator('#connectionStatus').text_content())
        self.context.set_offline(False);self.page.wait_for_timeout(50)
        self.assertIn('عاد الاتصال',self.page.locator('#connectionStatus').text_content())
    def test_very_long_titles_and_maximum_safe_amounts_remain_inside_the_screen(self):
        self.fixture();self.page.set_viewport_size({'width':320,'height':568})
        self.page.evaluate("goods[0].title='غرض'.repeat(80);goods[0].description='وصف'.repeat(500);goods[0].asking_price=Number.MAX_SAFE_INTEGER;render();switchTab('browse')")
        self.assertTrue(self.page.evaluate("document.querySelector('.content').scrollWidth<=document.querySelector('.content').clientWidth+1"))
        self.page.evaluate("openGoodDetails('good0')");self.bounds('#goodDetailsDialog')
        self.assertTrue(self.page.locator('#goodDetailsDialog').evaluate('n=>n.scrollWidth<=n.clientWidth+1'))

    def test_logout_clears_hidden_account_details_and_customer_drafts(self):
        self.fixture();self.page.evaluate("renderAccountView();document.querySelector('#inquiryForm input[name=buyerName]').value='PRIVATE CUSTOMER';clearAccountState()")
        self.assertNotIn('audit@example.invalid',self.page.locator('#accountView').text_content())
        self.assertEqual(self.page.locator('#inquiryForm input[name=buyerName]').input_value(),'')
        self.assertEqual(self.page.locator('#accountAvatar img,#bottomAccountAvatar img').count(),0)

    def test_stored_notification_and_request_ids_cannot_execute_javascript(self):
        self.fixture()
        injected="id');window.injected=true;//"
        self.page.evaluate("""id=>{notifications=[{id,title:'إشعار آمن',body:'<img src=x>',created_at:new Date().toISOString()}];renderNotificationsList();window.openNotificationItem=id=>window.selectedNotice=id;externalListings=[{id,title:'طلب آمن',status:'pending',image_urls:['javascript:alert(1)']}];renderExternalListings();window.deleteExternalListing=id=>window.selectedRequest=id;}""",injected)
        self.assertEqual(self.page.locator('#notificationsList [onclick],#externalListingsList [onclick]').count(),0)
        self.assertEqual(self.page.locator('#externalListingsList img').count(),0)
        self.page.locator('[data-notification-id]').evaluate('node=>node.click()')
        self.page.locator('[data-external-delete]').evaluate('node=>node.click()')
        self.assertEqual(self.page.evaluate('selectedNotice'),injected)
        self.assertEqual(self.page.evaluate('selectedRequest'),injected)
        self.assertFalse(self.page.evaluate('Boolean(window.injected)'))
    def test_denied_and_unknown_navigation_preserve_the_current_page(self):
        self.fixture('rep')
        self.page.evaluate("switchTab('home');switchTab('requests');switchTab('does-not-exist')")
        self.assertTrue(self.page.locator('#homeView').is_visible())
        self.assertFalse(self.page.locator('#requestsView').is_visible())
        self.assertEqual(self.page.locator('.bottom-nav [aria-current=page]').count(),1)

    def test_safe_message_links_and_input_composition(self):
        self.fixture();self.chat()
        value=self.page.evaluate("chatBody('<img src=x onerror=alert(1)> https://example.invalid/\" onclick=\"alert(1)')")
        self.assertNotIn('<img',value);self.assertNotIn(' onclick=',value.split('</a>')[0])
        self.page.evaluate("window.imeSends=0;window.sendChatMessage=()=>imeSends++;document.querySelector('#chatMessageInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));")
        self.assertEqual(self.page.evaluate('imeSends'),0)

    def test_service_errors_do_not_expose_sql_or_response_bodies(self):
        self.fixture('rep')
        self.page.evaluate("""()=>{window.rawBodyRead=false;window.safeAlerts=[];window.alert=m=>safeAlerts.push(m);db.rpc=async()=>({error:{message:'PRIVATE SQL DETAIL'}});db.functions={invoke:async()=>({error:{message:'PRIVATE TOKEN DETAIL',context:{clone:()=>{rawBodyRead=true;return {text:async()=> 'PRIVATE BODY'}}}}})};renderAccountView();document.querySelector('#requestedFullName').value='اسم جديد';}""")
        self.page.evaluate('requestNameChange()')
        result=self.page.evaluate("sendPushEvent('test_push')")
        self.assertFalse(self.page.evaluate('rawBodyRead'))
        self.assertNotIn('PRIVATE',str(result))
        self.assertNotIn('PRIVATE',str(self.page.evaluate('safeAlerts')))
        self.assertTrue(self.page.evaluate('safeAlerts.length>0'))

    def test_push_context_tracks_only_the_focused_open_conversation(self):
        self.fixture();self.chat()
        self.page.evaluate("""()=>{window.contextCalls=[];pushSubscription={endpoint:'https://push.invalid/device'};db={functions:{invoke:async(_name,options)=>{contextCalls.push(options.body);return {data:{ok:true}};}}};activeChatId='00000000-0000-0000-0000-000000000001';window.focus();updateChatPushPresence();}""")
        self.page.wait_for_function('contextCalls.length>0 && !chatPushPending')
        self.assertEqual(self.page.evaluate('contextCalls.at(-1).conversationId'),'00000000-0000-0000-0000-000000000001')
        self.page.evaluate("switchTab('home')")
        self.page.wait_for_function('contextCalls.at(-1).conversationId===null && !chatPushPending')
        self.page.evaluate("switchTab('chat')")
        self.page.wait_for_function('contextCalls.at(-1).conversationId!==null && !chatPushPending')
        self.page.evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))")
        self.page.wait_for_function('contextCalls.at(-1).conversationId===null && !chatPushPending')
        self.page.evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});activeChatId='00000000-0000-0000-0000-000000000002';updateChatPushPresence()")
        self.page.wait_for_function("contextCalls.at(-1).conversationId==='00000000-0000-0000-0000-000000000002' && !chatPushPending")
        self.page.evaluate("backToChatList()")
        self.page.wait_for_function('contextCalls.at(-1).conversationId===null')

    def test_hung_push_context_times_out_and_flushes_navigation(self):
        self.fixture();self.chat()
        self.page.evaluate("""()=>{window.contextCalls=[];window.savedContextTimeout=window.setTimeout;window.setTimeout=(fn,delay,...args)=>{if(delay===4000){window.fireContextDeadline=fn;return 0;}return savedContextTimeout(fn,delay,...args);};pushSubscription={endpoint:'https://push.invalid/device'};db={functions:{invoke:(_name,options)=>{contextCalls.push(options.body);return contextCalls.length===1?new Promise(()=>{}):Promise.resolve({data:{ok:true}});}}};updateChatPushPresence();}""")
        self.page.wait_for_function('contextCalls.length===1 && Boolean(chatPushPending)',timeout=5000)
        self.page.evaluate("switchTab('home');fireContextDeadline()")
        self.page.wait_for_function('contextCalls.length===2 && !chatPushPending',timeout=5000)
        self.assertIsNone(self.page.evaluate('contextCalls[1].conversationId'))
        self.page.evaluate('window.setTimeout=savedContextTimeout')

if __name__=='__main__':unittest.main()
