import hashlib,subprocess,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class ReleaseUnitTests(unittest.TestCase):
    def test_chat_sender_identity_and_draft_boundaries(self):
        script=(ROOT/'chat.js').read_text()
        self.assertIn('return person?.full_name || "مستخدم";',script)
        self.assertNotIn('person?.role === "admin" ? "حسين فاضل"',script)
        self.assertIn('const conversationId = activeChatId;',script)
        self.assertIn('const senderId = currentUser.id;',script)
        self.assertIn('conversation_id:conversationId, sender_id:senderId, body',script)
        self.assertIn('activeChatId === conversationId && input?.value.trim() === body',script)
        self.assertIn('if (currentUser?.id === senderId)',script)

    def test_chat_conversation_refresh_discards_stale_responses(self):
        script=r"""
const fs=require('node:fs'),vm=require('node:vm');
const pending=[],list={innerHTML:'unchanged'};
const sandbox={
  window:{},document:{addEventListener(){}},currentUser:{id:'A'},
  db:{from(table){
    if(table!=='chat_members')throw new Error('Stale request queried another table');
    return {select(){return {eq(_field,id){
      return new Promise((resolve,reject)=>pending.push({id,resolve,reject}));
    }}}};
  }},
  $:id=>id==='chatConversationList'?list:null,console
};
vm.runInNewContext(fs.readFileSync('chat.js','utf8'),sandbox);
(async()=>{
  const old=sandbox.window.loadChatConversations();
  const latest=sandbox.window.loadChatConversations();
  if(pending.length!==2)throw new Error('Expected two pending requests');
  pending[1].resolve({data:[]});
  await latest;
  if(!list.innerHTML.includes('ماكو محادثات'))throw new Error('Latest response not rendered');
  const correct=list.innerHTML;
  pending[0].reject(new Error('Stale network failure'));
  await old;
  if(list.innerHTML!==correct)throw new Error('Stale error overwrote latest list');
  list.innerHTML='untouched';
  const priorAccount=sandbox.window.loadChatConversations();
  sandbox.currentUser={id:'B'};
  pending[2].resolve({data:[]});
  await priorAccount;
  if(list.innerHTML!=='untouched')throw new Error('Previous account changed current UI');
})().catch(error=>{console.error(error);process.exitCode=1});
"""
        result=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_vendored_sdk_is_pinned(self):
        digest=hashlib.sha256((ROOT/'vendor/supabase-2.118.0.js').read_bytes()).hexdigest()
        self.assertEqual(digest,'ee3be8de192b97cb1d73d1e95d6b82bb1f6b658c0f97c4ef757fc331996ed3d3')
        self.assertIn('./vendor/supabase-2.118.0.js',(ROOT/'index.html').read_text())
        self.assertTrue((ROOT/'vendor/LICENSE.supabase').is_file())

    def test_worker_caches_only_reviewed_static_assets(self):
        script=r"""
const vm=require('node:vm'),fs=require('node:fs');
const events={},writes=[];
const sandbox={URL,Set,Response,self:{location:{href:'https://app.invalid/sub/sw.js',origin:'https://app.invalid'},addEventListener:(name,fn)=>events[name]=fn},caches:{open:async()=>({put:async(url)=>writes.push(url),match:async()=>new Response('cached-release')}),keys:async()=>[]},fetch:async()=>new Response('static',{status:200})};
vm.runInNewContext(fs.readFileSync('sw.js','utf8'),sandbox);
(async()=>{
 for(const url of ['https://test.invalid/rest/v1/goods','https://app.invalid/sub/private.json','https://app.invalid/sub/sw.js']){
  let intercepted=false;events.fetch({request:{method:'GET',url},respondWith:()=>intercepted=true});
  if(intercepted)throw new Error('Non-static or private request intercepted');
 }
 let pending;events.fetch({request:{method:'GET',url:'https://app.invalid/sub/app.js?v=release'},respondWith:p=>pending=p});
 if((await pending).status!==200)throw new Error('Static fetch failed');
 if(writes.length)throw new Error('An active release cache was overwritten');
 if(await (await pending).text()!=='cached-release')throw new Error('Mixed deployment assets');
 sandbox.fetch=async()=>{throw new Error('offline')};
 for(const name of ['app.js','welcome-dashboard.js','welcome-dashboard.css','assets/waseet-market-hero.svg']){
  pending=null;
  events.fetch({request:{method:'GET',url:'https://app.invalid/sub/'+name+'?v=release'},respondWith:p=>pending=p});
  if(!pending || await (await pending).text()!=='cached-release')throw new Error('Offline fallback failed: '+name);
 }
})().catch(error=>{console.error(error.message);process.exitCode=1});
"""
        result=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_reviewed_login_contract_is_pinned(self):
        text=(ROOT/"app.js").read_text()
        start=text.index('window.handleLogin = async function() {')
        end=text.index("\n};",start)+4
        self.assertEqual(hashlib.sha256(text[start:end].encode()).hexdigest(),'ef0b70ebf641e2ed37a5d210f705e0ae12e7ffb49b9102a6612214208348a809')

    def test_reviewed_signup_contract_is_pinned(self):
        text=(ROOT/"app.js").read_text()
        start=text.index('window.handleSignup = async function() {')
        end=text.index("\n};",start)+4
        self.assertEqual(hashlib.sha256(text[start:end].encode()).hexdigest(),'51492cee2e456ebff3ccfe7de180d98bd26b74abe3e462eb46ba68eaf79a93a4')

    def test_real_sdk_transport_preserves_cursor_and_search_groups(self):
        result=subprocess.run(['node','scripts/check_sdk.cjs'],cwd=ROOT,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

class AppIconCompatibilityTests(unittest.TestCase):
    def test_native_png_icons_exist_at_the_declared_sizes(self):
        import json,struct
        manifest=json.loads((ROOT/'manifest.json').read_text())
        pngs=[icon for icon in manifest['icons'] if icon['type']=='image/png']
        self.assertGreaterEqual(len(pngs),3)
        for icon in pngs:
            path=ROOT/icon['src'].removeprefix('./');data=path.read_bytes()
            self.assertEqual(data[:8],b'\x89PNG\r\n\x1a\n')
            width,height=struct.unpack('>II',data[16:24])
            self.assertEqual(f'{width}x{height}',icon['sizes'])
        self.assertIn('assets/apple-touch-icon.png',(ROOT/'index.html').read_text())
