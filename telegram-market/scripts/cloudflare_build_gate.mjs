// Native Cloudflare Git builds keep deployment credentials in Cloudflare.
// Fail closed until this exact commit passes the GitHub PostgreSQL/browser job.
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const API='https://api.github.com/repos/husseinfadhil8-code/aseet-pwa';
export function verifiedRun(runs,sha){return runs.find(r=>r.head_sha===sha&&r.head_branch==='feature/telegram-market-starter'&&r.head_repository?.full_name==='husseinfadhil8-code/aseet-pwa'&&r.event==='push'&&r.path==='.github/workflows/telegram-market.yml'&&r.status==='completed'&&r.conclusion==='success')}
async function get(path){const r=await fetch(API+path,{headers:{Accept:'application/vnd.github+json','User-Agent':'WaseetCloudflareBuildGate'},signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('GitHub verification unavailable: HTTP '+r.status);return r.json()}
export async function main(){
 const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Invalid source revision');
 for(let attempt=0;attempt<24;attempt++){
  const data=await get('/actions/workflows/telegram-market.yml/runs?head_sha='+sha+'&per_page=20'),run=verifiedRun(data.workflow_runs||[],sha);
  if(run){const jobs=await get('/actions/runs/'+run.id+'/jobs');if(!jobs.jobs?.some(j=>j.name==='test'&&j.conclusion==='success'))throw Error('Required test job did not pass');console.log('Verified PostgreSQL and browser checks for '+sha);return}
  console.log('Waiting for exact-commit GitHub tests ('+(attempt+1)+'/24)');await new Promise(r=>setTimeout(r,15000));
 }
 throw Error('No passing exact-commit checks within six minutes; deployment blocked');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1});
