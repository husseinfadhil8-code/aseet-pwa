"""Media, transaction guard and account regressions. All API requests intercepted."""
import unittest
import browser_app_security as security
import browser_release as release
class BatchTests(unittest.TestCase):
    setUpClass=classmethod(security.AppSecurityTests.setUpClass.__func__)
    tearDownClass=classmethod(security.AppSecurityTests.tearDownClass.__func__)
    setUp=security.AppSecurityTests.setUp
    tearDown=security.AppSecurityTests.tearDown
    route=security.AppSecurityTests.route
    fixture_goods=release.ReleaseTests.fixture_goods
    fixtures=release.ReleaseTests.fixtures

    def sale_fixture(self,mode='success'):
        self.page.evaluate('''mode=>{
          goods=[{id:'good',status:'available'}];reps=[{id:'rep',status:'approved'}];sales=[];
          document.querySelector('#saleGoods').innerHTML='<option value="good">Good</option>';
          document.querySelector('#saleRep').innerHTML='<option value="rep">Rep</option>';
          const f=document.querySelector('#saleForm');f.elements.price.value=1000;f.elements.totalCommission.value=100;f.elements.repCommission.value=60;
          window.writes=[];window.checks=0;window.alerts=[];window.alert=m=>alerts.push(m);
          refreshData=async()=>{};sendPushEvent=async()=>({ok:true});
          db={from:table=>({select:()=>({eq:()=>({limit:()=>{checks++;return mode==='hold'?new Promise(resolve=>window.finishCheck=resolve):Promise.resolve({data:mode==='existing'?[{id:'existing'}]:[]});}})}),
            insert:payload=>{writes.push({table,payload});return {select:()=>({single:async()=>mode==='unknown'?{error:{message:'network lost'}}:{data:{id:'sale'}}})};},
            update:payload=>({eq:async()=>{writes.push({table,payload});return mode==='partial'?{error:{code:'42501'}}:{};}})
          })};
        }''',mode)

    def test_sale_double_submit_has_one_preflight_and_one_insert(self):
        self.sale_fixture('hold')
        self.page.evaluate('()=>{window.first=handleSaveSale();window.second=handleSaveSale();}')
        self.assertEqual(self.page.evaluate('checks'),1)
        self.page.evaluate('async()=>{finishCheck({data:[]});await Promise.all([first,second]);}')
        self.assertEqual(self.page.evaluate("writes.filter(w=>w.table==='sales').length"),1)
        self.assertFalse(self.page.locator('#saleForm button[onclick="handleSaveSale()"]').is_disabled())

    def test_saved_sale_with_failed_status_update_cannot_be_inserted_again(self):
        self.sale_fixture('partial')
        self.page.evaluate('async()=>{await handleSaveSale();await handleSaveSale();}')
        self.assertEqual(self.page.evaluate("writes.filter(w=>w.table==='sales').length"),1)
        self.assertIn('سُجل البيع بالفعل',self.page.evaluate('alerts.join(" ")'))

    def test_uncertain_network_result_does_not_retry_insert(self):
        self.sale_fixture('unknown')
        self.page.evaluate('async()=>{await handleSaveSale();await handleSaveSale();}')
        self.assertEqual(self.page.evaluate("writes.filter(w=>w.table==='sales').length"),1)

    def test_existing_sale_is_not_reinserted(self):
        self.sale_fixture('existing')
        self.page.evaluate('async()=>{await handleSaveSale();}')
        self.assertEqual(self.page.evaluate('writes.length'),0)

    def test_inactive_admin_rep_and_visitor_cannot_submit_sale(self):
        for role,status in [('admin','banned'),('admin','pending'),('rep','approved')]:
            self.sale_fixture()
            self.page.evaluate('''async({role,status})=>{profile={role,status};await handleSaveSale();}''',{'role':role,'status':status})
            self.assertEqual(self.page.evaluate('checks'),0)
        self.page.evaluate('async()=>{currentUser=null;await handleSaveSale();}')
        self.assertEqual(self.page.evaluate('writes.length'),0)

    def test_account_switch_during_preflight_cannot_write_sale(self):
        self.sale_fixture('hold')
        self.page.evaluate('()=>{window.first=handleSaveSale();currentUser={id:"other"};}')
        self.page.evaluate('async()=>{finishCheck({data:[]});await first;}')
        self.assertEqual(self.page.evaluate('writes.length'),0)

    def test_payment_double_confirmation_calls_existing_rpc_once(self):
        self.page.evaluate('''()=>{sales=[{id:'sale',rep_id:'rep',rep_share:60}];reps=[];
          window.paymentCalls=0;window.confirm=()=>true;window.alert=()=>{};refreshData=async()=>{};sendPushEvent=async()=>({ok:true});
          db={rpc:()=>{paymentCalls++;return new Promise(resolve=>window.finishPayment=resolve);}};
          window.payA=markSaleCommissionPaid('sale');window.payB=markSaleCommissionPaid('sale');}''')
        self.assertEqual(self.page.evaluate('paymentCalls'),1)
        self.page.evaluate("async()=>{finishPayment({});await Promise.all([payA,payB]);await markSaleCommissionPaid('sale');}")
        self.assertEqual(self.page.evaluate('paymentCalls'),1)
        self.assertTrue(self.page.evaluate('Boolean(sales[0].commission_paid_at)'))

    def test_logout_removes_private_state_before_network_finishes(self):
        self.fixture_goods()
        self.page.evaluate('''()=>{db={auth:{signOut:()=>new Promise(resolve=>window.finishLogout=resolve)}};
          sales=[{id:'private'}];window.exit=handleLogout();}''')
        self.assertTrue(self.page.evaluate('currentUser===null && profile===null && sales.length===0 && goods.length===0'))
        self.assertEqual(self.page.locator('#goodsList').inner_text(),'')
        self.page.evaluate('async()=>{finishLogout({});await exit;}')

    def test_banned_admin_is_signed_out_by_status_poll(self):
        self.page.evaluate('''async()=>{window.signedOut=0;window.alert=()=>{};
          db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{role:'admin',status:'banned'}})})})}),auth:{signOut:async()=>{signedOut++;}}};
          await checkRepresentativeAccess();}''')
        self.assertEqual(self.page.evaluate('signedOut'),1)
        self.assertTrue(self.page.evaluate('currentUser===null && profile===null'))

    def test_stale_status_response_cannot_log_out_new_account(self):
        self.page.evaluate('''()=>{window.signedOut=0;db={from:()=>({select:()=>({eq:()=>({maybeSingle:()=>new Promise(resolve=>window.finishStatus=resolve)})})}),auth:{signOut:async()=>signedOut++}};
          window.statusRequest=checkRepresentativeAccess();currentUser={id:'new-account'};profile={role:'rep',status:'approved'};}''')
        self.page.evaluate("async()=>{finishStatus({data:{role:'admin',status:'banned'}});await statusRequest;}")
        self.assertEqual(self.page.evaluate('signedOut'),0)
        self.assertEqual(self.page.evaluate('currentUser.id'),'new-account')

    def test_drafts_and_reading_position_are_per_conversation_and_cleared_on_logout(self):
        self.fixture_goods()
        self.page.evaluate('''async()=>{loadChatMessages=async()=>{};loadChatConversations=async()=>{};document.querySelector('#chatView').classList.remove('hidden');
          await openChatConversation('one');const box=document.querySelector('#chatMessages');box.innerHTML='<div style="min-height:4000px;flex-shrink:0">history</div>';
          box.style.height='180px';box.style.overflow='auto';box.scrollTop=140;
          const input=document.querySelector('#chatMessageInput');input.value='مسودة أولى';input.dispatchEvent(new Event('input',{bubbles:true}));
          await openChatConversation('two');input.value='مسودة ثانية';input.dispatchEvent(new Event('input',{bubbles:true}));
          await openChatConversation('one');}''')
        self.assertEqual(self.page.locator('#chatMessageInput').input_value(),'مسودة أولى')
        self.assertEqual(self.page.evaluate("document.querySelector('#chatMessages').scrollTop"),140)
        self.assertNotIn('مسودة',self.page.evaluate('JSON.stringify(localStorage)+JSON.stringify(sessionStorage)'))
        self.page.evaluate('clearAccountState()')
        self.assertEqual(self.page.locator('#chatMessageInput').input_value(),'')
        self.assertEqual(self.page.evaluate('chatDrafts.size'),0)

    def test_saved_images_can_be_reordered_removed_without_replacement(self):
        self.fixture_goods()
        self.page.evaluate("()=>{goods[0].image_urls=['https://images.invalid/a.png','https://images.invalid/b.png'];editGoods('one');}")
        self.page.locator('.image-editor-item').nth(1).get_by_role('button',name='تقديم الصورة 2',exact=True).click()
        self.assertEqual(self.page.evaluate('retainedGoodsImages[0]'),'https://images.invalid/b.png')
        self.page.get_by_role('button',name='حذف الصورة 1',exact=True).click()
        self.assertEqual(self.page.evaluate('retainedGoodsImages'),['https://images.invalid/a.png'])

    def test_save_preserves_mixed_photo_order(self):
        self.fixtures()
        self.page.evaluate("""async()=>{
          goods=[{id:'edit',title:'غرض',area:'بغداد',status:'available',asking_price:1000,agreed_commission:100}];editGoods('edit');
          const form=document.querySelector('#goodsForm');
          form.elements.category.value=form.elements.category.options[1].value;
          form.elements.condition.value=form.elements.condition.options[1].value;
          goodsImageItems=[{saved:false,file:new File(['x'],'new.jpg',{type:'image/jpeg'})},{saved:true,url:'https://images.invalid/old.jpg'}];renderGoodsImageEditor();
          window.compressListingImage=async file=>file;window.refreshData=async()=>{};window.alert=()=>{};
          db={storage:{from:()=>({upload:async()=>({}),getPublicUrl:()=>({data:{publicUrl:'https://images.invalid/new.jpg'}})})},from:()=>({update:payload=>{window.savedPayload=payload;return {eq:async()=>({})};}})};
          await handleSaveGoods();
        }""")
        description=self.page.evaluate('savedPayload.description')
        self.assertLess(description.index('/new.jpg'),description.index('/old.jpg'))
        self.assertFalse(self.page.evaluate('goodsSaving'))

    def media_fixture(self):
        self.page.evaluate("""()=>{goods=[{id:'edit',title:'غرض',area:'بغداد',status:'available',asking_price:1000,agreed_commission:100,description:'صور الغرض: https://images.invalid/old.jpg'}];editGoods('edit');
          const f=document.querySelector('#goodsForm');f.elements.category.selectedIndex=1;f.elements.condition.selectedIndex=1;
          window.mediaWrites=0;window.uploads=0;window.alert=()=>{};refreshData=async()=>{};
          db={from:()=>({update:()=>{mediaWrites++;return {eq:()=>new Promise(resolve=>window.finishMedia=resolve)};}}),storage:{from:()=>({upload:async()=>{uploads++;return {};}})}};}""")

    def test_media_save_double_click_is_single_update(self):
        self.media_fixture()
        self.page.evaluate('()=>{window.mediaA=handleSaveGoods();window.mediaB=handleSaveGoods();}')
        self.assertEqual(self.page.evaluate('mediaWrites'),1)
        self.assertTrue(self.page.locator('#saveGoodsButton').is_disabled())
        self.page.evaluate('async()=>{finishMedia({});await Promise.all([mediaA,mediaB]);}')
        self.assertFalse(self.page.evaluate('goodsSaving'))

    def test_image_compression_cannot_upload_into_a_different_account(self):
        self.media_fixture()
        self.page.evaluate("""()=>{goodsImageItems=[{saved:false,file:new File(['x'],'test.jpg',{type:'image/jpeg'})}];renderGoodsImageEditor();
          compressListingImage=()=>new Promise(resolve=>window.finishCompression=resolve);
          window.pendingMedia=handleSaveGoods();currentUser={id:'other'};}""")
        self.page.evaluate("async()=>{finishCompression(new File(['x'],'test.jpg',{type:'image/jpeg'}));await pendingMedia;}")
        self.assertEqual(self.page.evaluate('uploads+mediaWrites'),0)

    def test_password_reset_is_neutral_and_double_click_is_single_request(self):
        self.page.evaluate("""()=>{document.querySelector('#loginEmail').value='fixture@example.invalid';window.resetCalls=0;
          db={auth:{resetPasswordForEmail:()=>{resetCalls++;return new Promise(resolve=>window.finishReset=resolve);}}};
          window.resetA=handlePasswordReset();window.resetB=handlePasswordReset();}""")
        self.assertEqual(self.page.evaluate('resetCalls'),1)
        self.page.evaluate('async()=>{finishReset({});await Promise.all([resetA,resetB]);}')
        self.assertIn('إذا كان البريد مسجّلاً',self.page.locator('#recoveryMessage').text_content())
        self.assertFalse(self.page.locator('#passwordResetButton').is_disabled())

    def test_password_recovery_updates_password_and_returns_to_login(self):
        self.page.evaluate("""async()=>{window.updatedPassword=null;window.logoutCount=0;
          db={auth:{updateUser:async payload=>{updatedPassword=payload.password;return {};},signOut:async()=>{logoutCount++;}}};
          showPasswordRecovery();document.querySelector('#recoveryPassword').value='synthetic-new-password';await handlePasswordUpdate();}""")
        self.assertEqual(self.page.evaluate('updatedPassword'),'synthetic-new-password')
        self.assertEqual(self.page.evaluate('logoutCount'),1)
        self.assertEqual(self.page.locator('#recoveryPassword').input_value(),'')
        self.assertTrue(self.page.locator('#loginEmail').is_visible())

    def test_initial_recovery_hash_survives_sdk_url_cleanup(self):
        self.page.route('**/vendor/supabase-2.118.0.js',lambda route:route.fulfill(content_type='application/javascript',body="""
          window.supabase={createClient:()=>{history.replaceState(null,'',location.pathname);return {auth:{getSession:async()=>({data:{session:{user:{id:'recovery-user'}}}}),onAuthStateChange:()=>{}},from:()=>{throw new Error('Recovery must not start normal profile flow');}};}};
        """))
        self.page.goto(self.origin+'/index.html?recovery-test=1#type=recovery',wait_until='networkidle')
        self.page.wait_for_timeout(2100)
        self.assertTrue(self.page.locator('#recoveryPassword').is_visible())
        self.assertTrue(self.page.locator('#welcomeView').evaluate("n=>n.classList.contains('hidden')"))
        self.assertTrue(self.page.locator('#appView').evaluate("n=>n.classList.contains('hidden')"))


    def test_slow_refresh_cannot_restore_private_data_after_logout(self):
        self.page.evaluate("""()=>{window.readCount=0;db={from:table=>({select:()=>({order:()=>{readCount++;return table==='goods'?new Promise(resolve=>window.finishGoods=resolve):Promise.resolve({data:[]});}})})};
          window.refreshA=refreshData();window.refreshB=refreshData();window.sameRequest=refreshA===refreshB;clearAccountState();}""")
        self.assertEqual(self.page.evaluate('readCount'),2)
        self.assertTrue(self.page.evaluate('sameRequest'))
        self.page.evaluate("async()=>{finishGoods({data:[{id:'private',title:'Private'}]});await Promise.all([refreshA,refreshB]);}")
        self.assertEqual(self.page.evaluate('goods.length+sales.length'),0)
        self.assertEqual(self.page.locator('#goodsList').inner_text(),'')

    def test_failed_refresh_preserves_existing_list_and_allows_retry(self):
        self.fixture_goods()
        self.page.evaluate("""async()=>{db={from:()=>({select:()=>({order:async()=>({error:{code:'offline'}})})})};await refreshData();}""")
        self.assertEqual(self.page.evaluate('goods.length'),3)
        self.assertGreater(self.page.locator('#goodsList>article').count(),0)
        self.assertIn('بقي العرض السابق',self.page.locator('#dataStatus').text_content())

    def test_old_owner_request_response_cannot_repopulate_after_logout(self):
        self.page.evaluate("""()=>{db={from:()=>({select:()=>({not:()=>({order:()=>({limit:()=>new Promise(resolve=>window.finishOwner=resolve)})})})})};
          window.ownerRequest=loadExternalListings();clearAccountState();}""")
        self.page.evaluate("async()=>{finishOwner({data:[{submitter_contact:'07700000000'}]});await ownerRequest;}")
        self.assertEqual(self.page.evaluate('externalListings.length'),0)
        self.assertEqual(self.page.locator('#externalListingsList').inner_text(),'')

    def test_removed_legacy_photo_is_not_reintroduced_through_notes(self):
        self.media_fixture()
        self.page.evaluate("""async()=>{goods[0].description=['وصف قديم','صور المنتج: https://images.invalid/old.jpg'].join(String.fromCharCode(10));editGoods('edit');
          const f=document.querySelector('#goodsForm');f.elements.category.selectedIndex=1;f.elements.condition.selectedIndex=1;
          goodsImageItems=[];renderGoodsImageEditor();db={from:()=>({update:payload=>{window.noPhotoPayload=payload;return {eq:async()=>({})};}})};
          await handleSaveGoods();}""")
        self.assertNotIn('old.jpg',self.page.evaluate('noPhotoPayload.description'))


    def test_definitive_permission_denial_clears_cached_account(self):
        self.page.evaluate("""async()=>{db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({error:{code:'42501'}})})})})};
          await checkRepresentativeAccess();}""")
        self.assertTrue(self.page.evaluate('currentUser===null && profile===null'))

if __name__=='__main__':unittest.main()
