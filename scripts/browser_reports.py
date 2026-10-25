"""Account report integration with intercepted synthetic API responses only."""
import unittest
import browser_app_security as security
class ReportBrowserTests(unittest.TestCase):
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
          window.record=n=>({id:'00000000-0000-0000-0000-'+String(n).padStart(12,'0'),created_at:'2026-10-25T10:00:00+00:00',rep_id:'rep',final_price:1000,total_commission:100,rep_share:60,manager_share:40});
          window.replies={goods:[{data:[],count:0}],inquiries:[{data:[],count:0}],sales:[{data:[],count:0}]};window.calls=[];
          loadExternalListings=async()=>{};loadNotifications=async()=>{};
          db={rpc:async()=>({data:[]}),from:table=>{
            const operations=[];const q={};for(const method of ['select','order','limit','eq','or','in'])q[method]=(...args)=>{operations.push([method,...args]);return q;};
            q.then=(resolve,reject)=>{calls.push({table,operations});
              if(table==='profiles')return Promise.resolve({data:[]}).then(resolve,reject);
              const result=replies[table].shift();if(!result)throw new Error('Unexpected '+table+' request');
              return Promise.resolve(result).then(resolve,reject);};return q;
          }};
        }""")
    def tearDown(self):security.AppSecurityTests.tearDown(self)
    def test_capped_reports_load_every_page_before_updating_totals(self):
        self.fixtures()
        self.page.evaluate("""async()=>{replies.inquiries=[{data:[record(3)],count:2},{data:[record(2)],count:1}];
          replies.sales=[{data:[record(9)],count:3},{data:[record(8)],count:2},{data:[record(7)],count:1}];await refreshData();}""")
        self.assertEqual(self.page.evaluate('sales.length'),3)
        self.assertEqual(self.page.evaluate('inquiries.length'),2)
        self.assertIn('300',self.page.locator('#statCommission').inner_text().translate(str.maketrans('٠١٢٣٤٥٦٧٨٩','0123456789')))
        self.assertEqual(self.page.evaluate("calls.filter(c=>c.table==='sales').length"),3)
        self.assertTrue(self.page.evaluate("calls.filter(c=>['sales','inquiries'].includes(c.table)).every(c=>c.operations.some(o=>o[0]==='limit'&&o[1]===200))"))
    def test_legacy_null_dates_are_loaded_after_dated_records(self):
        self.fixtures()
        self.page.evaluate("""async()=>{const old={...record(8),created_at:null};replies.sales=[{data:[record(9)],count:3},{data:[old],count:2},{data:[{...record(7),created_at:null}],count:1}];await refreshData();}""")
        self.assertEqual(self.page.evaluate('sales.length'),3)
        self.assertTrue(self.page.evaluate("calls.filter(c=>c.table==='sales')[2].operations.some(o=>o[0]==='or'&&o[1].startsWith('and(created_at.is.null,'))"))
    def test_failed_later_page_preserves_previous_sales_and_inquiries(self):
        self.fixtures()
        self.page.evaluate("""async()=>{sales=[record(10)];inquiries=[record(11)];replies.sales=[{data:[record(9)],count:2},{error:{code:'offline'}}];await refreshData();}""")
        self.assertTrue(self.page.evaluate("sales[0].id.endsWith('000000000010') && inquiries[0].id.endsWith('000000000011')"))
        self.assertIn('بقي العرض السابق',self.page.locator('#dataStatus').inner_text())
        for tab in ('sales','inquiries'):
            self.page.evaluate('(tab)=>switchTab(tab)',tab)
            self.assertTrue(self.page.locator('#dataStatus').is_visible())
    def test_logout_during_later_page_cannot_restore_private_records(self):
        self.fixtures()
        self.page.evaluate("""()=>{replies.sales=[{data:[record(9)],count:2},new Promise(done=>window.finishReport=done)];window.refresh=refreshData();}""")
        self.page.wait_for_function("calls.filter(c=>c.table==='sales').length===2")
        self.page.evaluate("async()=>{clearAccountState();finishReport({data:[record(8)],count:1});await refresh;}")
        self.assertEqual(self.page.evaluate('sales.length+inquiries.length+goods.length'),0)
    def test_every_representative_sales_page_has_the_same_account_filter(self):
        self.fixtures()
        self.page.evaluate("""async()=>{profile={role:'rep',status:'approved'};replies.sales=[{data:[record(9)],count:2},{data:[record(8)],count:1}];await refreshData();}""")
        self.assertTrue(self.page.evaluate("calls.filter(c=>c.table==='sales').every(c=>c.operations.some(o=>o[0]==='eq'&&o[1]==='rep_id'&&o[2]===currentUser.id))"))
        self.assertEqual(self.page.evaluate('sales.length'),2)
    def test_page_limit_is_explicit_and_does_not_commit_partial_totals(self):
        self.fixtures()
        self.page.evaluate("""async()=>{sales=[record(10)];const original=readReportRows;readReportRows=async(table,options)=>{if(table==='sales'){const e=new Error('bounded');e.code='REPORT_PAGE_LIMIT';throw e;}return original(table,options);};await refreshData();}""")
        self.assertEqual(self.page.evaluate('sales.length'),1)
        self.assertIn('حد التحميل الآمن',self.page.locator('#dataStatus').inner_text())
if __name__=='__main__':unittest.main()
