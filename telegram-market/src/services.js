export class SafeError extends Error{constructor(code,status=400){super(code);this.status=status}}
export async function boundedJSON(request,max=32768){
 const reader=request.body?.getReader();if(!reader)return {};
 let size=0,chunks=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw new SafeError('request_too_large',413);chunks.push(value)}}finally{await reader.cancel().catch(()=>{})}
 const bytes=new Uint8Array(size);let offset=0;for(const x of chunks){bytes.set(x,offset);offset+=x.length}
 try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new SafeError('invalid_json')}
}
export function supabase(env){let u;try{u=new URL(env.SUPABASE_URL)}catch{throw new SafeError('database_not_configured',503)}if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co')||u.username||u.password||!env.SUPABASE_SERVICE_ROLE_KEY)throw new SafeError('database_not_configured',503);return u.origin}
export async function rpc(env,name,args,timeout=8000){
 const res=await fetch(supabase(env)+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(timeout)});
 if(!res.ok){const problem=await res.json().catch(()=>({}));const codes={'payment test required':'payment_test_required','package version conflict':'package_version_conflict','existing campaign differs':'existing_campaign_differs','approved listing and channel required':'listing_approval_required','repost cooldown':'repost_cooldown','owner required':'owner_required'};if(codes[problem.message])throw new SafeError(codes[problem.message],409);if(res.status===401)throw new SafeError('database_credentials_rejected',503);if(res.status===404)throw new SafeError('database_schema_not_ready',503);throw new SafeError(res.status>=500?'database_unavailable':'action_denied',res.status>=500?503:403)}return res.json()
}
export async function telegram(env,method,payload,timeout=8000){
 if(!env.TELEGRAM_BOT_TOKEN)throw new SafeError('bot_not_configured',503);
 // Never log request URL/errors: the Bot API URL contains the token.
 const res=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout)});
 const data=await res.json().catch(()=>({}));if(!res.ok||!data.ok){
  if(res.status===401||data.error_code===401)throw new SafeError('telegram_token_rejected',502);
  if(['getChat','getChatMember'].includes(method)){const reason=String(data.description||'').toLowerCase();if(reason.includes('chat not found'))throw new SafeError('channel_unreachable',403);if(reason.includes('not a member')||reason.includes('kicked'))throw new SafeError('channel_bot_not_member',403);if(reason.includes('not enough rights')||reason.includes('chat_admin_required'))throw new SafeError('channel_permission_required',403)}
  throw new SafeError('telegram_unavailable',502);
 }return data.result
}
export const admin=(env,id)=>{const value=String(env.OWNER_TELEGRAM_ID||env.ADMIN_TELEGRAM_IDS||'').trim();return /^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value))&&value===String(id)};
export async function telegramUpload(env,method,body,timeout=8000){
 if(!env.TELEGRAM_BOT_TOKEN)throw new SafeError('bot_not_configured',503);
 const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',body,signal:AbortSignal.timeout(15000)});const d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw new SafeError('telegram_unavailable',502);return d.result;
}

export function clipText(value,max){let result='';for(const c of String(value||'')){if(result.length+c.length>max)break;result+=c}return result}
