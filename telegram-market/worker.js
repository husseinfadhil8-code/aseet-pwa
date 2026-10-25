// Cloudflare Worker — Telegram webhook, no secrets in source control.
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
async function telegram(env,method,payload){const res=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});if(!res.ok)throw new Error("Telegram API error "+res.status);return res.json()}
const utf8=s=>new TextEncoder().encode(s);
const hex=buffer=>[...new Uint8Array(buffer)].map(n=>n.toString(16).padStart(2,"0")).join("");
async function verifyTelegramInit(raw,token){
  if(!raw || raw.length>8192 || !token)return null;
  const p=new URLSearchParams(raw),provided=p.get("hash"),auth=Number(p.get("auth_date"));
  if(!provided || !/^[a-f0-9]{64}$/i.test(provided)|| !auth || Math.abs(Date.now()/1000-auth)>86400)return null;
  const check=[...p.entries()].filter(([k])=>k!=="hash"&&k!=="signature").sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+"="+v).join("\n");
  const key=await crypto.subtle.importKey("raw",utf8("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const secret=await crypto.subtle.sign("HMAC",key,utf8(token));
  const derived=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const actual=hex(await crypto.subtle.sign("HMAC",derived,utf8(check)));
  let diff=0;for(let i=0;i<64;i++)diff|=actual.charCodeAt(i)^provided.toLowerCase().charCodeAt(i);
  if(diff)return null;
  try{const user=JSON.parse(p.get("user")||"null");return user && Number.isSafeInteger(user.id)?{id:user.id,first_name:user.first_name||"",username:user.username||""}:null}catch{return null}
}
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==="/health"&&request.method==="GET")return json({ok:true,service:"waseet-telegram"});
  if(url.pathname==="/api/me"&&request.method==="POST"){
   const body=await request.json().catch(()=>({}));
   const user=await verifyTelegramInit(body.initData,env.TELEGRAM_BOT_TOKEN);
   return user?json({ok:true,user}):json({ok:false,error:"Invalid Telegram session"},401);
  }
  if(url.pathname==="/webhook"&&request.method==="POST"){
   if(!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==env.TELEGRAM_WEBHOOK_SECRET)return json({error:"Unauthorized"},401);
   const update=await request.json().catch(()=>({}));
   const chatId=update.message?.chat?.id, text=update.message?.text||"";
   if(chatId && (text.startsWith("/start") || text.startsWith("/market"))){
    const button=env.MINI_APP_URL?{text:"🛍 افتح سوق وسيط",web_app:{url:env.MINI_APP_URL}}:{text:"سوق وسيط",url:"https://github.com/husseinfadhil8-code/aseet-pwa"};
    await telegram(env,"sendMessage",{chat_id:chatId,text:"أهلاً بيك في وسيط 🛍\nسوق للبيع والشراء داخل تلغرام. اضغط الزر لفتح السوق.",reply_markup:{inline_keyboard:[[button]]}});
   }
   return json({ok:true});
  }
  return json({error:"Not found"},404);
 }
};
