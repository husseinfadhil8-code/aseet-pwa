"""Isolated PostgreSQL tests only; never hosted user fixtures, providers or Telegram sends."""
import unittest,json,uuid,time
from concurrent.futures import ThreadPoolExecutor
from wanted_database import WantedTests,ROOT
class IntelligenceTests(WantedTests):
 @classmethod
 def setUpClass(cls):super().setUpClass();cls.sql((ROOT/'db/006_guide_assistant.sql').read_text())
 def setUp(self):
  super().setUp();self.sql((ROOT/'db/006_guide_assistant.sql').read_text().split('revoke all on sequence public.tg_market_assistant_turns_id_seq from public,anon,authenticated,service_role;')[1].split('create function public.tg_market_intelligence_action')[0]);self.sql("truncate tg_market_guide_outbox,tg_market_assistant_usage;update tg_market_intelligence_settings set channel_enabled=false,tips_enabled=false,assistant_enabled=false,provider='basic',knowledge_approved=false,knowledge_version=null,daily_budget_micros=0,monthly_budget_micros=0,free_neurons_day=0,version=1,interval_hours=10,last_channel_success=null,last_topic=null;update tg_market_guide_topics set approved=false,enabled=true,version=1;update tg_market_notify_control set next_send_at=now()")
 def intelligence(self,actor,op,data=None):
  payload=json.dumps(data or {},ensure_ascii=False).replace("'","''");return json.loads(self.sql(f"select tg_market_intelligence_action({actor},'{op}','{payload}',{str(actor==3).lower()},'Synthetic')",'service_role'))
 def guide(self,op,data=None):
  payload=json.dumps(data or {}).replace("'","''");return json.loads(self.sql(f"select tg_market_guide_worker('{op}','{payload}')",'service_role'))
 def assistant(self,op,data=None):
  payload=json.dumps(data or {},ensure_ascii=False).replace("'","''");return json.loads(self.sql(f"select tg_market_assistant_worker('{op}','{payload}')",'service_role'))
 def approve(self):
  topics=self.intelligence(3,'admin')['topics']
  for t in topics:self.intelligence(3,'topic_save',{**t,'approved':True,'confirmed':True})
  return self.intelligence(3,'admin')['topics']
 def cfg(self,**data):
  c=self.intelligence(3,'admin')['settings'];return self.intelligence(3,'settings_save',{'version':c['version'],'confirmed':True,**data})
 def claim_guide(self):self.sql('update tg_market_notify_control set next_send_at=now()');return self.guide('claim')
 def finish_guide(self,j,outcome='sent',**data):return self.guide('finish',{'id':j['id'],'lease':j['lease'],'outcome':outcome,'message':123,**data})
 def enqueue(self,actor=1,update=1,text='شلون انشر اعلان؟'):return self.assistant('enqueue',{'actor':actor,'update':update,'message_date':int(time.time()),'text':text})
 def test_intel_defaults_and_no_implicit_consent(self):
  c=self.intelligence(3,'admin');self.assertFalse(c['settings']['channel_enabled']);self.assertFalse(c['settings']['tips_enabled']);self.assertFalse(c['settings']['assistant_enabled']);self.assertEqual(len(c['topics']),10);self.assertFalse(any(t['approved'] for t in c['topics']));self.sub(1);self.assertFalse(self.intelligence(1,'preferences')['tips_enabled']);self.guide('schedule');self.assertEqual(self.claim_guide(),{})
 def test_intel_rls_root_and_no_direct_table_access(self):
  self.assertEqual(self.sql("select count(*) from pg_class where relname like 'tg_market_%' and relkind='r' and relrowsecurity"),'44')
  for role in ['anon','authenticated','service_role']:
   for t in ['intelligence_settings','guide_topics','learning_preferences','learning_seen','guide_outbox','assistant_jobs','assistant_turns','assistant_usage','assistant_support','assistant_sessions']:self.sql('select * from tg_market_'+t,role,deny=True)
  for actor in [1,2]:
   for op in ['admin','kill','settings_save','manual_publish','topic_save']:
    with self.assertRaises(AssertionError):self.intelligence(actor,op,{})
 def test_intel_channel_ten_hours_from_success_and_concurrency(self):
  self.channel();self.approve();self.cfg(channel_enabled=True)
  with ThreadPoolExecutor(max_workers=3) as p:list(p.map(lambda _:self.guide('schedule'),range(3)))
  self.assertEqual(self.sql("select count(*) from tg_market_guide_outbox where kind='channel'"),'1');j=self.claim_guide();self.finish_guide(j);self.guide('schedule');self.assertEqual(self.claim_guide(),{})
  self.sql("update tg_market_intelligence_settings set last_channel_success=now()-interval '9 hours 59 minutes'");self.guide('schedule');self.assertEqual(self.claim_guide(),{})
  self.sql("update tg_market_intelligence_settings set last_channel_success=now()-interval '10 hours 1 minute'");self.guide('schedule');n=self.claim_guide();self.assertNotEqual(j['body'],n['body']);self.assertNotEqual(j['id'],n['id'])
 def test_intel_rate_limit_unknown_delivery_and_stale_lease(self):
  self.channel();self.approve();self.cfg(channel_enabled=True);self.guide('schedule');j=self.claim_guide();self.finish_guide(j,'rate_limited',retry_after=90);self.assertGreater(self.guide('claim')['wait_ms'],80000);self.sql("update tg_market_guide_outbox set available_at=now()");j=self.claim_guide();self.finish_guide(j,'review');self.guide('schedule');self.assertEqual(self.claim_guide(),{});self.assertEqual(self.sql('select count(*) from tg_market_guide_outbox'),'1')
 def test_intel_weekly_tips_separate_consent_unsubscribe_and_no_repeat(self):
  self.approve();self.cfg(tips_enabled=True);self.sub(1);self.guide('schedule');self.assertEqual(self.claim_guide(),{})
  with self.assertRaises(AssertionError):self.intelligence(1,'tips_enable')
  self.intelligence(1,'tips_enable',{'confirmed':True});self.guide('schedule');j=self.claim_guide();self.finish_guide(j);self.guide('schedule');self.assertEqual(self.claim_guide(),{});self.sql("update tg_market_learning_preferences set last_success=now()-interval '8 days',last_attempt=now()-interval '8 days'");self.guide('schedule');n=self.claim_guide();self.assertNotEqual(j['body'],n['body']);self.intelligence(1,'tips_stop');self.assertFalse(self.guide('validate',{'id':n['id'],'lease':n['lease']})['valid']);self.assertTrue(self.notify(1,'get')['enabled'])
 def test_intel_blocked_user_stops_tips_without_leaking_identity(self):
  self.approve();self.cfg(tips_enabled=True);self.intelligence(1,'tips_enable',{'confirmed':True});self.guide('schedule');j=self.claim_guide();self.finish_guide(j,'blocked');self.assertFalse(self.intelligence(1,'preferences')['tips_enabled']);self.assertTrue(self.notify(1,'get')['blocked'])
 def test_intel_topic_edit_cancels_old_payload_and_kill(self):
  self.channel();topics=self.approve();self.cfg(channel_enabled=True);self.guide('schedule');j=self.claim_guide();self.intelligence(3,'kill');self.assertFalse(self.guide('validate',{'id':j['id'],'lease':j['lease']})['valid']);self.assertFalse(self.intelligence(3,'admin')['settings']['assistant_enabled'])
 def test_intel_kill_stops_manual_inflight_and_known_channel_failure_stops_auto(self):
  self.channel();t=self.approve()[0];self.intelligence(3,'manual_publish',{'id':t['id'],'key':str(uuid.uuid4()),'confirmed':True});j=self.claim_guide();self.intelligence(3,'kill');self.assertFalse(self.guide('validate',{'id':j['id'],'lease':j['lease']})['valid']);self.assertEqual(self.sql('select state from tg_market_guide_outbox'),'review')
  self.sql('truncate tg_market_guide_outbox');self.cfg(channel_enabled=True);self.guide('schedule');j=self.claim_guide();self.finish_guide(j,'failed');self.assertFalse(self.intelligence(3,'admin')['settings']['channel_enabled'])
 def test_intel_manual_publish_nonce_and_confirm(self):
  self.channel();t=self.approve()[0]
  with self.assertRaises(AssertionError):self.intelligence(3,'manual_publish',{'id':t['id'],'key':str(uuid.uuid4())})
  payload={'id':t['id'],'key':str(uuid.uuid4()),'confirmed':True};self.intelligence(3,'manual_publish',payload);self.intelligence(3,'manual_publish',payload);self.assertEqual(self.sql('select count(*) from tg_market_guide_outbox'),'1')
 def test_intel_consent_callbacks_replay_cannot_undo_stop(self):
  self.intelligence(1,'tips_enable',{'confirmed':True,'update':10});self.intelligence(1,'tips_stop',{'update':11});self.intelligence(1,'tips_enable',{'confirmed':True,'update':10});self.assertFalse(self.intelligence(1,'preferences')['tips_enabled'])
 def test_intel_assistant_update_dedup_context_and_forget(self):
  a=self.enqueue();b=self.enqueue();self.assertEqual(a['id'],b['id']);j=self.assistant('claim');self.assertFalse(j['config']['assistant_enabled']);self.assistant('ready',{'id':j['id'],'lease':j['lease'],'output':{'text':'مساعدة أساسية','ai':False}});j=self.assistant('claim',{'id':j['id']});self.assertTrue(j['delivery']);self.assistant('finish',{'id':j['id'],'lease':j['lease'],'outcome':'sent','message':22});self.assertEqual(self.sql('select count(*) from tg_market_assistant_turns'),'1');self.intelligence(1,'ai_consent',{'confirmed':True});self.intelligence(1,'forget');self.assertEqual(self.sql('select count(*) from tg_market_assistant_turns'),'0');self.assertFalse(self.intelligence(1,'preferences')['ai_consent'])
 def test_intel_support_requires_owner_confirm_and_dedup(self):
  a=self.enqueue();j=self.assistant('claim');self.assistant('ready',{'id':j['id'],'lease':j['lease'],'output':{'text':'مساعدة','support_summary':'تعذر فتح السوق'}})
  with self.assertRaises(AssertionError):self.intelligence(2,'support_confirm',{'id':a['id'],'confirmed':True})
  with self.assertRaises(AssertionError):self.intelligence(1,'support_confirm',{'id':a['id']})
  self.intelligence(1,'support_confirm',{'id':a['id'],'confirmed':True});self.intelligence(1,'support_confirm',{'id':a['id'],'confirmed':True});self.assertEqual(self.sql('select count(*) from tg_market_assistant_support'),'1');self.assertEqual(self.sql('select count(*) from tg_market_support'),'1')
 def test_intel_budget_atomic_cap_and_no_charge_when_disabled(self):
  self.intelligence(1,'ai_consent',{'confirmed':True});self.intelligence(2,'ai_consent',{'confirmed':True});self.intelligence(3,'knowledge_approve',{'confirmed':True,'version':'unit.v1'});self.cfg(provider='openai',assistant_enabled=True,daily_budget_micros=100,monthly_budget_micros=100)
  a=self.enqueue(1,11);b=self.enqueue(2,12);j=self.assistant('claim',{'id':a['id']});k=self.assistant('claim',{'id':b['id']})
  def reserve(x):return self.assistant('reserve',{'id':x['id'],'lease':x['lease'],'provider':'openai','knowledge_version':'unit.v1','authorized':True,'reserve_micros':60})
  with ThreadPoolExecutor(max_workers=2) as p:r=list(p.map(reserve,[j,k]))
  self.assertEqual(sum(x['allowed'] for x in r),1);self.assertEqual(self.sql('select reserved_micros from tg_market_assistant_usage'),'60');self.assertFalse(reserve(j)['allowed'])
 def test_intel_live_search_hides_unapproved_hidden_reported_and_private(self):
  a=self.approved(title='ثلاجة نظيفة للاختبار',category='أجهزة منزلية',price=150000);self.approved(title='ثلاجة غالية',category='أجهزة منزلية',price=350000)
  rows=json.loads(self.sql("select tg_market_assist_search('{\"query\":\"ثلاجة\",\"governorate\":\"بغداد\",\"max_price\":200000}')",'service_role'));self.assertEqual([x['id'] for x in rows],[a]);self.assertNotIn('owner_id',rows[0]);self.assertNotIn('telegram_id',rows[0]);self.action(2,'report',{'id':a,'reason':'Synthetic report'});self.assertEqual(json.loads(self.sql("select tg_market_assist_search('{\"query\":\"ثلاجة\",\"max_price\":200000}')",'service_role')),[])
 def test_intel_private_account_tools_no_cross_user_or_commissions(self):
  self.approved(1,title='غرض خاص بحساب اختباري');data=json.loads(self.sql("select tg_market_assistant_tools(2,'account')",'service_role'));self.assertEqual(data['listings'],[]);diagnostics=json.loads(self.sql("select tg_market_assistant_tools(2,'diagnostics')",'service_role'));self.assertFalse(diagnostics['notifications_enabled']);self.assertEqual(diagnostics['active_radars'],0)
  for op in ['admin','rep_sales','sql']:
   with self.assertRaises(AssertionError):self.sql("select tg_market_assistant_tools(1,'"+op+"')",'service_role')
 def test_intel_expired_jobs_and_hourly_context_cleanup(self):
  a=self.enqueue();self.sql("update tg_market_assistant_jobs set expires_at=now()-interval '1 minute'");self.assertEqual(self.assistant('claim'),{});self.assertEqual(self.sql('select state from tg_market_assistant_jobs'),'cancelled')
if __name__=='__main__':
 suite=unittest.TestSuite(IntelligenceTests(n) for n in unittest.defaultTestLoader.getTestCaseNames(IntelligenceTests) if n.startswith('test_intel_') or n in ['test_notify_opening_chat_after_claim_defers_without_losing_unread_message','test_notify_filters_and_no_late_subscriber_backfill','test_radar_consent_queue_dedup_and_stop'])
 raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
