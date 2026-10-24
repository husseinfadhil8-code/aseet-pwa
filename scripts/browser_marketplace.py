"""Marketplace/auth regression tests; all external requests intercepted, no hosted writes."""
import unittest
import browser_app_security as security

class MarketplaceTests(unittest.TestCase):
    setUpClass=classmethod(security.AppSecurityTests.setUpClass.__func__)
    tearDownClass=classmethod(security.AppSecurityTests.tearDownClass.__func__)
    setUp=security.AppSecurityTests.setUp
    tearDown=security.AppSecurityTests.tearDown
    route=security.AppSecurityTests.route

    def show_auth(self):
        self.page.evaluate("""() => {
          document.querySelector('#splashScreen')?.remove();
          document.querySelector('#welcomeView').classList.add('hidden');
          document.querySelector('#authView').classList.remove('hidden');
          window.alerts=[];window.alert=message=>alerts.push(message);
        }""")

    def signup_fields(self):
        self.show_auth()
        self.page.evaluate("switchAuthMode('signup')")
        for name,value in [('signupName','مندوب اختبار'),('signupUsername','rep_test'),('signupEmail','test@example.invalid'),('signupPassword','safe-test-password')]:
            self.page.locator('#'+name).fill(value)

    def fixture_goods(self):
        self.page.evaluate("""() => {
          goods=[{id:'one',title:'كرسي عصري',area:'بغداد',status:'available',asking_price:185000,description:'الصنف: أثاث'},
            {id:'two',title:'هاتف',area:'البصرة',status:'sold',asking_price:90000},
            {id:'three',title:'مكتب',area:'بغداد',status:'reserved',asking_price:150000}];
          document.querySelector('#splashScreen')?.remove();
          document.querySelector('#welcomeView').classList.add('hidden');
          document.querySelector('#appView').classList.remove('hidden');render();
        }""")

    def test_login_double_submit_and_recovery_on_error(self):
        self.show_auth()
        self.page.locator('#loginEmail').fill('test@example.invalid')
        self.page.locator('#loginPassword').fill('incorrect')
        self.page.evaluate("""() => {window.calls=0;db={auth:{signInWithPassword:()=>{calls++;return new Promise(resolve=>window.finishLogin=resolve);}}};window.loginPromise=handleLogin();handleLogin();}""")
        self.assertEqual(self.page.evaluate('calls'),1)
        self.assertTrue(self.page.locator('#loginButton').is_disabled())
        self.page.evaluate("async()=>{finishLogin({error:{message:'Invalid login credentials'}});await loginPromise;}")
        self.assertFalse(self.page.locator('#loginButton').is_disabled())
        self.assertIn('غير صحيحة',self.page.locator('#authMessage').inner_text())
        self.assertEqual(self.errors,[])

    def test_login_empty_fields_do_not_send_request(self):
        self.show_auth()
        self.page.evaluate("() => {db=null;handleLogin();}")
        self.assertIn('يرجى إدخال',self.page.locator('#authMessage').inner_text())

    def test_confirmation_signup_does_not_write_profile_without_session(self):
        self.signup_fields()
        self.page.evaluate("""async()=>{
          db={rpc:async()=>({data:true}),auth:{signUp:async()=>({data:{user:{id:'new',identities:[{}]},session:null}})},from:()=>{throw new Error('Anonymous profile write forbidden');}};
          await handleSignup();
        }""")
        self.assertIn('تأكيد الحساب',self.page.locator('#authMessage').inner_text())
        self.assertFalse(self.page.locator('#signupForm button[onclick="handleSignup()"]').is_disabled())
        self.assertEqual(self.errors,[])

    def test_existing_profile_authority_is_never_upserted(self):
        self.page.evaluate("""async()=>{
          db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{id:'existing'}})})}),insert:()=>{throw new Error('Existing profile must not be rewritten');}})};
          await ensurePendingProfile({id:'existing',user_metadata:{}});
        }""")
        self.assertEqual(self.errors,[])

    def test_confirmed_session_creates_only_canonical_pending_profile(self):
        self.page.evaluate("""async()=>{
          db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:null})})}),insert:async payload=>{window.inserted=payload;return {};}})};
          await ensurePendingProfile({id:'test-id',user_metadata:{full_name:'اسم',username:'rep_test',role:'admin',status:'approved',permissions:{admin:true}}});
        }""")
        value=self.page.evaluate('window.inserted')
        self.assertEqual((value['role'],value['status']),('rep','pending'))
        self.assertEqual(value['permissions'],{'can_add_inquiry':True})

    def test_username_collision_does_not_report_a_saved_request(self):
        result=self.page.evaluate("""async()=>{
          db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:null})})}),insert:async()=>({error:{code:'23505'}})})};
          try{await ensurePendingProfile({id:'new',user_metadata:{username:'taken',full_name:'اسم'}});return false;}
          catch(error){return error.profileConflict===true;}
        }""")
        self.assertTrue(result)

    def test_username_collision_can_be_completed_without_registering_again(self):
        self.show_auth()
        self.page.evaluate("showProfileCompletion({id:'new',user_metadata:{full_name:'اسم تجريبي'}})")
        self.page.locator('#completeProfileUsername').fill('new_available_name')
        self.page.evaluate("""async()=>{
          db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:null})})}),insert:async payload=>{window.completed=payload;return {};}}),auth:{signOut:async()=>{}}};
          await completePendingProfile();
        }""")
        self.assertEqual(self.page.evaluate('completed.username'),'new_available_name')
        self.assertEqual(self.page.evaluate('completed.status'),'pending')
        self.assertIn('بانتظار موافقة',self.page.locator('#authMessage').inner_text())

    def test_signup_double_submit_and_hidden_duplicate_do_not_write(self):
        self.signup_fields()
        self.page.evaluate("""()=>{window.calls=0;db={rpc:()=>{calls++;return new Promise(resolve=>window.finishCheck=resolve);},auth:{signUp:async()=>({data:{user:{id:'existing',identities:[]}}})},from:()=>{throw new Error('No profile mutation');}};window.signupPromise=handleSignup();handleSignup();}""")
        self.assertEqual(self.page.evaluate('calls'),1)
        self.page.evaluate("async()=>{finishCheck({data:true});await signupPromise;}")
        self.assertIn('مسجّل',self.page.locator('#authMessage').inner_text())
        self.assertEqual(self.errors,[])

    def test_reset_password_sends_neutral_message(self):
        self.show_auth()
        self.page.locator('#loginEmail').fill('test@example.invalid')
        self.page.evaluate("""async()=>{db={auth:{resetPasswordForEmail:async(email,options)=>{window.reset={email,options};return {};}}};await handlePasswordReset();}""")
        self.assertIn('إذا كان البريد',self.page.locator('#authMessage').inner_text())
        self.assertEqual(self.page.evaluate('reset.email'),'test@example.invalid')

    def test_recovery_form_updates_password_and_signs_out(self):
        self.show_auth()
        self.page.evaluate("showRecovery()")
        self.page.locator('#recoveryPassword').fill('new-safe-password')
        self.page.evaluate("""async()=>{db={auth:{updateUser:async value=>{window.updated=value;return {};},signOut:async()=>{window.signedOut=true;}}};await handlePasswordUpdate();}""")
        self.assertTrue(self.page.evaluate('signedOut'))
        self.assertIn('تم تحديث',self.page.locator('#authMessage').inner_text())

    def test_search_status_and_price_filters(self):
        self.fixture_goods()
        self.assertEqual(self.page.locator('[data-card-index]').count(),1)
        self.page.locator('.advanced-filters').evaluate('node=>node.open=true')
        self.page.locator('#goodsStatusFilter').select_option('all')
        self.assertEqual(self.page.locator('[data-card-index]').count(),3)
        self.page.locator('#goodsSearch').fill('بغداد')
        self.assertEqual(self.page.locator('[data-card-index]').count(),2)
        self.page.locator('#goodsMaxPrice').fill('160000')
        self.assertEqual(self.page.locator('[data-card-index]').count(),1)
        self.assertIn('محجوز',self.page.locator('#goodsList').inner_text())
        self.assertEqual(self.page.locator('[data-card-action=sale]').count(),0)

    def test_card_id_cannot_execute_javascript(self):
        self.fixture_goods()
        self.page.evaluate("""()=>{goods[0].id=\"');window.pwned=true;//\";window.openGoodDetails=id=>window.detailId=id;render();}""")
        self.page.locator('[data-card-action=details]').click()
        self.assertFalse(self.page.evaluate('Boolean(window.pwned)'))
        self.assertEqual(self.page.evaluate('detailId'),"');window.pwned=true;//")

    def test_rtl_carousel_updates_counter(self):
        self.fixture_goods()
        self.page.evaluate("""()=>{goods[0].image_urls=['https://images.invalid/a.png','https://images.invalid/b.png'];render();const track=document.querySelector('.waseet-swipe-track');track.scrollLeft=-track.clientWidth;track.dispatchEvent(new Event('scroll'));}""")
        self.page.wait_for_function("document.querySelector('.waseet-photo-count').textContent.includes('2/2')")
        self.assertIn('2/2',self.page.locator('.waseet-photo-count').inner_text())

    def test_zoom_dialog_accepts_only_safe_urls(self):
        self.page.evaluate("openPhotoViewer('javascript:window.pwned=true','bad')")
        self.assertFalse(self.page.locator('#photoViewer').evaluate('node=>node.open'))
        self.page.evaluate("openPhotoViewer('https://images.invalid/safe.png','صورة')")
        self.assertTrue(self.page.locator('#photoViewer').evaluate('node=>node.open'))
        self.page.locator('[data-viewer-zoom]').click()
        self.assertTrue(self.page.locator('#photoViewer').evaluate("node=>node.classList.contains('zoomed')"))
        self.page.locator('[data-viewer-close]').click()
        self.assertFalse(self.page.locator('#photoViewer').evaluate('node=>node.open'))

    def test_saved_images_can_be_reordered_removed_without_replacement(self):
        self.fixture_goods()
        self.page.evaluate("()=>{goods[0].image_urls=['https://images.invalid/a.png','https://images.invalid/b.png'];editGoods('one');}")
        self.page.locator('.image-editor-item').nth(1).get_by_role('button',name='تقديم الصورة 2',exact=True).click()
        self.assertEqual(self.page.evaluate('retainedGoodsImages[0]'),'https://images.invalid/b.png')
        self.page.get_by_role('button',name='حذف الصورة 1',exact=True).click()
        self.assertEqual(self.page.evaluate('retainedGoodsImages'),['https://images.invalid/a.png'])

    def test_navigation_preserves_admin_tools_and_inquiries(self):
        self.fixture_goods()
        self.page.locator('.bottom-nav button').nth(4).click()
        self.page.get_by_role('button',name='أدواتي وإدارة المنصة',exact=True).click()
        self.assertTrue(self.page.locator('#moreView').is_visible())
        self.assertGreater(self.page.locator('#moreView [onclick*="inquiries"]').count(),0)

    def test_pending_and_banned_sessions_never_open_app(self):
        self.show_auth()
        for status in ['pending','banned']:
            self.page.evaluate("""async status=>{
              window.ensurePendingProfile=async()=>{};
              window.loadProfile=async()=>{profile={role:'rep',status};};
              db={auth:{signOut:async()=>{window.signedOut=true;}}};
              document.querySelector('#appView').classList.add('hidden');
              await startApp({id:'test'});
            }""",status)
            self.assertTrue(self.page.locator('#appView').evaluate("node=>node.classList.contains('hidden')"))
            self.assertTrue(self.page.evaluate('signedOut'))
        self.assertIn('بانتظار موافقة',self.page.locator('#authMessage').inner_text())

    def test_chat_sends_once_and_keeps_failed_text(self):
        self.page.evaluate("""()=>{
          activeChatId='conversation';document.querySelector('#chatMessageInput').value='رسالة اختبار';
          window.calls=0;window.alert=()=>{};
          db={from:()=>({insert:()=>{calls++;return {select:()=>({single:()=>new Promise(resolve=>window.finishSend=resolve)})};}})};
          window.sending=sendChatMessage();sendChatMessage();
        }""")
        self.assertEqual(self.page.evaluate('calls'),1)
        self.page.evaluate("async()=>{finishSend({error:{message:'offline'}});await sending;}")
        self.assertEqual(self.page.locator('#chatMessageInput').input_value(),'رسالة اختبار')
        self.assertFalse(self.page.locator('#chatSendButton').is_disabled())

    def test_chat_loads_latest_messages_in_chronological_order(self):
        self.page.evaluate("""async()=>{
          activeChatId='conversation';window.orderCalls=[];
          const query={select:()=>query,eq:()=>query,order:(field,options)=>{orderCalls.push({field,options});return query;},limit:async()=>({data:[{id:'b',body:'الأحدث',sender_id:'x'},{id:'a',body:'الأقدم',sender_id:'x'}]})};
          const memberQuery={eq:()=>memberQuery};
          db={from:table=>table==='chat_messages'?query:{update:()=>memberQuery}};
          await loadChatMessages('conversation');
        }""")
        self.assertEqual(self.page.locator('.chat-message-body').all_text_contents(),['الأقدم','الأحدث'])
        self.assertFalse(self.page.evaluate('orderCalls[0].options.ascending'))

    def test_refresh_requests_share_one_in_flight_operation(self):
        self.page.evaluate("""()=>{window.calls=0;window.fetchAppData=()=>{calls++;return new Promise(resolve=>window.finishRefresh=resolve);};window.firstRefresh=refreshData();window.secondRefresh=refreshData();}""")
        self.assertEqual(self.page.evaluate('calls'),1)
        self.page.evaluate("async()=>{finishRefresh();await Promise.all([firstRefresh,secondRefresh]);}")
        self.assertTrue(self.page.evaluate('refreshInFlight===null'))

    def test_logout_after_restored_session_returns_to_visible_welcome(self):
        self.fixture_goods()
        self.page.evaluate("async()=>{document.querySelector('#welcomeView').classList.add('hidden');db={auth:{signOut:async()=>({})}};await handleLogout();}")
        self.assertTrue(self.page.locator('#welcomeView').is_visible())
        self.assertFalse(self.page.locator('#appView').is_visible())

    def test_no_horizontal_overflow_on_iphone_sizes(self):
        self.fixture_goods()
        for width in [320,375,390,430]:
            self.page.set_viewport_size({'width':width,'height':844})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),width)
            self.assertLessEqual(self.page.locator('.bottom-nav').bounding_box()['width'],width)
        self.assertEqual(self.errors,[])

    def test_programmatic_navigation_has_one_active_destination(self):
        self.fixture_goods()
        self.page.evaluate("switchTab('home')")
        self.assertEqual(self.page.locator('.bottom-nav .nav-item.active').count(),1)

    def test_notifications_button_toggles_without_second_load(self):
        self.page.evaluate("""async()=>{
          window.notificationLoads=0;loadNotifications=async()=>notificationLoads++;
          await showNotificationsDialog();await showNotificationsDialog();
        }""")
        self.assertFalse(self.page.locator('#notificationsDialog').evaluate('node=>node.open'))
        self.assertEqual(self.page.evaluate('notificationLoads'),1)

    def test_message_author_grouping_and_safe_click(self):
        self.page.evaluate("""()=>{
          document.querySelector('#splashScreen')?.remove();
          chatPeople=[{id:'sender',full_name:'اسم آمن',role:'rep'}];
          chatConversations=[{id:'conversation',kind:'group'}];
          chatMessagePages.set('conversation',{rows:[
            {id:'m1',sender_id:'sender',body:'أولى',created_at:'2026-10-24T10:00:00Z'},
            {id:'m2',sender_id:'sender',body:'ثانية',created_at:'2026-10-24T10:01:00Z'},
            {id:'m3',sender_id:'sender',body:'ثالثة',created_at:'2026-10-24T10:10:00Z'}]});
          renderMessagePage('conversation');
          window.startPrivateChat=id=>window.selectedSender=id;
        }""")
        self.assertEqual(self.page.locator('[data-chat-message-person]').count(),2)
        self.page.locator('[data-chat-message-person]').first.evaluate('node=>node.click()')
        self.assertEqual(self.page.evaluate('selectedSender'),'sender')
        self.assertEqual(self.page.locator('#chatMessages [onclick]').count(),0)

    def test_private_chat_reuses_existing_conversation_without_rpc(self):
        self.page.evaluate("""async()=>{
          chatConversations=[{id:'existing',kind:'direct',otherUserId:'sender'}];
          db={rpc:()=>{throw Error('Duplicate conversation RPC');}};
          loadChatConversations=async()=>{};openChatConversation=async id=>window.openedChat=id;
          await startPrivateChat('sender');
        }""")
        self.assertEqual(self.page.evaluate('openedChat'),'existing')

    def test_chat_thread_identifier_is_inert_and_preserved(self):
        hostile="x' onclick='window.__injected=1"
        self.page.evaluate("""id=>{
          chatConversations=[{id,kind:'direct',displayTitle:'اختبار'}];
          renderChatConversationList();window.openChatConversation=value=>window.selectedThread=value;
        }""",hostile)
        button=self.page.locator('[data-chat-thread]')
        self.assertIsNone(button.get_attribute('onclick'))
        button.evaluate('node=>node.click()')
        self.assertEqual(self.page.evaluate('selectedThread'),hostile)
        self.assertFalse(self.page.evaluate('Boolean(window.__injected)'))

    def test_private_chat_double_click_creates_one_request(self):
        self.page.evaluate("""()=>{
          chatConversations=[];window.privateCalls=0;
          db={rpc:()=>{privateCalls++;return new Promise(resolve=>window.finishPrivate=resolve);}};
          loadChatConversations=async()=>{};openChatConversation=async()=>{};
          window.firstPrivate=startPrivateChat('sender');startPrivateChat('sender');
        }""")
        self.assertEqual(self.page.evaluate('privateCalls'),1)
        self.page.evaluate("async()=>{finishPrivate({data:'new'});await firstPrivate;}")

if __name__=='__main__':unittest.main()
