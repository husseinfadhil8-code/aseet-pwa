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
 if(!res.ok){await res.body?.cancel();if(res.status===401)throw new SafeError('database_credentials_rejected',503);if(res.status===404)throw new SafeError('database_schema_not_ready',503);throw new SafeError(res.status>=500?'database_unavailable':'action_denied',res.status>=500?503:403)}return res.json()
}
export async function telegram(env,method,payload,timeout=8000){
 if(!env.TELEGRAM_BOT_TOKEN)throw new SafeError('bot_not_configured',503);
 // Never log request URL/errors: the Bot API URL contains the token.
 const res=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout)});
 const data=await res.json().catch(()=>({}));if(!res.ok||!data.ok)throw new SafeError((res.status===401||data.error_code===401)?'telegram_token_rejected':'telegram_unavailable',502);return data.result
}
export const admin=(env,id)=>{const value=String(env.OWNER_TELEGRAM_ID||env.ADMIN_TELEGRAM_IDS||'').trim();return /^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value))&&value===String(id)};
export function stars(env){const n=Number(env.PROMOTION_STARS);return Number.isSafeInteger(n)&&n>0&&n<=100000?n:0}

export function promotionOffers(env){
 const offers=[];if(stars(env))offers.push({id:'standard',days:7,stars:stars(env)});
 let packages;try{packages=JSON.parse(env.PROMOTION_PACKAGES_JSON||'[]')}catch{return offers}
 if(!Array.isArray(packages)||packages.length>3)return offers;
 const seen=new Set();for(const p of packages){if(!p||![1,14,30].includes(p.days)||!Number.isSafeInteger(p.stars)||p.stars<1||p.stars>100000||seen.has(p.days))return offers;seen.add(p.days)}
 return offers.concat(packages.map(p=>({id:'days_'+p.days,days:p.days,stars:p.stars})));
}
