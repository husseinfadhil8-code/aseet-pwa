import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {fixture,event} from './helpers.mjs';import {receive,drain,itemView} from '../src/memory.mjs';
test('synthetic local backup restores encrypted owner/item and all four migrations without touching source',async()=>{
 const {env,sql}=fixture();const dir=mkdtempSync(join(tmpdir(),'mandob-backup-'));let restored;
 try {await receive(env,event('تخم للبيع بسعر 300 ألف في المنصور'));await drain(env);const original=sql.prepare('SELECT * FROM items').get();await backup(sql,join(dir,'snapshot.sqlite'));restored=new DatabaseSync(join(dir,'snapshot.sqlite'));
 assert.equal(restored.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length,0);
 assert.equal(restored.prepare('SELECT count(*) n FROM items').get().n,1);assert.equal(restored.prepare('SELECT count(*) n FROM sellers').get().n,1);assert(restored.prepare("SELECT name FROM sqlite_master WHERE name='ai_reservations'").get());
 assert.equal(restored.prepare('SELECT * FROM items').get().description_cipher,original.description_cipher);assert.equal((await itemView(env,restored.prepare('SELECT * FROM items').get())).seller.psid,'222');
 }finally{restored?.close();sql.close();rmSync(dir,{recursive:true,force:true});}
});
