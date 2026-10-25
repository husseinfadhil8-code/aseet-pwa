export function createClient(_url: string, key: string, _options?: unknown): any {
  const state = (globalThis as any).pushTestState;
  return {
    auth: {getUser: async()=>state.unauthorized?{error:true}:{data:{user:{id:'actor'}}}},
    from(table: string){
      const filters: Record<string,unknown>={};let changes: any=null;
      const query: any={select:()=>query,eq:(k:string,v:unknown)=>{filters[k]=v;return query;},update:(v:unknown)=>{changes=v;return query;},maybeSingle:()=>query,
        then(resolve:any,reject:any){
          try {
            if(table==='profiles')return Promise.resolve({data:{id:'actor',role:'rep',status:'approved'}}).then(resolve,reject);
            if(table==='chat_members')return Promise.resolve({data:state.member?{conversation_id:filters.conversation_id}:null}).then(resolve,reject);
            if(table!=='push_subscriptions' || key!=='service')throw Error('Unexpected access');
            const match=state.device && filters.user_id==='actor' && (!filters.endpoint || filters.endpoint===state.device.endpoint) && (!filters.id || filters.id===state.device.id);
            if(changes){
              if(match && (!filters['subscription->waseet_chat_visibility->>page_id'] || filters['subscription->waseet_chat_visibility->>page_id']===state.device.subscription.waseet_chat_visibility?.page_id)){state.device.subscription=changes.subscription;state.writes++;}
              return Promise.resolve({error:null}).then(resolve,reject);
            }
            return Promise.resolve({data:match?structuredClone(state.device):null}).then(resolve,reject);
          }catch(error){return Promise.reject(error).then(resolve,reject);}
        }};return query;
    }
  };
}
