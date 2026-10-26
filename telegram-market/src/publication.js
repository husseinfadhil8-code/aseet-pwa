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
function caption(ad){const full=ad.title+'\n'+Number(ad.price).toLocaleString('ar-IQ')+' د.ع\n'+ad.area+'\n'+ad.description;let result='';for(const c of full){if(result.length+c.length>900)break;result+=c}return result}
export async function dispatchPublication(env,act,id){
 const settings=await act('settings');if(!settings.channel_verified||!settings.channel)throw new SafeError('channel_not_configured',503);
 const target=await validateChannel(env,settings.channel);
 const claim=await act('publication_claim',{id});if(!claim.dispatch)return {state:claim.state,already_processed:true};
 const ad=claim.listing,markup={inline_keyboard:[[{text:'عرض الإعلان في سوق وسيط',url:MARKET_LINK+'?startapp=ad_'+ad.id}]]};
 try{
  let sent;
  if(ad.images?.length){
   const image=await rpc(env,'tg_market_media',{p_image:ad.images[0],p_actor:0});if(!image)throw new SafeError('publication_image_unavailable',409);
   const r=await fetch(supabase(env)+'/storage/v1/object/authenticated/waseet-telegram-images/'+image.path,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY},signal:AbortSignal.timeout(8000)});if(!r.ok)throw new SafeError('publication_image_unavailable',409);
   const blob=await r.blob();if(blob.size>5242880)throw new SafeError('image_too_large',413);
   const form=new FormData();form.set('chat_id',claim.channel);form.set('photo',blob,'waseet-listing.jpg');form.set('caption',caption(ad));form.set('reply_markup',JSON.stringify(markup));sent=await telegramUpload(env,'sendPhoto',form);
  }else sent=await telegram(env,'sendMessage',{chat_id:claim.channel,text:caption(ad),reply_markup:markup});
  try{await act('publication_finish',{id,state:'sent',message:sent.message_id})}catch{await act('publication_finish',{id,state:'sent',message:sent.message_id})}return {state:'sent',message_id:sent.message_id,message_link:publicationLink(target.channel,target.username,sent.message_id)};
 }catch{
  await act('publication_finish',{id,state:'review'});throw new SafeError('channel_publication_needs_review',409);
 }
}

export function publicationLink(channel,username,message){return username?'https://t.me/'+username+'/'+message:'https://t.me/c/'+String(channel).replace(/^-100/,'')+'/'+message}
