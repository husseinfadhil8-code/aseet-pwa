"""Configure the deployed Worker without reading Telegram/Supabase secret values.
Requires Cloudflare token in this process; generates ephemeral setup/webhook secrets.
"""
import os,json,secrets,urllib.request,urllib.error
BASE='https://api.cloudflare.com/client/v4'
def cf(path,body=None,method=None):
 req=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+os.environ['CLOUDFLARE_API_TOKEN'],'Content-Type':'application/json'},method=method)
 with urllib.request.urlopen(req,timeout=25) as r:data=json.load(r)
 if not data.get('success'):raise RuntimeError('Cloudflare operation denied')
 return data['result']
def main():
 account=os.environ.get('CLOUDFLARE_ACCOUNT_ID')
 if not account:raise RuntimeError('Cloudflare account not configured')
 path=f'/accounts/{account}/workers/scripts/waseet-telegram-bot'
 sub=cf(f'/accounts/{account}/workers/subdomain')['subdomain'];origin=f'https://waseet-telegram-bot.{sub}.workers.dev'
 names={x['name'] for x in cf(path+'/secrets')}
 if not {'TELEGRAM_BOT_TOKEN','SUPABASE_SERVICE_ROLE_KEY'}.issubset(names):raise RuntimeError('Add Telegram and Test Supabase secrets in Cloudflare first')
 key=secrets.token_urlsafe(32)
 try:
  if 'TELEGRAM_WEBHOOK_SECRET' not in names:cf(path+'/secrets',{'name':'TELEGRAM_WEBHOOK_SECRET','text':secrets.token_urlsafe(36),'type':'secret_text'},'PUT')
  cf(path+'/secrets',{'name':'DEPLOY_SETUP_KEY','text':key,'type':'secret_text'},'PUT')
  req=urllib.request.Request(origin+'/internal/setup',data=b'{}',headers={'Content-Type':'application/json','x-waseet-setup':key},method='POST')
  with urllib.request.urlopen(req,timeout=45) as r:result=json.load(r)
  if not result.get('ok'):raise RuntimeError('Setup verification failed')
  with urllib.request.urlopen(origin+'/health',timeout=20) as r:assert json.load(r)['ok']
  with urllib.request.urlopen(origin+'/miniapp/',timeout=20) as r:assert '<html lang="ar" dir="rtl">' in r.read().decode()
  with urllib.request.urlopen(origin+'/api/listings',timeout=20) as r:assert isinstance(json.load(r)['data'],list)
  print(json.dumps({'worker':origin,'miniapp':origin+'/miniapp/','bot':result['bot'],'webhook':result['webhook'],'api_verified':True}))
 finally:
  cf(path+'/secrets/DEPLOY_SETUP_KEY',method='DELETE')
if __name__=='__main__':
 try:main()
 except urllib.error.HTTPError as e:print('Configuration stopped: HTTP '+str(e.code)+'; response/credentials withheld');raise SystemExit(1)
 except Exception as e:print('Configuration stopped safely: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__));raise SystemExit(1)
