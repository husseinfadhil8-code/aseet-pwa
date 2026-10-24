// Exercise the real vendored SDK transport builder with a fake fetch, never a network.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const sandbox = {console, URL, URLSearchParams, Headers, Response, Request, AbortController,
  TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: () => {throw new Error('Unmocked network forbidden');}};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('vendor/supabase-2.118.0.js', 'utf8'), sandbox);
const requests = [];
sandbox.db = sandbox.supabase.createClient('https://test.invalid', 'offline-public-fixture', {
  auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false},
  realtime: {transport: class FakeWebSocket {}},
  global: {fetch: async (url, options) => {
    requests.push({url: String(url), options});
    return new Response('[]', {status: 200, headers: {'Content-Type': 'application/json', 'Content-Range': '*/0'}});
  }}
});
vm.runInContext(fs.readFileSync('market-data.js', 'utf8'), sandbox);
(async () => {
  const session = await sandbox.db.auth.getSession();
  assert.equal(session.data.session, null);
  assert.equal(requests.length, 0);
  const query = vm.runInContext(`goodsPageQuery({search:'chair,or(id.gt.0)"',status:'available',category:'',area:'',max:'1000'},
    {id:'00000000-0000-0000-0000-000000000001',created_at:'2026-10-24T10:00:00+00:00'})`, sandbox);
  const result = await query;
  assert.equal(result.error, null);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.origin, 'https://test.invalid');
  assert.equal(url.searchParams.get('limit'), '40');
  assert.equal(url.searchParams.get('order'), 'created_at.desc,id.desc');
  assert.equal(url.searchParams.get('status'), 'eq.available');
  assert.equal(url.searchParams.getAll('or').length, 2); // Search AND cursor groups coexist.
  assert.ok(url.searchParams.getAll('or')[0].includes('\\"'));
  assert.ok(!url.searchParams.get('select').includes('owner_phone'));
})().catch(error => {console.error(error); process.exitCode = 1;});
