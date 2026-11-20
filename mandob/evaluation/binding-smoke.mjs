// Isolated AI-binding harness. Fixed synthetic cases only; no DB, Messenger or REST client.
import {cases} from './cases.mjs';
import {analysisInput,textOutput,usageOf} from '../src/text-models.mjs';
export const SMOKE_MODEL='@cf/google/gemma-4-26b-a4b-it';
const allowed=['missing-fields','carry-context','financial-handoff'];
export default {async fetch(request,env){
 const url=new URL(request.url);
 const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
 if(url.hostname!=='127.0.0.1'&&url.hostname!=='localhost')return response({error:'loopback_only'},403);
 if(request.method==='GET')return response({mode:'isolated_binding_test',enabled:env.BINDING_SMOKE_ENABLED==='true',model:SMOKE_MODEL,synthetic_cases:allowed,customer_data:false});
 if(request.method!=='POST')return response({error:'method_not_allowed'},405);
 if(env.BINDING_SMOKE_ENABLED!=='true')return response({error:'live_binding_test_disabled'},503);
 if(!env.AI?.run)return response({error:'ai_binding_missing'},503);
 const c=cases.find(c=>c.id===url.searchParams.get('case')&&allowed.includes(c.id));
 if(!c)return response({error:'synthetic_case_required'},400);
 const input={...analysisInput(c.history,c.text),max_tokens:256};
 try{const output=await env.AI.run(SMOKE_MODEL,input);return response({model:SMOKE_MODEL,case:c.id,synthetic_data:true,output:textOutput(output),usage:usageOf(output,SMOKE_MODEL),quality_verified:false});}
 catch{return response({error:'binding_inference_failed',fallback_used:false},502);}
}};
