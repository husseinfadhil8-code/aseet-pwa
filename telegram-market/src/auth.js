const enc=new TextEncoder();
const hmac=async(key,text)=>crypto.subtle.sign('HMAC',await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']),enc.encode(text));
export function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0}
export async function verifyInitData(raw,token,now=Date.now()){
 if(typeof raw!=='string'||raw.length>8192||!token)return null;
 const p=new URLSearchParams(raw),keys=[...p.keys()];if(new Set(keys).size!==keys.length)return null;
 const hash=p.get('hash'),date=Number(p.get('auth_date'));
 if(!/^[a-f0-9]{64}$/.test(hash||'')||!Number.isSafeInteger(date)||date<now/1000-3600||date>now/1000+30)return null;
 // HMAC validation includes every received field except hash, including signature.
 const data=[...p].filter(([k])=>k!=='hash').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
 const secret=await hmac(enc.encode('WebAppData'),token),signed=await hmac(secret,data);
 const actual=[...new Uint8Array(signed)].map(b=>b.toString(16).padStart(2,'0')).join('');if(!equal(actual,hash))return null;
 try{const user=JSON.parse(p.get('user'));return Number.isSafeInteger(user?.id)&&user.id>0?{id:user.id,name:Array.from(String(user.first_name||'مستخدم')).slice(0,80).join('')}:null}catch{return null}
}
