"""Pending proposal tested only on disposable networkless PostgreSQL fixtures."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
import unittest
import uuid
from local_database import LocalDatabase
ROOT=Path(__file__).resolve().parents[1]
class PairLockTests(unittest.TestCase):
    def setUp(self):
        self.db=LocalDatabase().start();self.addCleanup(self.db.stop);self.db.migrate()
        self.admin,self.a,self.b,self.banned=[str(uuid.uuid4()) for _ in range(4)]
        for uid,role,status in [(self.admin,'admin','approved'),(self.a,'rep','approved'),(self.b,'rep','approved'),(self.banned,'admin','banned')]:
            self.db.sql(f"INSERT INTO auth.users(id) VALUES ('{uid}'); INSERT INTO public.profiles(id,full_name,role,status,username) VALUES ('{uid}','Synthetic actor','{role}','{status}','u_{uuid.UUID(uid).hex[:12]}');")
        self.db.sql('GRANT INSERT(kind,created_by) ON public.chat_conversations TO authenticated; GRANT INSERT(conversation_id,user_id) ON public.chat_members TO authenticated;')
        self.db.sql((ROOT/'supabase/proposals/direct_chat_pair_lock.sql').read_text())
    def as_user(self,actor,sql,role='authenticated'):
        return self.db.sql(f"BEGIN; SET LOCAL ROLE {role};SET LOCAL request.jwt.claim.sub='{actor}';{sql}COMMIT;",check=False)
    def compete(self,calls):
        barrier=threading.Barrier(len(calls))
        def run(call):
            actor,sql=call;barrier.wait(timeout=5)
            return self.as_user(actor,sql+'SELECT pg_sleep(0.2);')
        with ThreadPoolExecutor(max_workers=len(calls)) as pool:results=list(pool.map(run,calls))
        for result in results:self.assertEqual(result.returncode,0,result.stderr)
        return [r.stdout.strip().splitlines()[0] for r in results]
    def test_opposite_pair_requests_return_one_conversation_and_exact_members(self):
        self.assertEqual(self.as_user(self.admin,'SELECT public.ensure_chat_ready();').returncode,0)
        ids=self.compete([(self.a,f"SELECT public.create_direct_chat('{self.b}');"),(self.b,f"SELECT public.create_direct_chat('{self.a}');")])
        self.assertEqual(ids[0],ids[1])
        self.assertEqual(self.db.sql("SELECT count(*) FROM public.chat_conversations WHERE kind='direct';").stdout.strip(),'1')
        self.assertEqual(self.db.sql(f"SELECT count(*) FROM public.chat_members WHERE conversation_id='{ids[0]}';").stdout.strip(),'2')
        self.assertEqual(self.as_user(self.a,f"SELECT public.create_direct_chat('{self.b}');").stdout.strip(),ids[0])
    def test_simultaneous_group_bootstrap_creates_one_group(self):
        ids=self.compete([(self.a,'SELECT public.ensure_chat_ready();'),(self.b,'SELECT public.ensure_chat_ready();')])
        self.assertEqual(ids[0],ids[1])
        self.assertEqual(self.db.sql("SELECT count(*) FROM public.chat_conversations WHERE kind='group';").stdout.strip(),'1')
        self.assertEqual(self.db.sql(f"SELECT count(*) FROM public.chat_members WHERE user_id='{self.banned}';").stdout.strip(),'0')
    def test_direct_insert_delete_bypasses_are_denied_but_read_marker_remains(self):
        group=self.as_user(self.a,'SELECT public.ensure_chat_ready();').stdout.strip()
        for query in [f"INSERT INTO public.chat_conversations(kind,created_by) VALUES ('direct','{self.a}');",f"INSERT INTO public.chat_members(conversation_id,user_id) VALUES ('{group}','{self.b}');",f"DELETE FROM public.chat_members WHERE conversation_id='{group}';"]:
            result=self.as_user(self.a,query)
            self.assertNotEqual(result.returncode,0);self.assertIn('42501',result.stderr)
        self.assertEqual(self.as_user(self.a,f"UPDATE public.chat_members SET last_read_at=now() WHERE conversation_id='{group}' AND user_id='{self.a}';").returncode,0)
    def test_inactive_admin_and_visitor_cannot_create_conversations(self):
        for actor,role in [(self.banned,'authenticated'),(self.a,'anon')]:
            result=self.as_user(actor,f"SELECT public.create_direct_chat('{self.b}');",role)
            self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.db.sql('SELECT count(*) FROM public.chat_conversations;').stdout.strip(),'0')
if __name__=='__main__':unittest.main()
