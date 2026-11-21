// Local-only configuration renderer: never creates resources, deploys or executes SQL.
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const protectedIds = new Set(['07dc23a5-2b16-46e3-ab3a-180fc1fddf79','8e9d67f8-b043-4868-8cc1-b10a5749f115']);
export function configFor(database, pageId, graphVersion, planEvidence) {
 if(planEvidence?.plan!=='free'||planEvidence?.verified!==true)throw new Error('Verified Workers Free subscription is required; billing status unknown or paid is blocked');
 if(database?.name!=='mandob-baghdad-db'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(database.uuid||'')||protectedIds.has(database.uuid))throw new Error('Expected verified, independent Mandob database metadata');
 if(!/^\d{1,40}$/.test(pageId||'')||!/^v\d+\.\d+$/.test(graphVersion||''))throw new Error('Authorized public Page ID and reviewed Graph version are required');
 return {name:'mandob-baghdad-api',main:'../src/worker.mjs',compatibility_date:'2026-11-20',workers_dev:true,assets:{directory:'../public',binding:'ASSETS',run_worker_first:true},vars:{FREE_ONLY:'true',ADMIN_AUTH_MODE:'passkey',ALLOW_MESSENGER_INTAKE:'false',AI_DAILY_NEURON_RESERVE_LIMIT:'0',TEXT_MODEL:'@cf/google/gemma-4-26b-a4b-it',PAGE_ID:pageId,GRAPH_VERSION:graphVersion,ALLOW_SEND:'false',ALLOW_ALERT_SEND:'false',ALLOW_AI:'false',ALLOW_MEDIA:'false',AI_DAILY_CALL_LIMIT:'0'},d1_databases:[{binding:'DB',database_name:'mandob-baghdad-db',database_id:database.uuid,migrations_dir:'../migrations'}],ai:{binding:'AI'},triggers:{crons:[]},observability:{enabled:false}};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const [metadataPath,pageId,version,output]=process.argv.slice(2);if(!output)throw new Error('Missing local output file');
 await writeFile(output,JSON.stringify(configFor(JSON.parse(readFileSync(metadataPath,'utf8')).database,pageId,version,JSON.parse(readFileSync(metadataPath,'utf8')).subscription),null,2)+'\n',{mode:0o600});
}
