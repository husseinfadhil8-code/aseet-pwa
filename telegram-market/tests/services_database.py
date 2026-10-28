"""Proposed services migration in network-isolated PostgreSQL only."""
import unittest,json
from wanted_database import WantedTests,ROOT
class ServicesTests(WantedTests):
 @classmethod
 def setUpClass(cls):super().setUpClass();cls.sql((ROOT/'db/007_services.sql').read_text())
 def test_service_publish_search_contact_and_ownership(self):
  ad=self.approved(title='خدمة توصيل أغراض',category='خدمات',condition='service')
  result=json.loads(self.sql("select tg_market_public('توصيل','خدمات',0,1000000,0)",'service_role'));self.assertEqual(result[0]['id'],ad)
  thread=self.action(2,'thread',{'id':ad});self.assertTrue(thread['id'])
  with self.assertRaises(AssertionError):self.action(2,'save',{'id':ad,'title':'محاولة تعديل чуж чуж','description':'','category':'خدمات','condition':'service','price':100,'area':'بغداد','governorate':'بغداد','images':[]})
 def test_service_requires_service_condition_and_supports_wanted_radar(self):
  with self.assertRaises(AssertionError):self.listing(title='خدمة تنظيف منزل',category='خدمات',condition='used')
  w=self.request(title='مطلوب خدمة توصيل',category='خدمات');self.assertEqual(w['category'],'خدمات')
  r=self.radar(title='رادار خدمة توصيل',keywords='توصيل',category='خدمات');self.assertEqual(r['category'],'خدمات')
