"""Real network-isolated PostgreSQL; synthetic actors only, never hosted business data."""
import unittest,json
from notifications_database import NotificationTests,ROOT
class WantedTests(NotificationTests):
 @classmethod
 def setUpClass(cls):super().setUpClass();cls.sql((ROOT/'db/005_wanted_radar.sql').read_text())
 def wanted(self,actor,op,data=None):
  payload=json.dumps(data or {},ensure_ascii=False).replace("'","''")
  return json.loads(self.sql(f"select tg_market_wanted_action({actor},'{op}','{payload}',{str(actor==3).lower()},'Synthetic')",'service_role'))
 def request(self,**extra):return self.wanted(2,'save',{'title':'مطلوب كرسي خشب','category':'أثاث','governorate':'بغداد','area':'الكرادة','budget':10000,'description':'كرسي خشب نظيف للمنزل',**extra})
 def radar(self,**extra):return self.wanted(2,'radar_save',{'title':'كرسي للبيت','keywords':'كرسي خشب','category':'أثاث','governorate':'بغداد','area':'الكرادة','budget':10000,**extra})
 def scan(self):return json.loads(self.sql('select tg_market_radar_scan()','service_role'))
 def public(self,data=None):
  payload=json.dumps(data or {},ensure_ascii=False).replace("'","''");return json.loads(self.sql(f"select tg_market_wanted_public('{payload}')",'service_role'))
 def test_wanted_review_lifecycle_and_guest_projection(self):
  w=self.request();self.assertEqual(self.public(),[]);self.wanted(3,'review',{'id':w['id'],'status':'approved'});rows=self.public();self.assertEqual(len(rows),1);self.assertNotIn('owner_id',rows[0]);self.assertNotIn('telegram_id',rows[0]);self.assertEqual(len(self.public({'governorate':'البصرة'})),0);self.assertEqual(len(self.public({'budget':500})),0)
  self.wanted(2,'save',{**w,'description':'مواصفات جديدة للكرسي'});self.assertEqual(self.public(),[])
  self.wanted(3,'review',{'id':w['id'],'status':'approved'});self.wanted(2,'close',{'id':w['id']});self.assertEqual(self.public(),[])
 def test_wanted_roles_and_duplicate(self):
  w=self.request()
  for actor in [1,2]:
   with self.assertRaises(AssertionError):self.wanted(actor,'review',{'id':w['id'],'status':'approved'})
  with self.assertRaises(AssertionError):self.request()
  with self.assertRaises(AssertionError):self.wanted(1,'delete',{'id':w['id']})
  for role in ['anon','authenticated','service_role']:
   for t in ['wanted','wanted_offers','radars','radar_matches','wanted_reports']:self.sql('select * from tg_market_'+t,role,deny=True)
 def test_wanted_expiry_renew_and_images(self):
  w=self.request();self.wanted(3,'review',{'id':w['id'],'status':'approved'});self.sql("update tg_market_wanted set expires_at=now()-interval '1 day'");self.assertEqual(self.public(),[]);w=self.wanted(2,'renew',{'id':w['id']});self.assertEqual(w['status'],'pending');self.assertGreater(w['expires_at'],w['created_at'])
  with self.assertRaises(AssertionError):self.request(title='طلب صورة مسروقة',images=['00000000-0000-0000-0000-000000000999'])
 def test_wanted_offer_authorization_chat_and_reports(self):
  w=self.request();self.wanted(3,'review',{'id':w['id'],'status':'approved'});ad=self.approved(title='كرسي خشب نظيف')
  self.wanted(1,'offer',{'request':w['id'],'listing':ad});self.wanted(1,'offer',{'request':w['id'],'listing':ad});offers=self.wanted(2,'offers',{'id':w['id']});self.assertEqual(len(offers),1);self.assertEqual(len(self.wanted(3,'admin_offers',{'id':w['id']})),1);
  with self.assertRaises(AssertionError):self.wanted(1,'admin_offers',{'id':w['id']})
  thread=self.wanted(2,'contact',{'id':offers[0]['id']});self.assertIn('id',thread)
  with self.assertRaises(AssertionError):self.wanted(1,'offers',{'id':w['id']})
  with self.assertRaises(AssertionError):self.wanted(3,'contact',{'id':offers[0]['id']})
  with self.assertRaises(AssertionError):self.wanted(2,'offer',{'request':w['id'],'listing':ad})
  self.wanted(1,'report',{'id':w['id'],'reason':'طلب مشبوه للاختبار'});self.assertEqual(self.public(),[])
 def test_radar_precise_filters_edit_pause_delete(self):
  r=self.radar();good=self.approved(title='كرسي خشب نظيف');self.approved(title='كرسي خشبي نظيف');self.approved(title='كرسي خشب غالي',price=20000);self.approved(title='كرسي خشب بصرة',governorate='البصرة');self.scan();rows=self.wanted(2,'matches',{'id':r['id']});self.assertEqual([x['id'] for x in rows],[good]);self.assertEqual(self.sql('select count(*) from tg_market_notify_events where event_key like \'radar:%\''),'0')
  self.wanted(2,'radar_save',{**r,'enabled':False});self.assertEqual(self.wanted(2,'matches',{'id':r['id']}),[])
  with self.assertRaises(AssertionError):self.wanted(1,'matches',{'id':r['id']})
  self.wanted(1,'radar_delete',{'id':r['id']});self.assertEqual(len(self.wanted(2,'radars')),1);self.wanted(2,'radar_delete',{'id':r['id']});self.assertEqual(self.wanted(2,'radars'),[])
 def test_radar_consent_queue_dedup_and_stop(self):
  with self.assertRaises(AssertionError):self.radar(notifications=True)
  self.sub();r=self.radar(notifications=True,confirmed=True);ad=self.approved(title='كرسي خشب مناسب');self.scan();self.scan();self.assertEqual(self.sql("select count(*) from tg_market_notify_events where event_key like 'radar:%'"),'1');self.pump();jobs=[]
  for _ in range(5):
   j=self.claim()
   if j.get('id'):jobs.append(j);self.finish(j)
  self.assertTrue(jobs);self.scan();self.pump();self.assertEqual(self.claim(),{})
  self.wanted(2,'radar_save',{**r,'notifications':False});self.assertEqual(self.sql("select count(*) from tg_market_radar_matches"),'1')
 def test_radar_hidden_banned_reported_not_matching(self):
  r=self.radar();ad=self.approved(title='كرسي خشب مناسب');self.action(2,'report',{'id':ad,'reason':'Synthetic complaint'});self.scan();self.assertEqual(self.wanted(2,'matches',{'id':r['id']}),[])
 def test_wanted_admin_and_rep_privacy(self):
  w=self.request();self.sql("update tg_market_users set role='rep' where telegram_id=1")
  with self.assertRaises(AssertionError):self.wanted(1,'admin',{'status':'pending'})
  with self.assertRaises(AssertionError):self.wanted(1,'offers',{'id':w['id']})
  self.assertEqual(len(self.wanted(3,'admin',{'status':'pending'})['requests']),1)
 def test_radar_existing_inventory_and_changed_listing(self):
  ad=self.approved(title='طاولة خشب نظيفة');r=self.radar();self.scan();self.assertEqual(self.wanted(2,'matches',{'id':r['id']}),[])
  self.notify(1,'save_listing',{'id':ad,'title':'كرسي خشب نظيف','category':'أثاث','area':'الكرادة','governorate':'بغداد','price':5000,'condition':'used'});self.scan();self.assertEqual(self.wanted(2,'matches',{'id':r['id']}),[])
  self.action(3,'admin_listing_approve',{'id':ad});self.scan();self.assertEqual(len(self.wanted(2,'matches',{'id':r['id']})),1)
 def test_radar_pending_queue_rechecks_pause_block_and_request_expiry(self):
  self.sub();r=self.radar(notifications=True,confirmed=True);self.approved(title='كرسي خشب مناسب');self.scan();self.pump();eid=self.sql("select id from tg_market_notify_events where event_key like 'radar:%'");uid=self.action(2,'me')['id']
  self.assertEqual(self.sql(f"select tg_market_notify_eligible({eid},'{uid}')"),'t');self.notify(2,'pause');self.assertEqual(self.sql(f"select tg_market_notify_eligible({eid},'{uid}')"),'f')
  self.sql('update tg_market_notify_preferences set paused_until=null,blocked=true');self.assertEqual(self.sql(f"select tg_market_notify_eligible({eid},'{uid}')"),'f')
 def test_wanted_private_image_and_review_visibility(self):
  im=self.action(2,'image_intent',{'mime':'image/jpeg'});self.action(2,'image_ready',{'id':im['id']});w=self.request(images=[im['id']]);self.assertEqual(self.sql(f"select tg_market_media('{im['id']}',0)",'service_role'),'')
  self.wanted(3,'review',{'id':w['id'],'status':'approved'});self.assertIn('image/jpeg',self.sql(f"select tg_market_media('{im['id']}',0)",'service_role'));self.wanted(2,'close',{'id':w['id']});self.assertEqual(self.sql(f"select tg_market_media('{im['id']}',0)",'service_role'),'')
 def test_radar_link_ownership_and_request_lifecycle(self):
  w=self.request();r=self.radar(request_id=w['id']);self.approved(title='كرسي خشب مناسب');self.scan();self.assertEqual(self.wanted(2,'matches',{'id':r['id']}),[])
  with self.assertRaises(AssertionError):self.wanted(1,'radar_save',{**r,'id':'00000000-0000-0000-0000-000000000321'})
  self.wanted(3,'review',{'id':w['id'],'status':'approved'});self.scan();self.assertEqual(len(self.wanted(2,'matches',{'id':r['id']})),1)
  self.wanted(2,'close',{'id':w['id']});self.scan();self.assertEqual(self.wanted(2,'matches',{'id':r['id']}),[])
if __name__=='__main__':
 suite=unittest.TestSuite(WantedTests(n) for n in unittest.defaultTestLoader.getTestCaseNames(WantedTests) if n.startswith(('test_wanted_','test_radar_','test_notify_')))
 raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
