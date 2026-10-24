"""Static HTML/JS and service-worker boundaries; no browser or hosted requests."""
from html.parser import HTMLParser
from pathlib import Path
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
        for name in ['loginForm','signupForm','recoveryForm','authMessage','goodsSearch','goodsList']:
            self.assertIn(name,parser.ids)

    def test_javascript_syntax(self):
        for path in ['app.js','chat.js','experience.js','sw.js']:
            result=subprocess.run(['node','--check',str(ROOT/path)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)

    def test_manifests_share_identity_and_colors(self):
        a,b=[json.loads((ROOT/name).read_text()) for name in ['manifest.json','manifest.webmanifest']]
        for key in ['name','short_name','start_url','display','theme_color','background_color']:
            self.assertEqual(a[key],b[key],key)

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
