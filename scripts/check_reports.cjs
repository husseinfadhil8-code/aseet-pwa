// Real vendored SDK, synthetic transport only; never contacts Supabase.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
function setup(responses){
 const requests=[];
 const box={console,URL,URLSearchParams,Headers,Response,Request,AbortController,TextEncoder,TextDecoder,setTimeout,clearTimeout,setInterval,clearInterval};box.window=box;
 vm.createContext(box);vm.runInContext(fs.readFileSync('vendor/supabase-2.118.0.js','utf8'),box);
 box.db=box.supabase.createClient('https://test.invalid','offline-public-fixture',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},realtime:{transport:class FakeWebSocket{}},global:{fetch:async(url,options)=>{
  requests.push({url:new URL(url),options});const reply=responses.shift();assert.ok(reply,'Unexpected request');
  if(reply instanceof Error)throw reply;
  return new Response(JSON.stringify(reply.data),{status:reply.status||200,headers:{'Content-Type':'application/json',...(reply.count===undefined?{}:{'Content-Range':`0-${Math.max(0,reply.data.length-1)}/${reply.count}`})}});
 }}});
 for(const file of ['paging-utils.js','report-data.js'])vm.runInContext(fs.readFileSync(file,'utf8'),box);
 return {box,requests,read:(...args)=>box.readReportRows(...args)};
}
const row=n=>({id:'00000000-0000-0000-0000-'+String(n).padStart(12,'0'),created_at:'2026-10-25T10:00:00+00:00',rep_share:60});
(async()=>{
 let t=setup([{data:[row(3)],count:3},{data:[row(2)],count:2},{data:[row(1)],count:1}]);
 assert.equal((await t.read('sales',{repId:'test-rep'})).data.length,3);
 for(const {url,options} of t.requests){assert.equal(url.searchParams.get('limit'),'200');assert.equal(url.searchParams.get('order'),'created_at.desc.nullslast,id.desc');assert.equal(url.searchParams.get('rep_id'),'eq.test-rep');assert.equal(options.method,'GET');}
 assert.ok(t.requests[1].url.searchParams.get('or').includes(row(3).id));
 t=setup([{data:[row(3)],count:3},{data:[{...row(2),created_at:null}],count:2},{data:[{...row(1),created_at:null}],count:1}]);
 assert.equal((await t.read('sales')).data.length,3);
 assert.ok(t.requests[1].url.searchParams.get('or').includes('created_at.is.null'));
 assert.equal(t.requests[2].url.searchParams.get('or'),`(and(created_at.is.null,id.lt.${row(2).id}))`);
 t=setup([{data:[row(2)]},{data:[row(1)]},{data:[]}]);assert.equal((await t.read('inquiries')).data.length,2);assert.equal(t.requests.length,3);
 t=setup([{data:[row(1)],count:2},{data:[row(1)],count:1}]);await assert.rejects(t.read('sales'),/Repeated/);
 t=setup([{data:[],count:2}]);await assert.rejects(t.read('sales'),/Incomplete/);
 t=setup([{data:[{id:'invalid',created_at:'bad'}],count:1}]);await assert.rejects(t.read('sales'));
 t=setup(Array.from({length:50},(_,i)=>({data:[row(100-i)],count:100-i})));await assert.rejects(t.read('sales'),e=>e.code==='REPORT_PAGE_LIMIT');assert.equal(t.requests.length,50);
 t=setup([]);const stale=await t.read('sales',{valid:()=>false});assert.equal(stale.stale,true);assert.equal(t.requests.length,0);
 t=setup([{data:[row(1)],count:1}]);let checks=0;assert.equal((await t.read('sales',{valid:()=>++checks===1})).stale,true);
 t=setup([{data:[row(2)],count:2},{data:{message:'offline',code:'offline'},status:503}]);await assert.rejects(t.read('sales'));
 t=setup([]);await assert.rejects(t.read('profiles'));assert.equal(t.requests.length,0);
})().catch(error=>{console.error(error);process.exitCode=1});
