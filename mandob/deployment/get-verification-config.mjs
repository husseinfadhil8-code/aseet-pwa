// Pure review helper. Does not create tokens, execute SQL, or contact Cloudflare.
export function getVerificationConfig(current, {pageId, enableGET=false, secretNames=[]}={}) {
 const c=structuredClone(current);
 if(c.account_id!=='b2095b7419974a8e91484f2f1169f482'||c.name!=='mandob-baghdad-api'||c.d1_databases?.length!==1||c.d1_databases[0].database_id!=='a28b6985-e1dc-4eae-b422-fdb04419e89a'||c.d1_databases[0].database_name!=='mandob-baghdad-db')throw Error('Existing Mandob resources must be verified');
 if(c.vars?.FREE_ONLY!=='true'||c.vars.ADMIN_AUTH_MODE!=='passkey'||c.vars.ADMIN_ORIGIN!=='https://mandob-baghdad-api.husseinfadhil8.workers.dev'||c.vars.WEBAUTHN_RP_ID!=='mandob-baghdad-api.husseinfadhil8.workers.dev'||c.ai||c.r2_buckets||c.queues||c.triggers?.crons?.length)throw Error('Unexpected pilot configuration');
 if(!/^\d{1,40}$/.test(pageId||''))throw Error('Verified real Page ID required; no synthetic placeholder');
 for(const name of ['META_VERIFY_TOKEN','META_APP_SECRET','META_PAGE_TOKEN','DATA_KEY'])if(c.vars[name]!==undefined)throw Error('Secrets must not be plaintext variables');
 if(enableGET&&!secretNames.includes('META_VERIFY_TOKEN'))throw Error('Verify Token Secret installation must be confirmed by metadata');
 Object.assign(c.vars,{PAGE_ID:pageId,ALLOW_META_WEBHOOK_VERIFY:enableGET?'true':'false',ALLOW_MESSENGER_INTAKE:'false',ALLOW_MESSENGER_PUBLIC:'false',ALLOW_MESSENGER_ADMIN:'false',ALLOW_MESSENGER_ADMIN_SEND:'false',ALLOW_CUSTOMER_SEND:'false',ALLOW_SEND:'false',ALLOW_ALERT_SEND:'false',ALLOW_AI:'false',ALLOW_MEDIA:'false',ALLOW_ADMIN_APPROVAL_ENROLLMENT:'false',MESSENGER_INTAKE_MODE:'test',AI_DAILY_CALL_LIMIT:'0',AI_DAILY_NEURON_RESERVE_LIMIT:'0'});
 return c;
}
