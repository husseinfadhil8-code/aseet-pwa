import {SafeError} from './services.js';
export function notificationError(error,fallback='notification_failure'){
 const message=String(error?.message||error||'');
 let code=(error instanceof SafeError||typeof error==='string'&&/^[a-z_0-9]{1,80}$/.test(message))?message:/too many subrequests|too many api requests|subrequest.*limit/i.test(message)?'worker_subrequest_limit':/TimeoutError|AbortError/.test(error?.name||'')?'database_timeout':/fetch failed|network|connection|socket/i.test(message)?'database_network':/D1_ERROR|SQLITE_/i.test(message)?'notification_d1_error':fallback;
 if(!/^[a-z_0-9]{1,80}$/.test(code))code=fallback;
 return {code,name:String(error?.name||'Error').slice(0,50),message:message.replace(/https?:\/\/\S+/g,'[url]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/[A-Za-z0-9_-]{35,}/g,'[identifier]').replace(/[\r\n]/g,' ').slice(0,250)};
}
export function databaseFailure(error,phase){const d=notificationError(error,phase==='json'?'database_invalid_json':'database_network');const e=new SafeError(d.code,503);e.diagnostic=d;return e}
