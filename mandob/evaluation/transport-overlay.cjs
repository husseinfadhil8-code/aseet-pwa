// Local diagnostic overlay for Wrangler 4.166.0 only. Never edits the original SDK.
// Use the existing EnvHttpProxyAgent and trusted CA configuration. Never disable TLS.
function patchRemoteProxySource(source,version){
 if(version!=='4.166.0')throw Error('unreviewed_wrangler_version');
 const region=source.indexOf('var init_dist$1 =');
 const marker='\t\t\t\t\tname: "ProxyWorker",';const index=source.indexOf(marker,region);
 if(region<0||index<region)throw Error('remote_proxy_patch_target_missing');
 return source.slice(0,index)+'\t\t\t\t\toutboundService: globalThis.__mandobNetworkFetch,\n'+source.slice(index);
}
function createTransport({fetch,dispatcher,Response,record}){
 return async request=>{
  const url=new URL(request.url);
  if(url.protocol!=='https:'||!url.hostname.endsWith('.workers.dev')||url.username||url.password)throw Error('unexpected_proxy_host');
  try{
   const result=await fetch(request.url,{method:request.method,headers:request.headers,...(!['GET','HEAD'].includes(request.method)&&request.body?{body:await request.arrayBuffer()}:{}),dispatcher,redirect:'manual',signal:AbortSignal.timeout(30000)});
   record({phase:'remote_preview_transport',method:request.method,status:result.status,cf_ray:result.headers.get('cf-ray'),access_redirect:(result.headers.get('location')||'').includes('.cloudflareaccess.com')});
   return new Response(result.body,{status:result.status,headers:result.headers});
  }catch(error){record({phase:'remote_preview_transport',error:error.name,cause_code:error.cause?.code||null});throw error;}
 };
}
module.exports={patchRemoteProxySource,createTransport};
