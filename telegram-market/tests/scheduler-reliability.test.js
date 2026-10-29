import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {budgetFetch,remainingRequests} from '../src/notification-budget.js';
import {rpc,SafeError} from '../src/services.js';
import {notificationError} from '../src/notification-errors.js';
import {runScheduledNotifications} from '../src/notification-scheduler.js';
import {reconcileNotificationOutbox,monitorNotificationOutbox} from '../src/notification-outbox.js';
const original=globalThis.fetch;afterEach(()=>{globalThis.fetch=original});
const base={SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only'};
function memoryOps(){
 const meta=new Map(),leases=new Map();let alerts=0;
 function prepare(sql){let args=[];return {bind(...a){args=a;return this},async first(){if(sql.includes('INSERT INTO tg_ops_leases')){const key=/VALUES\('([^']+)',\?\)/.exec(sql)[1],current=leases.get(key);if(current!==undefined&&current>=args[1])return null;leases.set(key,args[0]);return {name:key}}if(sql.includes('COUNT(*)'))return {n:0};if(sql.includes('notification_scheduler_cursor'))return meta.has('notification_scheduler_cursor')?{value:meta.get('notification_scheduler_cursor')}:null;return null},async all(){return {results:[]}},async run(){if(sql.includes('UPDATE tg_ops_leases')){const key=/name='([^']+)'/.exec(sql)[1];if(leases.get(key)!==args[1])return {meta:{changes:0}};leases.set(key,args[0]);return {meta:{changes:1}}}if(sql.includes('DELETE FROM tg_ops_leases')){const key=/name='([^']+)'/.exec(sql)[1];if(leases.get(key)!==args[0])return {meta:{changes:0}};leases.delete(key);return {meta:{changes:1}}}if(/INSERT (?:OR IGNORE )?INTO tg_n_events/.test(sql))alerts++;if(sql.includes('INSERT INTO tg_n_meta')){const literal=/VALUES\('([^']+)',\?\)/.exec(sql);if(literal)meta.set(literal[1],args[0]);else meta.set(args[0],args[1])}return {meta:{changes:1}}}}}
 return {prepare,async batch(statements){return Promise.all(statements.map(s=>s.run()))},meta,leases,get alerts(){return alerts}};
}
function native50(){let calls=0;return {get calls(){return calls},reset(){calls=0},async fetch(){calls++;if(calls>50)throw Error('Too many subrequests by single Worker invocation. To configure this limit, refer to https://workers.example/limits');return Response.json({ok:true})}}}
test('70-job burst drains across ticks without hitting native 50 or starving later stages',async()=>{
 const native=native50();globalThis.fetch=native.fetch;const OPS=memoryOps(),env={...base,OPS,NOTIFICATION_CENTER:'true'},pending=Array.from({length:70},(_,i)=>i),completed=[],runs={legacy:0,rewards:0},counts=[];
 const tasks=[{name:'center',minimum:8,run:async e=>{while(pending.length&&remainingRequests(e)){await budgetFetch(e,'https://synthetic.invalid/queued');completed.push(pending.shift())}}},{name:'legacy',minimum:4,run:async e=>{runs.legacy++;for(let i=0;i<4;i++)await budgetFetch(e,'https://synthetic.invalid/legacy')}},{name:'rewards',minimum:3,run:async e=>{runs.rewards++;for(let i=0;i<3;i++)await budgetFetch(e,'https://synthetic.invalid/rewards')}}];
 const first=await runScheduledNotifications(env,tasks);counts.push(native.calls);assert.equal(first.requests,44);assert.deepEqual(first.stages.slice(1).map(s=>s.status),['deferred','deferred']);assert.equal(pending.length,26);assert.equal(OPS.alerts,0);
 native.reset();const second=await runScheduledNotifications(env,tasks);counts.push(native.calls);assert.equal(second.stages[0].stage,'legacy');assert.equal(pending.length,0);assert.equal(completed.length,70);assert.equal(new Set(completed).size,70);assert.equal(runs.legacy,1);assert.equal(runs.rewards,1);assert.ok(counts.every(n=>n<=44&&n<50));assert.equal(OPS.alerts,0);
 assert.equal(JSON.parse(OPS.meta.get('notification_scheduler_last')).requests,second.requests);
});
test('budget object is shared across 70 concurrent RPCs and cloned environments',async()=>{
 const native=native50();globalThis.fetch=native.fetch;const budget={limit:44,used:0},env={...base,NOTIFICATION_REQUEST_BUDGET:budget};
 const results=await Promise.allSettled(Array.from({length:70},(_,i)=>rpc({...env},'synthetic_rpc',{i})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,44);assert.equal(native.calls,44);assert.equal(budget.used,44);assert.equal(remainingRequests(env),0);
 for(const r of results.filter(r=>r.status==='rejected'))assert.equal(r.reason.message,'notification_budget_deferred');
});
test('greedy stage is deferred safely and cursor gives other stages first turn next tick',async()=>{
 const native=native50();globalThis.fetch=native.fetch;const OPS=memoryOps(),env={...base,OPS,NOTIFICATION_CENTER:'true'},ran=[];
 const tasks=[{name:'greedy',minimum:1,run:async e=>{for(let i=0;i<70;i++)await budgetFetch(e,'https://synthetic.invalid/burst')}},{name:'other',minimum:1,run:async e=>{ran.push('other');await budgetFetch(e,'https://synthetic.invalid/other')}}];
 const first=await runScheduledNotifications(env,tasks);assert.equal(first.stages[0].status,'deferred');assert.equal(first.stages[0].code,'notification_budget_deferred');assert.equal(OPS.alerts,0);assert.equal(native.calls,44);
 native.reset();const second=await runScheduledNotifications(env,tasks);assert.equal(second.stages[0].stage,'other');assert.deepEqual(ran,['other']);assert.equal(second.stages[1].status,'deferred');assert.equal(OPS.alerts,0);assert.equal(native.calls,44);
});
test('network, timeout, malformed JSON and native quota errors get safe distinct codes and recover',async()=>{
 const cases=[{fail:()=>{throw TypeError('fetch failed https://synthetic.invalid/private-token Bearer secretCredentialValueThatMustNotAppear')},code:'database_network'},{fail:()=>{throw new DOMException('request timed out','TimeoutError')},code:'database_timeout'},{fail:()=>{throw new DOMException('aborted','AbortError')},code:'database_timeout'},{fail:()=>new Response('invalid JSON',{status:200}),code:'database_invalid_json'},{fail:()=>{throw Error('Too many subrequests by single Worker invocation. To configure this limit, refer to https://synthetic.invalid/private-token')},code:'worker_subrequest_limit'}];
 for(const {fail,code}of cases){const env={...base,NOTIFICATION_REQUEST_BUDGET:{limit:44,used:0}};globalThis.fetch=async()=>fail();await assert.rejects(()=>rpc(env,'synthetic'),e=>{assert.ok(e instanceof SafeError);assert.equal(e.status,503);assert.equal(e.message,code);assert.ok(!JSON.stringify(e.diagnostic).includes('private-token'));assert.ok(!JSON.stringify(e.diagnostic).includes('secretCredentialValueThatMustNotAppear'));return true});globalThis.fetch=async()=>Response.json({recovered:true});assert.deepEqual(await rpc(env,'synthetic'),{recovered:true});assert.equal(env.NOTIFICATION_REQUEST_BUDGET.used,2)}
 assert.equal(notificationError(Error('Too many subrequests by single Worker invocation')).code,'worker_subrequest_limit');
});
test('safe queued and health reads retry one transient failure and then reconcile normally',async()=>{
 const env={...base,OPS:memoryOps(),NOTIFICATION_OUTBOX:'true',NOTIFICATION_REQUEST_BUDGET:{limit:44,used:0}};let queued=0,health=0;
 globalThis.fetch=async url=>{if(String(url).endsWith('_queued')){queued++;if(queued===1)throw TypeError('fetch failed');return Response.json([])}if(String(url).endsWith('_health')){health++;return health===1?Response.json({message:'temporary'}, {status:503}):Response.json({stalled:0,repeated_failures:0,review:0})}assert.fail('unexpected RPC')};
 await reconcileNotificationOutbox(env);await monitorNotificationOutbox(env);assert.equal(queued,2);assert.equal(health,2);assert.equal(env.NOTIFICATION_REQUEST_BUDGET.used,4);
});
test('invalid queued/health shapes fail explicitly while exhausted budget emits no scheduler alarm',async()=>{
 const env={...base,OPS:memoryOps(),NOTIFICATION_OUTBOX:'true',NOTIFICATION_CENTER:'true',NOTIFICATION_REQUEST_BUDGET:{limit:44,used:0}};
 globalThis.fetch=async url=>Response.json(String(url).endsWith('_queued')?{}:null);
 await assert.rejects(()=>reconcileNotificationOutbox(env),e=>e.message==='outbox_invalid_rows');await assert.rejects(()=>monitorNotificationOutbox(env),e=>e.message==='outbox_invalid_health');
});
test('native model reproduces original unbounded failure at exactly fifty completed subrequests',async()=>{
 const native=native50();globalThis.fetch=native.fetch;
 const results=await Promise.allSettled(Array.from({length:70},(_,i)=>rpc({...base},'synthetic_unbounded',{i})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,50);
 assert.equal(results.filter(r=>r.status==='rejected').length,20);
 for(const r of results.filter(r=>r.status==='rejected'))assert.equal(r.reason.message,'worker_subrequest_limit');
});
test('genuine stage outage records one safe alert and later stage still runs',async()=>{
 let calls=0;globalThis.fetch=async()=>{if(++calls===1)throw TypeError('fetch failed https://synthetic.invalid/private-token');return Response.json({recovered:true})};
 const OPS=memoryOps(),env={...base,OPS,NOTIFICATION_CENTER:'true'},completed=[];
 const result=await runScheduledNotifications(env,[{name:'broken',minimum:1,run:e=>rpc(e,'synthetic_broken')},{name:'later',minimum:1,run:async e=>{await rpc(e,'synthetic_later');completed.push('later')}}]);
 assert.equal(result.stages[0].status,'error');assert.equal(result.stages[0].code,'database_network');assert.equal(result.stages[1].status,'ok');assert.deepEqual(completed,['later']);assert.equal(OPS.alerts,1);assert.equal(result.requests,2);assert.ok(!OPS.meta.get('notification_failure:scheduled_broken').includes('private-token'));
});
test('overlapping cron waits for held scheduler lease and future tick resumes after release',async()=>{
 const OPS=memoryOps(),env={...base,OPS,NOTIFICATION_CENTER:'true'};let release,started;const held=new Promise(r=>release=r),entered=new Promise(r=>started=r);let executions=0;
 const first=runScheduledNotifications(env,[{name:'held',minimum:0,run:async()=>{executions++;started();await held}}]);await entered;
 assert.deepEqual(await runScheduledNotifications(env,[{name:'other',minimum:0,run:async()=>{executions++}}]),{busy:true});assert.equal(executions,1);
 release();await first;assert.equal(OPS.leases.size,0);
 const next=await runScheduledNotifications(env,[{name:'other',minimum:0,run:async()=>{executions++}}]);assert.equal(next.stages[0].status,'ok');assert.equal(executions,2);assert.equal(OPS.leases.size,0);
});
test('stale scheduler owner does not delete its replacement lease',async()=>{
 const OPS=memoryOps(),env={...base,OPS};let replacement;
 await runScheduledNotifications(env,[{name:'replace',minimum:0,run:async()=>{replacement=Date.now()+900000;OPS.leases.set('notification_scheduler',replacement)}}]);
 assert.equal(OPS.leases.get('notification_scheduler'),replacement);
 assert.deepEqual(await runScheduledNotifications(env,[{name:'later',minimum:0,run:async()=>assert.fail('replacement lease must remain held')}]),{busy:true});
});
