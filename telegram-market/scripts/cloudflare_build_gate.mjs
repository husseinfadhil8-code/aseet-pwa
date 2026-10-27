// Native Cloudflare Git builds keep deployment credentials in Cloudflare.
// Fail closed until this exact commit passes the GitHub PostgreSQL/browser job.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const API='https://api.github.com/repos/husseinfadhil8-code/aseet-pwa';
export function verifiedRun(runs,sha){return runs.find(r=>r.head_sha===sha&&['feature/telegram-market-starter','feature/telegram-wanted-radar'].includes(r.head_branch)&&r.head_repository?.full_name==='husseinfadhil8-code/aseet-pwa'&&r.event==='push'&&r.path==='.github/workflows/telegram-market.yml'&&r.status==='completed'&&r.conclusion==='success')}
export function validSchemaProof(proof,digest){return proof?.test_ref==='beyrctbxojpuvhevfyok'&&proof.test_phase3_installed===true&&proof.production_changed===false&&proof.sql_sha256===digest}
export function validNotificationProof(proof,digest){return proof?.test_ref==='beyrctbxojpuvhevfyok'&&proof.test_phase4_installed===true&&proof.production_changed===false&&proof.sql_sha256===digest}
export function validWantedProof(proof,digest){return proof?.test_ref==='beyrctbxojpuvhevfyok'&&proof.test_phase5_installed===true&&proof.production_changed===false&&proof.sql_sha256===digest}
async function get(path){const r=await fetch(API+path,{headers:{Accept:'application/vnd.github+json','User-Agent':'WaseetCloudflareBuildGate'},signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('GitHub verification unavailable: HTTP '+r.status);return r.json()}
export async function main(){
 const sql=readFileSync(new URL('../db/003_admin_settings.sql',import.meta.url)),digest=createHash('sha256').update(sql).digest('hex');let proof;try{proof=JSON.parse(readFileSync(new URL('../evidence/phase3-install.json',import.meta.url),'utf8'))}catch{throw Error('Verified Test schema installation proof required before deployment')}if(!validSchemaProof(proof,digest))throw Error('Schema proof does not match the current migration');
 const notificationDigest=createHash('sha256').update(readFileSync(new URL('../db/004_notifications.sql',import.meta.url))).digest('hex');let notificationProof;try{notificationProof=JSON.parse(readFileSync(new URL('../evidence/phase4-install.json',import.meta.url),'utf8'))}catch{throw Error('Verified notification schema installation proof required')}if(!validNotificationProof(notificationProof,notificationDigest))throw Error('Notification schema proof mismatch');
 const wantedDigest=createHash('sha256').update(readFileSync(new URL('../db/005_wanted_radar.sql',import.meta.url))).digest('hex');let wantedProof;try{wantedProof=JSON.parse(readFileSync(new URL('../evidence/phase5-install.json',import.meta.url),'utf8'))}catch{throw Error('Verified wanted/radar schema installation proof required')}if(!validWantedProof(wantedProof,wantedDigest))throw Error('Wanted/radar schema proof mismatch');
 const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Invalid source revision');
 for(let attempt=0;attempt<24;attempt++){
  const data=await get('/actions/workflows/telegram-market.yml/runs?head_sha='+sha+'&per_page=20'),run=verifiedRun(data.workflow_runs||[],sha);
  if(run){const jobs=await get('/actions/runs/'+run.id+'/jobs');if(!jobs.jobs?.some(j=>j.name==='test'&&j.conclusion==='success'))throw Error('Required test job did not pass');console.log('Verified PostgreSQL and browser checks for '+sha);return}
  console.log('Waiting for exact-commit GitHub tests ('+(attempt+1)+'/24)');await new Promise(r=>setTimeout(r,15000));
 }
 throw Error('No passing exact-commit checks within six minutes; deployment blocked');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1});
