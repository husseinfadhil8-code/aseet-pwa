"""Isolated PostgreSQL support privacy/reply/outbox tests; no hosted writes."""
import unittest,json,uuid
from intelligence_database import IntelligenceTests,ROOT
class SupportTests(IntelligenceTests):
 @classmethod
 def setUpClass(cls):
  super().setUpClass();cls.sql((ROOT/'db/011_notification_outbox.sql').read_text());cls.sql((ROOT/'db/014_support_replies.sql').read_text())
 def support(self,actor,op,data=None,admin=None):
  body=json.dumps(data or {},ensure_ascii=False).replace("'","''")
  return json.loads(self.sql(f"select tg_market_support_action({actor},'{op}','{body}',{str(actor==3 if admin is None else admin).lower()},'Synthetic')",'service_role'))
 def ticket(self,actor=1):
  self.support(actor,'create',{'body':'Synthetic support request'});return self.support(actor,'inbox')['tickets'][0]
 def test_support_user_only_reads_own_requests_and_replies(self):
  a=self.ticket(1);b=self.ticket(2)
  self.support(3,'reply',{'ticket':a['id'],'body':'Private safe reply','confirmed':True,'request':str(uuid.uuid4())})
  one=self.support(1,'inbox')['tickets'];two=self.support(2,'inbox')['tickets']
  self.assertEqual([t['id'] for t in one],[a['id']]);self.assertEqual(one[0]['replies'][0]['body'],'Private safe reply')
  self.assertEqual([t['id'] for t in two],[b['id']]);self.assertEqual(two[0]['replies'],[])
  self.assertEqual(len(self.support(3,'admin')['tickets']),2)
 def test_support_only_root_can_reply_and_confirmation_is_required(self):
  a=self.ticket(1);data={'ticket':a['id'],'body':'Reply','confirmed':True,'request':str(uuid.uuid4())}
  for actor in [1,2]:
   with self.assertRaises(AssertionError):self.support(actor,'reply',data,admin=True)
   with self.assertRaises(AssertionError):self.support(actor,'admin',{},admin=True)
  with self.assertRaises(AssertionError):self.support(3,'reply',{**data,'confirmed':False})
  with self.assertRaises(AssertionError):self.support(3,'reply',data,admin=False)
 def test_support_reply_replay_is_idempotent_and_outbox_is_atomic(self):
  a=self.ticket();data={'ticket':a['id'],'body':'Safe root response','confirmed':True,'request':str(uuid.uuid4())}
  r=self.support(3,'reply',data);self.assertEqual(self.support(3,'reply',data),r)
  self.assertEqual(self.sql('select count(*) from tg_market_support_replies'),'1')
  self.assertEqual(self.sql("select count(*) from notification_outbox where source_table='tg_market_support_replies'"),'1')
  with self.assertRaises(AssertionError):self.support(3,'reply',{**data,'body':'Changed response'})
  self.sql("alter table notification_outbox add constraint synthetic_support_fail check(source_table!='tg_market_support_replies') not valid")
  try:
   with self.assertRaises(AssertionError):self.support(3,'reply',{**data,'request':str(uuid.uuid4())})
   self.assertEqual(self.sql('select count(*) from tg_market_support_replies'),'1')
  finally:self.sql('alter table notification_outbox drop constraint synthetic_support_fail')
 def test_support_direct_clients_cannot_read_or_impersonate(self):
  for role in ['anon','authenticated','service_role']:
   self.sql('select * from public.tg_market_support_replies',role,deny=True)
  for role in ['anon','authenticated']:
   self.sql("select tg_market_support_action(3,'admin','{}',true)",role,deny=True)
  self.assertEqual(self.sql("select relrowsecurity and relforcerowsecurity from pg_class where relname='tg_market_support_replies'"),'t')
 def test_support_blank_response_and_missing_ticket_rejected(self):
  for body in ['', ' '*10,'x'*1801]:
   with self.assertRaises(AssertionError):self.support(3,'reply',{'ticket':str(uuid.uuid4()),'body':body,'confirmed':True,'request':str(uuid.uuid4())})
if __name__=='__main__':
 suite=unittest.TestSuite(SupportTests(n) for n in unittest.defaultTestLoader.getTestCaseNames(SupportTests) if n.startswith('test_support_'))
 raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
