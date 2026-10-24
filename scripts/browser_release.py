"""Release browser checks: intercepted API, no hosted data mutations."""
import unittest
import browser_app_security as security
class ReleaseTests(unittest.TestCase):
    setUpClass=classmethod(security.AppSecurityTests.setUpClass.__func__)
    tearDownClass=classmethod(security.AppSecurityTests.tearDownClass.__func__)
    setUp=security.AppSecurityTests.setUp
    tearDown=security.AppSecurityTests.tearDown
    route=security.AppSecurityTests.route
    def fixture_goods(self):
        self.page.evaluate("""() => {
          goods=[{id:'one',title:'كرسي عصري',area:'بغداد',status:'available',asking_price:185000,description:'الصنف: أثاث'},
            {id:'two',title:'هاتف',area:'البصرة',status:'sold',asking_price:90000},
            {id:'three',title:'مكتب',area:'بغداد',status:'reserved',asking_price:150000}];
          document.querySelector('#splashScreen')?.remove();
          document.querySelector('#welcomeView').classList.add('hidden');
          document.querySelector('#appView').classList.remove('hidden');render();
        }""")

    def test_card_id_cannot_execute_javascript(self):
        self.fixture_goods()
        self.page.evaluate("""()=>{goods[0].id=\"');window.pwned=true;//\";window.openGoodDetails=id=>window.detailId=id;render();}""")
        self.page.locator('[data-card-action=details]').click()
        self.assertFalse(self.page.evaluate('Boolean(window.pwned)'))
        self.assertEqual(self.page.evaluate('detailId'),"');window.pwned=true;//")

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

    def test_private_chat_discards_result_after_account_switch(self):
        self.page.evaluate("""()=>{
          chatConversations=[];activeChatId=null;window.chatLoadCalls=0;
          db={rpc:()=>new Promise(resolve=>window.finishPrivate=resolve)};
          loadChatConversations=async()=>chatLoadCalls++;
          openChatConversation=async()=>{throw Error('Old account conversation opened');};
          window.privatePending=startPrivateChat('sender');currentUser={id:'other-account'};
        }""")
        self.page.evaluate("async()=>{finishPrivate({data:'old-account-conversation'});await privatePending;}")
        self.assertEqual(self.page.evaluate('chatLoadCalls'),0)
        self.assertIsNone(self.page.evaluate('activeChatId'))

    def test_safe_product_search_and_legacy_navigation(self):
        self.fixture_goods()
        self.page.locator('#goodsSearch').fill('كرسي')
        self.assertEqual(self.page.locator('#goodsList>article').count(),1)
        self.page.locator('#goodsMaxPrice').fill('100000')
        self.assertEqual(self.page.locator('#goodsList>article').count(),0)
        self.page.locator('#goodsMaxPrice').fill('')
        self.page.evaluate("switchTab('inquiries')")
        self.assertFalse(self.page.locator('#inquiriesView').evaluate("n=>n.classList.contains('hidden')"))
        self.page.evaluate("profile={role:'rep',status:'approved'};switchTab('home');switchTab('sales')")
        self.assertTrue(self.page.locator('#salesView').evaluate("n=>n.classList.contains('hidden')"))

    def fixtures(self):
        self.page.evaluate("""()=>{
          document.querySelector('#splashScreen')?.remove();
          document.querySelector('#welcomeView').classList.add('hidden');
          document.querySelector('#appView').classList.remove('hidden');
          window.rows=(from,count,conversation)=>Array.from({length:count},(_,i)=>({
            id:'00000000-0000-0000-0000-'+String(from-i).padStart(12,'0'),created_at:'2026-10-24T10:00:00+00:00',
            title:'كرسي '+(from-i),area:'بغداد',status:'available',asking_price:1000,
            conversation_id:conversation,body:'رسالة '+(from-i),sender_id:'other'
          }));
          window.results=[];window.requests=[];window.readUpdates=0;
          db={from:table=>{
            const calls=[];const query={};
            for(const method of ['select','eq','or','ilike','lte','order','limit'])query[method]=(...args)=>{calls.push([method,...args]);return query;};
            query.then=(resolve,reject)=>{
              requests.push({table,calls});
              if(window.holdNext){window.holdNext=false;return new Promise(done=>window.finishPage=done).then(resolve,reject);}
              return Promise.resolve(results.shift()||{data:[]}).then(resolve,reject);
            };
            if(table==='chat_members')return {update:()=>{readUpdates++;const member={eq:()=>member};return member;}};
            return query;
          }};
        }""")

    def test_malformed_cursor_is_rejected(self):
        self.fixtures()
        for value in ['bad','x),id.gt.0','00000000-0000-0000-0000-000000000001']:
            result=self.page.evaluate("""id=>{try{pageCursorFilter({id,created_at:'bad-date'});return false;}catch(_){return true;}}""",value)
            self.assertTrue(result)
        self.assertEqual(self.page.evaluate('requests.length'),0)

    def test_old_messages_stay_when_polling_latest(self):
        self.fixtures()
        self.page.evaluate("""async()=>{
          activeChatId='conversation';results=[{data:rows(100,50,'conversation')},{data:rows(50,50,'conversation')},{data:rows(103,3,'conversation')}];
          await loadChatMessages(activeChatId);await loadOlderMessages();await loadChatMessages(activeChatId,true);
        }""")
        self.assertEqual(self.page.locator('.chat-message-body').count(),103)
        self.assertEqual(self.page.locator('.chat-message-body').first.inner_text(),'رسالة 1')
        self.assertEqual(self.page.locator('.chat-message-body').last.inner_text(),'رسالة 103')
        self.assertEqual(self.page.evaluate('readUpdates'),2)

    def test_failed_older_page_preserves_messages_and_cursor(self):
        self.fixtures()
        self.page.evaluate("""async()=>{activeChatId='conversation';results=[{data:rows(100,50,activeChatId)},{error:{message:'offline'}},{data:rows(50,2,activeChatId)}];await loadChatMessages(activeChatId);await loadOlderMessages();}""")
        self.assertEqual(self.page.locator('.chat-message-body').count(),50)
        self.assertIn('تعذّر',self.page.locator('#chatStatus').inner_text())
        self.page.evaluate('async()=>await loadOlderMessages()')
        self.assertEqual(self.page.locator('.chat-message-body').count(),52)
        self.assertTrue(self.page.locator('#loadOlderMessagesButton').evaluate("node=>node.classList.contains('hidden')"))

    def test_message_order_preserves_postgres_microseconds(self):
        self.fixtures()
        self.page.evaluate("""async()=>{
          activeChatId='conversation';const data=rows(2,2,activeChatId);
          data[0].body='الأقدم';data[0].created_at='2026-10-24T10:00:00.000001+00:00';
          data[1].body='الأحدث';data[1].created_at='2026-10-24T10:00:00.000002+00:00';
          results=[{data}];await loadChatMessages(activeChatId);
        }""")
        self.assertEqual(self.page.locator('.chat-message-body').all_text_contents(),['الأقدم','الأحدث'])

    def test_loading_older_messages_preserves_visible_anchor(self):
        self.fixtures()
        result=self.page.evaluate("""async()=>{
          activeChatId='conversation';results=[{data:rows(100,50,activeChatId)},{data:rows(50,50,activeChatId)}];
          const box=document.querySelector('#chatMessages');document.body.append(box);
          box.style.cssText='height:220px!important;max-height:220px!important;overflow:auto!important;position:fixed;top:100px;left:0;width:300px;display:block;z-index:10000;flex:none';
          await loadChatMessages(activeChatId);box.scrollTop=150;
          const top=box.getBoundingClientRect().top;
          const anchor=[...box.querySelectorAll('[data-message-id]')].find(node=>node.getBoundingClientRect().bottom>top);
          const before={id:anchor.dataset.messageId,top:anchor.getBoundingClientRect().top};
          await loadOlderMessages();
          const after=[...box.querySelectorAll('[data-message-id]')].find(node=>node.dataset.messageId===before.id);
          return {before:before.top,after:after.getBoundingClientRect().top};
        }""")
        self.assertLess(abs(result['before']-result['after']),3)

    def test_polling_gap_can_be_filled_without_losing_history(self):
        self.fixtures()
        self.page.evaluate("""async()=>{
          activeChatId='conversation';results=[{data:rows(50,50,activeChatId)},{data:rows(150,50,activeChatId)},{data:rows(100,50,activeChatId)},{data:rows(50,50,activeChatId)}];
          await loadChatMessages(activeChatId);await loadChatMessages(activeChatId,true);await loadOlderMessages();await loadOlderMessages();
        }""")
        self.assertEqual(self.page.locator('.chat-message-body').count(),150)
        self.assertTrue(self.page.evaluate("chatMessagePages.get(activeChatId).gapCursor===null"))

    def test_switched_conversation_ignores_slow_result(self):
        self.fixtures()
        self.page.evaluate("()=>{activeChatId='old';holdNext=true;window.pending=loadChatMessages('old');}")
        self.page.evaluate("async()=>{activeChatId='new';finishPage({data:rows(100,3,'old')});await pending;}")
        self.assertEqual(self.page.locator('.chat-message-body').count(),0)
        self.assertEqual(self.page.evaluate('readUpdates'),0)

    def test_login_keeps_existing_authentication_contract(self):
        self.page.evaluate("""async()=>{
          window.loginPayload=null;window.loggedUser=null;window.alerts=[];window.alert=m=>alerts.push(m);
          db={auth:{signInWithPassword:async payload=>{loginPayload=payload;return {data:{user:{id:'existing'}}};}}};
          startApp=async user=>{loggedUser=user.id;};
          document.querySelector('#loginEmail').value='fixture@example.invalid';
          document.querySelector('#loginPassword').value='synthetic-password';
          await handleLogin();
        }""")
        self.assertEqual(self.page.evaluate('loggedUser'),'existing')
        self.assertEqual(self.page.evaluate('loginPayload.email'),'fixture@example.invalid')

    def test_sales_uses_existing_tables_and_no_new_rpc(self):
        self.page.evaluate("""async()=>{
          goods=[{id:'good',status:'available'}];reps=[{id:'rep',status:'approved'}];
          document.querySelector('#saleGoods').innerHTML='<option value="good">Good</option>';
          document.querySelector('#saleRep').innerHTML='<option value="rep">Rep</option>';
          const form=document.querySelector('#saleForm');form.elements.price.value=1000;
          form.elements.totalCommission.value=100;form.elements.repCommission.value=60;
          window.saleWrites=[];window.alert=()=>{};refreshData=async()=>{};sendPushEvent=async()=>({ok:true});
          db={rpc:()=>{throw new Error('Schema-dependent RPC must remain disabled');},from:table=>({
            insert:payload=>{saleWrites.push({table,payload});return {select:()=>({single:async()=>({data:{id:'sale'}})})};},
            update:payload=>({eq:async()=>{saleWrites.push({table,payload});return {};}})
          })};await handleSaveSale();
        }""")
        writes=self.page.evaluate('saleWrites')
        self.assertEqual([x['table'] for x in writes],['sales','goods'])
        self.assertEqual(writes[0]['payload']['manager_share'],40)
        self.assertEqual(writes[1]['payload']['status'],'sold')

if __name__=='__main__':unittest.main()
