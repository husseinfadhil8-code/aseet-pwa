import {rpc,admin,SafeError} from './services.js';
const operations=new Set(['inbox','admin','create','reply']);
export async function supportAction(env,user,operation,data={}){
 if(!operations.has(operation))throw new SafeError('not_found',404);
 if(['admin','reply'].includes(operation)&&!admin(env,user.id))throw new SafeError('owner_required',403);
 return rpc(env,'tg_market_support_action',{p_actor:user.id,p_operation:operation,p_data:data,p_admin:admin(env,user.id),p_name:user.name||'مستخدم'});
}
