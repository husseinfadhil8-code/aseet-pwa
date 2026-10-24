"""Static HTML/JS and service-worker boundaries; no browser or hosted requests."""
from html.parser import HTMLParser
from pathlib import Path
import hashlib
import json
import subprocess
import unittest

ROOT=Path(__file__).resolve().parents[1]
class Markup(HTMLParser):
    def __init__(self):super().__init__();self.ids=[];self.viewport=''
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if 'id' in attrs:self.ids.append(attrs['id'])
        if tag=='meta' and attrs.get('name')=='viewport':self.viewport=attrs.get('content','')

class WebAssetTests(unittest.TestCase):
    def test_html_ids_and_accessible_viewport(self):
        parser=Markup();parser.feed((ROOT/'index.html').read_text())
        self.assertEqual(len(parser.ids),len(set(parser.ids)))
        self.assertNotIn('user-scalable=no',parser.viewport)
        self.assertNotIn('fonts.googleapis.com',(ROOT/'index.html').read_text())
        for name in ['loginForm','signupForm','recoveryForm','authMessage','goodsSearch','goodsList']:
            self.assertIn(name,parser.ids)

    def test_javascript_syntax(self):
        for path in ['app.js','market-data.js','chat.js','experience.js','sw.js']:
            result=subprocess.run(['node','--check',str(ROOT/path)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)

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

    def test_manifests_share_identity_and_colors(self):
        a,b=[json.loads((ROOT/name).read_text()) for name in ['manifest.json','manifest.webmanifest']]
        for key in ['name','short_name','start_url','display','theme_color','background_color']:
            self.assertEqual(a[key],b[key],key)

    def test_vendored_sdk_is_pinned(self):
        digest=hashlib.sha256((ROOT/'vendor/supabase-2.118.0.js').read_bytes()).hexdigest()
        self.assertEqual(digest,'ee3be8de192b97cb1d73d1e95d6b82bb1f6b658c0f97c4ef757fc331996ed3d3')
        self.assertIn('./vendor/supabase-2.118.0.js',(ROOT/'index.html').read_text())
        self.assertTrue((ROOT/'vendor/LICENSE.supabase').is_file())

    def test_real_sdk_transport_keeps_cursor_and_search_groups(self):
        result=subprocess.run(['node','scripts/check_sdk.cjs'],cwd=ROOT,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_worker_caches_only_reviewed_static_assets(self):
        script=r"""
const vm=require('node:vm'),fs=require('node:fs');
const events={},writes=[];
const sandbox={URL,Set,Response,self:{location:{href:'https://app.invalid/sub/sw.js',origin:'https://app.invalid'},addEventListener:(name,fn)=>events[name]=fn},caches:{open:async()=>({put:async(url)=>writes.push(url),match:async()=>new Response('offline')}),keys:async()=>[]},fetch:async()=>new Response('static',{status:200})};
vm.runInNewContext(fs.readFileSync('sw.js','utf8'),sandbox);
(async()=>{
 for(const url of ['https://test.invalid/rest/v1/goods','https://app.invalid/sub/private.json','https://app.invalid/sub/sw.js']){
  let intercepted=false;events.fetch({request:{method:'GET',url},respondWith:()=>intercepted=true});
  if(intercepted)throw new Error('Non-static or private request intercepted');
 }
 let pending;events.fetch({request:{method:'GET',url:'https://app.invalid/sub/app.js?v=release'},respondWith:p=>pending=p});
 if((await pending).status!==200)throw new Error('Static fetch failed');
 if(writes[0]!=='https://app.invalid/sub/app.js')throw new Error('Wrong cache key');
 sandbox.fetch=async()=>{throw new Error('offline')};
 events.fetch({request:{method:'GET',url:'https://app.invalid/sub/app.js?v=release'},respondWith:p=>pending=p});
 if(await (await pending).text()!=='offline')throw new Error('Offline fallback failed');
})().catch(error=>{console.error(error.message);process.exitCode=1});
"""
        result=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

if __name__=='__main__':unittest.main()
