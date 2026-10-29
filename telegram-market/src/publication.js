import {budgetFetch,requireRequests,remainingRequests} from './notification-budget.js';
import {publicationPlan} from './publication-content.js';
import {rpc,telegram,telegramUpload,SafeError,supabase} from './services.js';
import {MARKET_LINK} from '../miniapp/links.js';
export function normalizeChannel(value){let text=String(value).replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,'').replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/[−﹣－]/g,'-').trim();if(/^-100[\d\s]+$/.test(text))text=text.replace(/\s/g,'');return text}
export async function validateChannel(env,channel){
 channel=normalizeChannel(channel);
 if(!/^(@[A-Za-z][A-Za-z0-9_]{4,}|-100[0-9]+)$/.test(channel))throw new SafeError('invalid_channel');
 const bot=await telegram(env,'getMe',{}),chat=await telegram(env,'getChat',{chat_id:channel}),member=chat.type==='channel'?await telegram(env,'getChatMember',{chat_id:chat.id,user_id:bot.id}):null;
 if(chat.type!=='channel')throw new SafeError('channel_type_required',403);
 if(!['administrator','creator'].includes(member.status)||(member.status!=='creator'&&member.can_post_messages!==true))throw new SafeError('channel_permission_required',403);
 return {channel:String(chat.id),title:String(chat.title||'قناة وسيط'),username:typeof chat.username==='string'&&/^[A-Za-z][A-Za-z0-9_]{4,}$/.test(chat.username)?chat.username:null};
}
export async function dispatchPublication(env,act,id){
 const deadline=Date.now()+55000,remaining=()=>{const n=deadline-Date.now();if(n<1000)throw new SafeError('channel_publication_needs_review',409);return Math.min(8000,n)};
 const settings=await act('settings');if(!settings.channel_verified||!settings.channel)throw new SafeError('channel_not_configured',503);
 const target=await validateChannel(env,settings.channel);
 const claim=await act('publication_claim',{id});if(!claim.dispatch)return {state:claim.state,already_processed:true};
 let nextSend=0;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function send(run){const wait=Math.max(0,nextSend-Date.now());if(wait){if(Date.now()+wait>=deadline-1000)throw new SafeError('channel_publication_needs_review',409);await pause(wait)}try{return await run()}catch(error){const retry=Number(error.retryAfter);if(error.message!=='telegram_rate_limited'||!Number.isFinite(retry)||retry>8||Date.now()+retry*1000>=deadline-1000)throw error;await pause(retry*1000);return await run()}finally{nextSend=Date.now()+1100}}
 const ad=claim.listing,plan=publicationPlan(ad),markup={inline_keyboard:[[{text:'عرض الإعلان في وسيط',url:MARKET_LINK+'?startapp=ad_'+ad.id}]]};
 try{
  // Fetch every photo before sending anything: a missing later photo must not leave a partial album.
  const images=[];for(const imageId of plan.photos){const image=await rpc(env,'tg_market_media',{p_image:imageId,p_actor:0},remaining());if(!image)throw new SafeError('publication_image_unavailable',409);const r=await budgetFetch(env,supabase(env)+'/storage/v1/object/authenticated/waseet-telegram-images/'+image.path,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY},signal:AbortSignal.timeout(remaining())});if(!r.ok)throw new SafeError('publication_image_unavailable',409);const blob=await r.blob();if(blob.size>5242880)throw new SafeError('image_too_large',413);images.push(blob)}
  async function ensureCurrent(){const current=await rpc(env,'tg_market_listing',{p_id:ad.id},remaining());if(!current||current.status!=='active'||current.approved_at!==ad.approved_at)throw new SafeError('listing_approval_required',409);const url=new URL(supabase(env)+'/rest/v1/tg_market_reports');url.search=new URLSearchParams({select:'id',listing_id:'eq.'+ad.id,status:'eq.open',limit:'1'});const r=await budgetFetch(env,url,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY},signal:AbortSignal.timeout(remaining())});if(!r.ok)throw new SafeError('database_unavailable',503);const reports=await r.json();if(!Array.isArray(reports)||reports.length)throw new SafeError('listing_approval_required',409)}
  let sent,anchor=null;const messageIds=[];
  if(plan.album){const form=new FormData();form.set('chat_id',claim.channel);const media=images.map((blob,i)=>{form.set('photo'+i,blob,'waseet-'+i+'.jpg');return {type:'photo',media:'attach://photo'+i,...(i===0?{caption:plan.caption}:{})}});form.set('media',JSON.stringify(media));const album=await send(async()=>{await ensureCurrent();return telegramUpload(env,'sendMediaGroup',form,remaining())});if(!Array.isArray(album)||album.length!==images.length||album.some(m=>!Number.isSafeInteger(m.message_id)||m.message_id<=0))throw Error('Uncertain album response');messageIds.push(...album.map(m=>m.message_id));anchor=album[0].message_id;sent=album.at(-1)}
  else if(images.length){const form=new FormData();form.set('chat_id',claim.channel);form.set('photo',images[0],'waseet-listing.jpg');form.set('caption',plan.caption);if(!plan.details.length)form.set('reply_markup',JSON.stringify(markup));sent=await send(async()=>{await ensureCurrent();return telegramUpload(env,'sendPhoto',form,remaining())});if(!Number.isSafeInteger(sent?.message_id)||sent.message_id<=0)throw Error('Uncertain photo response');messageIds.push(sent.message_id);anchor=sent.message_id}
  for(const text of plan.details){sent=await send(async()=>{await ensureCurrent();return telegram(env,'sendMessage',{chat_id:claim.channel,text,link_preview_options:{is_disabled:true},reply_markup:markup,...(anchor?{reply_parameters:{message_id:anchor,allow_sending_without_reply:false}}:{})},remaining())});if(!Number.isSafeInteger(sent?.message_id)||sent.message_id<=0)throw Error('Uncertain text response');messageIds.push(sent.message_id);anchor??=sent.message_id}
  if(!sent?.message_id)throw Error('Uncertain publication response');
  try{await act('publication_finish',{id,state:'sent',message:sent.message_id})}catch{await act('publication_finish',{id,state:'sent',message:sent.message_id})}return {state:'sent',message_id:sent.message_id,message_ids:messageIds,message_link:publicationLink(target.channel,target.username,sent.message_id)};
 }catch{
  await act('publication_finish',{id,state:'review'});throw new SafeError('channel_publication_needs_review',409);
 }
}

export function publicationLink(channel,username,message){return username?'https://t.me/'+username+'/'+message:'https://t.me/c/'+String(channel).replace(/^-100/,'')+'/'+message}
