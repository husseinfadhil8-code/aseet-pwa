export class SafeError extends Error{constructor(code,status=400){super(code);this.status=status}}
export async function boundedJSON(request,max=32768){
 const reader=request.body?.getReader();if(!reader)return {};
 let size=0,chunks=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw new SafeError('request_too_large',413);chunks.push(value)}}finally{await reader.cancel().catch(()=>{})}
 const bytes=new Uint8Array(size);let offset=0;for(const x of chunks){bytes.set(x,offset);offset+=x.length}
 try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new SafeError('invalid_json')}
}
export function supabase(env){let u;try{u=new URL(env.SUPABASE_URL)}catch{throw new SafeError('database_not_configured',503)}if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co')||u.username||u.password||!env.SUPABASE_SERVICE_ROLE_KEY)throw new SafeError('database_not_configured',503);return u.origin}
export async function rpc(env,name,args){
 const res=await fetch(supabase(env)+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(8000)});
 if(!res.ok){await res.body?.cancel();throw new SafeError(res.status>=500?'database_unavailable':'action_denied',res.status>=500?503:403)}return res.json()
}
export async function telegram(env,method,payload){
 if(!env.TELEGRAM_BOT_TOKEN)throw new SafeError('bot_not_configured',503);
 // Never log request URL/errors: the Bot API URL contains the token.
 const res=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
 const data=await res.json().catch(()=>({}));if(!res.ok||!data.ok)throw new SafeError('telegram_unavailable',502);return data.result
}
export const admin=(env,id)=>String(env.ADMIN_TELEGRAM_IDS||'').split(',').map(s=>s.trim()).filter(s=>/^\d+$/.test(s)).includes(String(id));
export function stars(env){const n=Number(env.PROMOTION_STARS);return Number.isSafeInteger(n)&&n>0&&n<=100000?n:0}
