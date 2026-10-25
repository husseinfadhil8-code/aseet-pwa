let handler: (req:Request)=>Promise<Response>;
(Deno as any).serve=(fn:any)=>{handler=fn;};
const environment: Record<string,string>={SUPABASE_URL:'https://test.invalid',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service',VAPID_PUBLIC_KEY:'fake',VAPID_PRIVATE_KEY:'fake'};
Deno.env.get=(name:string)=>environment[name];
await import('../../supabase/functions/push-notifications/index.ts');
const conversationId='00000000-0000-0000-0000-000000000001';
function reset(){(globalThis as any).pushTestState={member:true,writes:0,device:{id:'device',endpoint:'https://push.invalid/own',subscription:{endpoint:'https://push.invalid/own',keys:{p256dh:'fake',auth:'fake'}}}};return (globalThis as any).pushTestState;}
function request(body:Record<string,unknown>={}){return handler(new Request('https://test.invalid/context',{method:'POST',headers:{Authorization:'Bearer fake','Content-Type':'application/json'},body:JSON.stringify({action:'chat_visibility',actorId:'actor',endpoint:'https://push.invalid/own',pageId:'page-one',conversationId,...body})}));}
function assert(value:unknown){if(!value)throw Error('Context invariant failed');}
Deno.test('foreground context is scoped to the authenticated device and preserves push keys',async()=>{const s=reset();const r=await request();assert(r.status===200 && s.writes===1);assert(s.device.subscription.keys.auth==='fake');const lease=s.device.subscription.waseet_chat_visibility;assert(lease.conversation_id===conversationId && lease.expires_at>Date.now() && lease.expires_at<=Date.now()+12000);});
Deno.test('foreign endpoint cannot be changed',async()=>{const s=reset();const r=await request({endpoint:'https://push.invalid/another'});assert(r.status===200 && s.writes===0);});
Deno.test('non-member cannot advertise a conversation',async()=>{const s=reset();s.member=false;const r=await request();assert(r.status===403 && s.writes===0);});
Deno.test('background tab cannot clear another page lease',async()=>{const s=reset();await request();await request({conversationId:null,pageId:'other-page'});assert(s.writes===1 && s.device.subscription.waseet_chat_visibility.conversation_id===conversationId);await request({conversationId:null});assert(s.writes===2 && s.device.subscription.waseet_chat_visibility.expires_at===0);});
Deno.test('unauthenticated requests never change subscriptions',async()=>{const s=reset();s.unauthorized=true;const r=await request();assert(r.status===401 && s.writes===0);});

Deno.test('an old account request cannot use a new account token',async()=>{const s=reset();const r=await request({actorId:'old-account'});assert(r.status===403 && s.writes===0);});
