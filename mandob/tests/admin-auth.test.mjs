import test from 'node:test';import assert from 'node:assert/strict';
import {authenticateAdmin} from '../src/admin-auth.mjs';
import {fixture,req} from './helpers.mjs';import worker from '../src/worker.mjs';import {aiCall} from '../src/ai.mjs';
const b64=x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64url');
test('Access verifies signature, exact audience/issuer/admin and expiry; spoofed headers and bearer bypass fail',async()=>{
 const key=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',key.publicKey);jwk.kid='test';
 const env={ADMIN_AUTH_MODE:'access',ACCESS_ISSUER:'https://test.cloudflareaccess.com',ACCESS_AUD:'test-aud',ACCESS_ADMIN_EMAILS:'admin@example.invalid'};
 const claims={iss:env.ACCESS_ISSUER,aud:['test-aud'],sub:'admin-test',email:'admin@example.invalid',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300};
 const token=async c=>{const p=b64({alg:'RS256',kid:'test'})+'.'+b64(c);return p+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key.privateKey,new TextEncoder().encode(p))).toString('base64url');};
 const fetcher=async url=>{assert.equal(url,env.ACCESS_ISSUER+'/cdn-cgi/access/certs');return Response.json({keys:[jwk]});};
 const check=async c=>authenticateAdmin(new Request('https://mandob.test',{headers:{'cf-access-jwt-assertion':await token(c)}}),env,fetcher);
 assert.equal((await check(claims)).mode,'access');
 for(const change of [{aud:['wrong']},{iss:'https://evil.invalid'},{exp:0},{email:'buyer@example.invalid'}])await assert.rejects(()=>check({...claims,...change}));
 await assert.rejects(()=>authenticateAdmin(new Request('https://mandob.test',{headers:{'cf-access-authenticated-user-email':claims.email,Authorization:'Bearer '+ 'x'.repeat(40)}}),env,fetcher));
 const forged=(await token(claims)).split('.');forged[1]=b64({...claims,sub:'forged'});await assert.rejects(()=>authenticateAdmin(new Request('https://mandob.test',{headers:{'cf-access-jwt-assertion':forged.join('.')}}),env,fetcher));
});
test('Free profile locks entire admin site without Access; Messenger intake explicitly off',async()=>{const {env}=fixture();env.FREE_ONLY='true';for(const path of ['/','/admin.js','/api/items'])assert.equal((await worker.fetch(req(env,path),env)).status,503);env.ALLOW_MESSENGER_INTAKE='false';assert.equal((await worker.fetch(new Request('https://mandob.test/webhooks/meta/messenger'),env)).status,503);});
test('Free AI reserves budget atomically, stops at cap and never retries; unsupported models fail closed',async()=>{const {env,sql}=fixture();sql.exec("INSERT INTO settings(page_id,ai) VALUES('111',1)");Object.assign(env,{FREE_ONLY:'true',ALLOW_AI:'true',AI_DAILY_CALL_LIMIT:'4',AI_DAILY_NEURON_RESERVE_LIMIT:'512'});let calls=0;env.AI={async run(){calls++;return {response:'ok'};}};const input={messages:[{role:'user',content:'test'}],max_completion_tokens:32,chat_template_kwargs:{enable_thinking:false}};await aiCall(env,'@cf/google/gemma-4-26b-a4b-it',input);await assert.rejects(()=>aiCall(env,'@cf/google/gemma-4-26b-a4b-it',input),/ai_neuron_reserve_limit/);assert.equal(calls,1);await assert.rejects(()=>aiCall(env,'other',input),/ai_free_input_restricted/);});
