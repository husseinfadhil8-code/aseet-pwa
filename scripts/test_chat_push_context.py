import json,subprocess,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class ChatPushContextTests(unittest.TestCase):
    def test_only_a_fresh_matching_device_lease_mutes_chat(self):
        source=(ROOT/'supabase/functions/push-notifications/chat-visibility.js').read_text()
        js="""const {chatPushMuted}=await import('data:text/javascript,'+encodeURIComponent(SOURCE));
const now=100000,sub={waseet_chat_visibility:{conversation_id:'group',expires_at:now+12000}};
const assert=(v,msg)=>{if(!v)throw Error(msg)};
assert(chatPushMuted(sub,'group',now),'open group');
assert(!chatPushMuted(sub,'private',now),'different conversation');
assert(!chatPushMuted(sub,null,now),'non-chat push');
assert(!chatPushMuted({},'group',now),'another device or legacy client');
assert(!chatPushMuted(sub,'group',now+12000),'expired lease');
assert(!chatPushMuted(sub,'group',now-1),'invalid future timestamp');
assert(!chatPushMuted({waseet_chat_visibility:{conversation_id:'group',expires_at:'112000'}},'group',now),'invalid metadata');
""".replace('SOURCE',json.dumps(source))
        result=subprocess.run(['node','--input-type=module','-e',js],cwd=ROOT,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
