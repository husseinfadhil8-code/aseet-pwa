"""Bounded paging, race/failure and modal regressions. Never contacts Supabase."""
import unittest
import browser_app_security as security

class PagingTests(unittest.TestCase):
    setUpClass=classmethod(security.AppSecurityTests.setUpClass.__func__)
    tearDownClass=classmethod(security.AppSecurityTests.tearDownClass.__func__)
    setUp=security.AppSecurityTests.setUp
    tearDown=security.AppSecurityTests.tearDown
    route=security.AppSecurityTests.route

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

    def test_products_load_every_page_with_stable_cursor(self):
        self.fixtures()
        self.page.evaluate("""async()=>{
          results=[{data:rows(100,40),count:85},{data:rows(60,40),count:45},{data:rows(20,5),count:5}];
          await loadMarketGoods({reset:true,clearCache:true});
        }""")
        self.assertEqual(self.page.locator('[data-card-index]').count(),40)
        self.page.evaluate('async()=>{await loadMoreGoods();await loadMoreGoods();}')
        self.assertEqual(self.page.locator('[data-card-index]').count(),85)
        self.assertFalse(self.page.locator('#loadMoreGoodsButton').is_visible())
        self.assertIn('85',self.page.locator('#goodsResultCount').inner_text())
        self.assertTrue(self.page.evaluate("requests[1].calls.some(call=>call[0]==='or' && call[1].includes('id.lt.00000000-0000-0000-0000-000000000061'))"))
        self.assertTrue(self.page.evaluate("requests.every(r=>r.calls.some(c=>c[0]==='limit' && c[1]===40))"))
        self.assertNotIn('owner_phone',self.page.evaluate("requests[0].calls.find(c=>c[0]==='select')[1]"))

    def test_more_products_double_click_sends_once(self):
        self.fixtures()
        self.page.evaluate("""async()=>{results=[{data:rows(100,40)}];await loadMarketGoods({reset:true});holdNext=true;window.a=loadMoreGoods();window.b=loadMoreGoods();}""")
        self.assertEqual(self.page.evaluate('requests.length'),2)
        self.page.evaluate('async()=>{finishPage({data:rows(60,5)});await Promise.all([a,b]);}')
        self.assertEqual(self.page.evaluate('marketGoods.length'),45)

    def test_product_failure_keeps_page_and_allows_retry(self):
        self.fixtures()
        self.page.evaluate("""async()=>{results=[{data:rows(100,40)},{error:{message:'offline'}},{data:rows(60,2)}];await loadMarketGoods({reset:true});await loadMoreGoods();}""")
        self.assertEqual(self.page.evaluate('marketGoods.length'),40)
        self.assertIn('تعذّر',self.page.locator('#marketPagingStatus').inner_text())
        self.assertFalse(self.page.locator('#loadMoreGoodsButton').is_disabled())
        self.page.evaluate('async()=>await loadMoreGoods()')
        self.assertEqual(self.page.evaluate('marketGoods.length'),42)

    def test_new_search_wins_over_slow_old_request(self):
        self.fixtures()
        self.page.evaluate("""async()=>{holdNext=true;window.oldPage=loadMarketGoods({reset:true});results=[{data:rows(9,1),count:1}];await loadMarketGoods({reset:true,clearCache:true});finishPage({data:rows(100,40)});await oldPage;}""")
        self.assertEqual(self.page.evaluate('marketGoods.length'),1)
        self.assertTrue(self.page.evaluate("marketGoods[0].id.endsWith('000000000009')"))

    def test_search_is_server_side_and_literal_is_quoted(self):
        self.fixtures()
        value='كرسي,asking_price.lt.0)"'
        self.page.locator('#goodsSearch').fill(value)
        self.page.evaluate('async()=>{results=[{data:[],count:0}];await loadMarketGoods({reset:true});}')
        search=self.page.evaluate("requests[0].calls.find(c=>c[0]==='or')[1]")
        self.assertIn('title.ilike."*',search)
        self.assertIn('\\"',search)
        self.assertIn('description.ilike.',search)
        self.assertEqual(self.page.evaluate('marketTotal'),0)

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

    def test_dialogs_are_labelled_and_close_on_small_screens(self):
        self.fixtures()
        for width in [320,390,430]:
            self.page.set_viewport_size({'width':width,'height':844})
            self.page.evaluate("prepareAddGoods()")
            dialog=self.page.locator('#goodsDialog')
            self.assertIsNotNone(dialog.get_attribute('aria-labelledby'))
            self.assertLessEqual(dialog.bounding_box()['width'],width)
            dialog.get_by_role('button',name='إغلاق النافذة',exact=True).click()
            self.assertFalse(dialog.evaluate('node=>node.open'))

    def test_new_and_saved_images_share_one_order(self):
        self.fixtures()
        self.page.evaluate("""()=>{goodsImageItems=[{saved:true,url:'https://images.invalid/old.png'},{saved:false,file:new File(['x'],'new.jpg',{type:'image/jpeg'})}];renderGoodsImageEditor();showDialog('goodsDialog');}""")
        self.page.get_by_role('button',name='تقديم الصورة 2',exact=True).click()
        self.assertFalse(self.page.evaluate('goodsImageItems[0].saved'))
        self.assertEqual(self.page.evaluate('retainedGoodsImages'),['https://images.invalid/old.png'])
        self.page.get_by_role('button',name='تأخير الصورة 1',exact=True).click()
        self.assertTrue(self.page.evaluate('goodsImageItems[0].saved'))

    def test_details_show_metadata_and_zoom_the_current_photo(self):
        self.fixtures()
        self.page.route('https://images.invalid/**',lambda route:route.fulfill(content_type='image/svg+xml',body='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/></svg>'))
        self.page.evaluate(r"""()=>{
          goods=[{id:'detail',title:'غرض كامل',area:'بغداد',status:'reserved',asking_price:125000,
            description:'الصنف: أثاث\nحالة الغرض: مستعمل نظيف\nالتفاوض: قابل للتفاوض\nيوجد ضرر أو عطل: لا\nتفاصيل إضافية: وصف كامل\nعمولة: 100\nصور المنتج: https://images.invalid/one.png | https://images.invalid/two.png'}];
          openGoodDetails('detail');
        }""")
        body=self.page.locator('#goodDetailsContent').inner_text()
        for text in ['غرض كامل','بغداد','محجوز','مستعمل نظيف','قابل للتفاوض','وصف كامل']:
            self.assertIn(text,body)
        self.assertNotIn('عمولة:',body)
        self.assertNotIn('https://',body)
        self.assertEqual(self.page.locator('.waseet-details-price').inner_text().count('د.ع'),1)
        self.page.locator('.waseet-details-gallery').evaluate("node=>{node.scrollLeft=-node.clientWidth;node.dispatchEvent(new Event('scroll'));}")
        self.assertEqual(self.page.locator('[data-zoom-image]').get_attribute('data-zoom-image'),'https://images.invalid/two.png')

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

if __name__=='__main__':unittest.main()
