import {rpc,telegram,telegramUpload,SafeError,supabase} from './services.js';
import {MARKET_LINK} from '../miniapp/links.js';
export async function validateChannel(env,channel){
 if(!/^(@[A-Za-z][A-Za-z0-9_]{4,}|-100[0-9]+)$/.test(channel))throw new SafeError('invalid_channel');
 const bot=await telegram(env,'getMe',{}),chat=await telegram(env,'getChat',{chat_id:channel}),member=await telegram(env,'getChatMember',{chat_id:chat.id,user_id:bot.id});
 if(chat.type!=='channel'||!['administrator','creator'].includes(member.status)||(member.status!=='creator'&&member.can_post_messages!==true))throw new SafeError('channel_permission_required',403);
 return {channel:String(chat.id),title:String(chat.title||'قناة وسيط')};
}
function caption(ad){const full=ad.title+'\n'+Number(ad.price).toLocaleString('ar-IQ')+' د.ع\n'+ad.area+'\n'+ad.description;let result='';for(const c of full){if(result.length+c.length>900)break;result+=c}return result}
export async function dispatchPublication(env,act,id){
 const settings=await act('settings');if(!settings.channel_verified||!settings.channel)throw new SafeError('channel_not_configured',503);
 await validateChannel(env,settings.channel);
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
  await act('publication_finish',{id,state:'sent',message:sent.message_id});return {state:'sent'};
 }catch{
  await act('publication_finish',{id,state:'review'});throw new SafeError('channel_publication_needs_review',409);
 }
}
