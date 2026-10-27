import {rpc,admin,SafeError} from './services.js';
export const wantedOperations=new Set(['mine','save','close','delete','renew','review','offer','offers','contact','report','radars','radar_save','radar_delete','matches','admin','report_close','admin_offers']);
export async function wantedAction(env,user,operation,data={}){
 if(!wantedOperations.has(operation))throw new SafeError('not_found',404);
 if(['review','admin','report_close','admin_offers'].includes(operation)&&!admin(env,user.id))throw new SafeError('owner_required',403);
 const result=await rpc(env,'tg_market_wanted_action',{p_actor:user.id,p_operation:operation,p_data:data,p_admin:admin(env,user.id),p_name:user.name||'مستخدم'});
 // Immediate bounded initial search, completed by Cron. No Telegram send on save.
 if(operation==='radar_save'){try{await rpc(env,'tg_market_radar_scan',{p_radar:result.id})}catch{return {...result,initial_scan_pending:true}}}
 return result;
}
export async function wantedPublic(env,url){
 const data={};for(const key of ['q','category','governorate','budget','offset'])if(url.searchParams.has(key))data[key]=url.searchParams.get(key).slice(0,120);
 return rpc(env,'tg_market_wanted_public',{p_data:data});
}
