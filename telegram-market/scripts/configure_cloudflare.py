"""Configure the deployed Worker without reading Telegram/Supabase secret values.
Requires Cloudflare token in this process; generates ephemeral setup/webhook secrets.
"""
import os,json,secrets,time,urllib.request,urllib.error
BASE='https://api.cloudflare.com/client/v4'
# Cloudflare rejects the default Python urllib user agent (error 1010).
opener=urllib.request.build_opener()
opener.addheaders=[('User-Agent','WaseetDeployment/1.0')]
urllib.request.install_opener(opener)
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
  setup_body={'channel':os.environ['WASEET_INITIAL_CHANNEL']} if os.environ.get('WASEET_INITIAL_CHANNEL') else {}
  if os.environ.get('WASEET_CHANNEL_TEST_LISTING'):setup_body['channelPublication']={'listing':os.environ['WASEET_CHANNEL_TEST_LISTING'],'request':os.environ['WASEET_CHANNEL_TEST_REQUEST'],'expected_channel':os.environ['WASEET_CHANNEL_TEST_TARGET']}
  if os.environ.get('WASEET_NOTIFY_TEST')=='true':setup_body.update(notificationTest=True,notificationRequest=os.environ['WASEET_NOTIFY_REQUEST'])
  if os.environ.get('WASEET_NOTIFY_APPROVE'):setup_body['notificationApprove']=os.environ['WASEET_NOTIFY_APPROVE']
  if os.environ.get('WASEET_NOTIFY_LISTING'):setup_body['notificationListing']=os.environ['WASEET_NOTIFY_LISTING']
  if os.environ.get('WASEET_NOTIFY_ACTIVATE')=='true':setup_body['notificationActivate']=True
  req=urllib.request.Request(origin+'/internal/setup',data=json.dumps(setup_body).encode(),headers={'Content-Type':'application/json','x-waseet-setup':key},method='POST')
  for attempt in range(4):
   try:
    with urllib.request.urlopen(req,timeout=90 if setup_body.get('channelPublication') else 45) as r:result=json.load(r)
    break
   except urllib.error.HTTPError as e:
    if e.code!=401 or attempt==3:raise
    time.sleep(3)
  if not result.get('ok'):raise RuntimeError('Setup verification failed')
  with urllib.request.urlopen(origin+'/health',timeout=20) as r:assert json.load(r)['ok']
  with urllib.request.urlopen(origin+'/miniapp/',timeout=20) as r:assert '<html lang="ar" dir="rtl">' in r.read().decode()
  with urllib.request.urlopen(origin+'/api/listings',timeout=20) as r:assert isinstance(json.load(r)['data'],list)
  print(json.dumps({'worker':origin,'miniapp':origin+'/miniapp/','bot':result['bot'],'webhook':result['webhook'],'api_verified':True,'menu_verified':result.get('menuVerified',False),'commands_verified':result.get('commandsVerified',False),'main_mini_app_enabled':result.get('mainMiniApp',False),'pending_updates':result.get('pendingUpdates'),'owner_verified':result.get('ownerVerified',False),'channel_verified':result.get('channelVerified',False),'readiness':result.get('readiness'),'notification_test':result.get('notificationTest'),'channel_publication':result.get('channelPublication')}))
 finally:
  cf(path+'/secrets/DEPLOY_SETUP_KEY',method='DELETE')
if __name__=='__main__':
 try:main()
 except urllib.error.HTTPError as e:
  code=''
  try:
   candidate=json.loads(e.read()).get('error')
   if candidate in {'telegram_token_rejected','database_credentials_rejected','database_schema_not_ready','database_unavailable','wrong_bot','bot_not_configured','database_not_configured','unauthorized','channel_permission_required','channel_unreachable','channel_bot_not_member','channel_type_required','owner_or_channel_mismatch','channel_publication_needs_review','invalid_channel','listing_approval_required'}:code='; '+candidate
  except Exception:pass
  print('Configuration stopped: HTTP '+str(e.code)+code+'; credentials withheld');raise SystemExit(1)
 except Exception as e:print('Configuration stopped safely: '+(str(e) if isinstance(e,RuntimeError) else type(e).__name__));raise SystemExit(1)
