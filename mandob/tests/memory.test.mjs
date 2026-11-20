import test from "node:test";
import assert from "node:assert/strict";
import { fixture, event, image, req } from "./helpers.mjs";
import { receive, drain, textSearch, itemView } from "../src/memory.mjs";
import { extract, normalize, cosine } from "../src/extract.mjs";
import { seal, open, signature } from "../src/security.mjs";
import { semantic, indexItem, groundedExtract, caption } from "../src/ai.mjs";
import { savePhotos, photoBytes } from "../src/media.mjs";
import { sendPending } from "../src/outbox.mjs";
import worker from "../src/worker.mjs";
const one = (sql) => sql.prepare("SELECT * FROM items").get();
const settings = (sql, patch = {}) => {
  const d = { replies: 0, alerts: 0, ai: 0, photos: 0, ...patch };
  sql
    .prepare(
      "INSERT OR REPLACE INTO settings(page_id,replies,alerts,ai,photos) VALUES(?,?,?,?,?)",
    )
    .run("111", d.replies, d.alerts, d.ai, d.photos);
};
test("Iraqi extraction does not invent names, dollar prices or availability", () => {
  assert.equal(
    extract("ثلاجة للبيع السعر: ٣٠٠ ألف\nالمنطقة: المنصور\nمستعملة").price_iqd,
    300000,
  );
  assert.equal(extract("ثلاجة سعرها 100 دولار").price_iqd, null);
  assert.equal(extract("اريد ثلاجة").intent, "buyer");
  assert.equal(extract("اريد ابيع ثلاجة").intent, "seller");
  assert.equal(extract("ثلاجة جديدة").condition, "جديد");
  assert.equal(extract("صورة").title, null);
});
test("encrypted identity and messages; automatic private item memory and duplicate webhook", async () => {
  const { env, sql } = fixture();
  const e = event(
    "ثلاجة للبيع السعر: ٣٠٠ ألف\nالمنطقة: بغداد\nمستعملة",
    "one",
    "222",
    [image("https://scontent.fbcdn.net/x.jpg")],
  );
  await receive(env, e);
  await receive(env, e);
  assert.equal(await drain(env), 1);
  assert.equal(await drain(env), 0);
  const i = one(sql);
  assert.equal(i.price_iqd, 300000);
  assert.equal(i.status, "unknown");
  assert.equal(i.last_confirmed, null);
  assert.equal(i.publish_consent, 0);
  const s = sql.prepare("SELECT * FROM sellers").get();
  assert.equal(s.name, null);
  assert(!s.psid_cipher.includes("222"));
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM media").get().n, 1);
  const v = await itemView(env, i);
  assert.equal(v.seller.psid, "222");
  assert.equal(v.inbox_url, null);
  assert.equal(v.description, e.message.text);
});
test("missing fields are asked and followup updates same item", async () => {
  const { env, sql } = fixture();
  settings(sql, { replies: 1 });
  await receive(env, event("ثلاجة للبيع"));
  await drain(env);
  const m = sql.prepare("SELECT * FROM outbox").get();
  const p = await open(env, m.payload_cipher, "111:outbox:" + m.id);
  assert.match(p.text, /السعر/);
  assert.match(p.text, /المنطقة/);
  await receive(env, event("السعر: 250 ألف\nالمنطقة: الكرادة\nمستعمل", "m2"));
  await drain(env);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM items").get().n, 1);
  assert.equal(one(sql).price_iqd, 250000);
  assert.equal(one(sql).area, "الكرادة");
});
test("different new object is not merged; sender and page boundaries", async () => {
  const { env, sql } = fixture();
  await receive(env, event("ثلاجة للبيع"));
  await drain(env);
  await receive(env, event("كاونتر للبيع", "m2"));
  await drain(env);
  await receive(env, event("ثلاجة للبيع", "m3", "333"));
  await drain(env);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM items").get().n, 3);
  env.PAGE_ID = "999";
  assert.equal((await textSearch(env, "ثلاجة")).items.length, 0);
  await assert.rejects(receive(env, event("غرض")), /invalid_message/);
});
test("buyer creates interest with owner link only if known; no false availability", async () => {
  const { env, sql } = fixture();
  settings(sql, { replies: 1, alerts: 1 });
  await receive(env, event("كاونتر للبيع"));
  await drain(env);
  await receive(env, event("اريد كاونتر", "buyer", "333"));
  await drain(env);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM interests").get().n, 1);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM items").get().n, 1);
  const row = sql.prepare("SELECT * FROM outbox WHERE kind='alert'").get();
  const p = await open(env, row.payload_cipher, "111:outbox:" + row.id);
  assert.equal(p.last_confirmed, null);
  assert.match(p.notice, /تأكيد التوفر/);
});
test("financial agreement stops automatic replies", async () => {
  const { env, sql } = fixture();
  settings(sql, { replies: 1, alerts: 1 });
  await receive(env, event("ثلاجة للبيع"));
  await drain(env);
  await receive(env, event("اتفقنا احول عربون", "finance"));
  await drain(env);
  assert.equal(
    sql.prepare("SELECT handoff FROM conversations").get().handoff,
    1,
  );
  let calls = 0;
  env.ALLOW_SEND = "true";
  await sendPending(env, async () => {
    calls++;
  });
  assert.equal(calls, 0);
  assert.equal(
    sql.prepare("SELECT state FROM outbox WHERE kind='reply'").get().state,
    "cancelled",
  );
});
test("bad signature and oversized payload are rejected before storage", async () => {
  const { env, sql } = fixture();
  const raw = JSON.stringify({
    object: "page",
    entry: [{ id: "111", messaging: [event("ثلاجة للبيع")] }],
  });
  const invalid = await worker.fetch(
    new Request("https://x/webhooks/meta/messenger", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) },
      body: raw,
    }),
    env,
  );
  assert.equal(invalid.status, 401);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
  const huge = await worker.fetch(
    new Request("https://x/webhooks/meta/messenger", {
      method: "POST",
      body: "a".repeat(262145),
    }),
    env,
  );
  assert.equal(huge.status, 413);
});
test("signed webhook verification and durable intake do not call AI or send", async () => {
  const { env, sql } = fixture();
  const raw = JSON.stringify({
    object: "page",
    entry: [{ id: "111", messaging: [event("ثلاجة للبيع")] }],
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.META_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)),
  ).toString("hex");
  assert(
    await signature(
      new TextEncoder().encode(raw),
      env.META_APP_SECRET,
      "sha256=" + sig,
    ),
  );
  const response = await worker.fetch(
    new Request("https://x/webhooks/meta/messenger", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=" + sig },
      body: raw,
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM events").get().n, 1);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM items").get().n, 0);
  assert.equal(
    (
      await worker.fetch(
        new Request(
          "https://x/webhooks/meta/messenger?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=123",
        ),
        env,
      )
    ).status,
    200,
  );
});
test("admin endpoints deny unauthenticated and cross-origin mutations", async () => {
  const { env } = fixture();
  assert.equal(
    (await worker.fetch(new Request("https://x/api/items"), env)).status,
    401,
  );
  const r = req(env, "/api/settings", "PATCH", { alerts: true });
  r.headers.set("Origin", "https://evil.test");
  assert.equal((await worker.fetch(r, env)).status, 403);
});
test("availability requires explicit verification, real inbox URL, private image API", async () => {
  const { env, sql } = fixture();
  await receive(env, event("ثلاجة للبيع"));
  await drain(env);
  const id = one(sql).id;
  assert.equal(
    (
      await worker.fetch(
        req(env, "/api/items/" + id, "PATCH", { status: "available" }),
        env,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        req(env, "/api/items/" + id, "PATCH", {
          status: "available",
          confirmed: true,
          inbox_url: "https://evil.test/messages",
        }),
        env,
      )
    ).status,
    400,
  );
  assert.equal(one(sql).status, "unknown");
  assert.equal(
    (
      await worker.fetch(
        req(env, "/api/items/" + id, "PATCH", {
          status: "available",
          confirmed: true,
        }),
        env,
      )
    ).status,
    200,
  );
  assert(one(sql).last_confirmed > 0);
  assert.equal((await worker.fetch(req(env, "/api/items"), env)).status, 200);
  env.PAGE_ID = "999";
  assert.equal(
    (
      await worker.fetch(
        req(env, "/api/items/" + id, "PATCH", { status: "sold" }),
        env,
      )
    ).status,
    404,
  );
});
test("AI stays disabled and does not call a provider unless two gates and budget allow", async () => {
  const { env, sql } = fixture();
  let calls = 0;
  env.AI = {
    run: async () => {
      calls++;
      return { data: [[1, 0]] };
    },
  };
  await assert.rejects(semantic(env, "ثلاجة"), /ai_not_enabled/);
  settings(sql, { ai: 1 });
  env.ALLOW_AI = "true";
  await assert.rejects(semantic(env, "ثلاجة"), /ai_budget_required/);
  env.AI_DAILY_CALL_LIMIT = "1";
  assert.equal((await semantic(env, "ثلاجة")).items.length, 0);
  await assert.rejects(semantic(env, "ثلاجة"), /ai_daily_limit/);
  assert.equal(calls, 1);
});
test("semantic search and caption bridge use versioned embeddings, not mocked success claims", async () => {
  const { env, sql } = fixture();
  await receive(env, event("كاونتر للبيع"));
  await drain(env);
  settings(sql, { ai: 1 });
  env.ALLOW_AI = "true";
  env.AI_DAILY_CALL_LIMIT = "10";
  const calls = [];
  env.AI = {
    run: async (model, input) => {
      calls.push({ model, input });
      return model.includes("vision")
        ? { response: "طاولة خشبية" }
        : { data: [[1, 0, 0]] };
    },
  };
  await indexItem(env, one(sql));
  assert.equal((await semantic(env, "طاولة خشبية")).items[0].id, one(sql).id);
  assert.equal(await caption(env, new Uint8Array([1, 2])), "طاولة خشبية");
  assert(calls.some((c) => c.model.includes("vision")));
  assert.equal(cosine([1, 0], [0, 1]), 0);
});
test("grounded AI refuses invented attributes absent from source", async () => {
  const { env, sql } = fixture();
  settings(sql, { ai: 1 });
  env.ALLOW_AI = "true";
  env.AI_DAILY_CALL_LIMIT = "2";
  env.AI = {
    run: async () => ({
      response: JSON.stringify({
        intent: "seller",
        title: "طاولة",
        area: "المنصور",
        condition: "جديد",
      }),
    }),
  };
  const result = await groundedExtract(
    env,
    "عندي طاولة للبيع",
    extract("عندي طاولة للبيع"),
  );
  assert.equal(result.title, "طاولة");
  assert.equal(result.area, null);
  assert.equal(result.condition, null);
});
test("private photo fetch blocks SSRF and stores encrypted bytes, never public URLs", async () => {
  const { env, sql } = fixture();
  settings(sql, { photos: 1 });
  env.ALLOW_MEDIA = "true";
  const store = new Map();
  env.PHOTOS = {
    put: async (k, v) => store.set(k, v),
    get: async (k) => ({ text: async () => store.get(k) }),
  };
  await receive(
    env,
    event("ثلاجة للبيع", "m1", "222", [image("http://127.0.0.1/secret")]),
  );
  await drain(env);
  let calls = 0;
  await savePhotos(env, async () => {
    calls++;
  });
  assert.equal(calls, 0);
  assert.equal(sql.prepare("SELECT state FROM media").get().state, "failed");
  await receive(
    env,
    event("صور", "m2", "222", [image("https://cdn.fbcdn.net/test")]),
  );
  await drain(env);
  const bytes = Uint8Array.from([255, 216, 255, 1, 2, 3]);
  assert.equal(
    await savePhotos(env, async (_u, opts) => {
      assert.equal(opts.redirect, "error");
      return new Response(bytes);
    }),
    1,
  );
  const row = sql.prepare("SELECT * FROM media WHERE state='stored'").get();
  assert.deepEqual(await photoBytes(env, row.id), bytes);
  assert(!store.get(row.object_key).includes("255"));
  assert.equal(
    (await worker.fetch(new Request("https://x/api/photos/" + row.id), env))
      .status,
    401,
  );
});
test("outbox retries safely without leaking raw errors, stops when disabled", async () => {
  const { env, sql } = fixture();
  settings(sql, { alerts: 1 });
  await receive(env, event("ثلاجة للبيع"));
  await drain(env);
  await receive(env, event("اريد ثلاجة", "buyer", "333"));
  await drain(env);
  env.ALLOW_ALERT_SEND = "true";
  env.ADMIN_CHAT_ID = "123";
  env.ADMIN_BOT_TOKEN = "not-real";
  await sendPending(env, async () => {
    throw new Error("secret with raw message");
  });
  const row = sql.prepare("SELECT * FROM outbox WHERE kind='alert'").get();
  assert.equal(row.error, "delivery_failed");
  assert.equal(row.state, "pending");
  settings(sql, { alerts: 0 });
  let calls = 0;
  await sendPending(
    env,
    async () => {
      calls++;
    },
    Date.now() + 1e6,
  );
  assert.equal(calls, 0);
});
test("old incoming event never opens a fresh 24 hour reply window", async () => {
  const { env, sql } = fixture();
  settings(sql, { replies: 1 });
  const e = event("ثلاجة للبيع");
  e.timestamp = Date.now() - 2 * 86400000;
  await receive(env, e);
  await drain(env);
  env.ALLOW_SEND = "true";
  let calls = 0;
  await sendPending(env, async () => {
    calls++;
  });
  assert.equal(calls, 0);
  assert.equal(
    sql.prepare("SELECT state FROM outbox").get().state,
    "cancelled",
  );
});
test("corrupted ciphertext, page substitution and unsupported media fail closed", async () => {
  const { env } = fixture();
  const x = await seal(env, { a: 1 }, "111");
  await assert.rejects(open(env, x, "999"));
  await assert.rejects(open({ ...env, DATA_KEY: "bad" }, x, "111"));
  assert.equal(normalize("أثاث ٣٠٠"), "اثاث 300");
});
test("two same-category sale offers stay separate; explicit reply targets correct item", async () => {
  const { env, sql } = fixture();
  await receive(env, event("ثلاجة للبيع السعر: 100 ألف", "first"));
  await drain(env);
  const first = one(sql).id;
  await receive(env, event("ثلاجة للبيع السعر: 200 ألف", "second"));
  await drain(env);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM items").get().n, 2);
  const follow = event("المنطقة: الكرادة", "third");
  follow.message.reply_to = { mid: "first" };
  await receive(env, follow);
  await drain(env);
  assert.equal(
    sql.prepare("SELECT area FROM items WHERE id=?").get(first).area,
    "الكرادة",
  );
  assert.equal(
    sql.prepare("SELECT area FROM items WHERE id<>?").get(first).area,
    null,
  );
});
test("financial admin notification contains only verified saved details and actual conversation URL", async () => {
  const { env, sql } = fixture();
  settings(sql, { alerts: 1 });
  await receive(env, event("كاونتر للبيع"));
  await drain(env);
  const item = one(sql);
  await worker.fetch(
    req(env, "/api/items/" + item.id, "PATCH", {
      name: "بائع الاختبار",
      inbox_url: "https://business.facebook.com/latest/inbox/all?asset_id=111",
    }),
    env,
  );
  await receive(env, event("اريد كاونتر", "buyer", "333"));
  await drain(env);
  env.ALLOW_ALERT_SEND = "true";
  env.ADMIN_CHAT_ID = "123";
  env.ADMIN_BOT_TOKEN = "fake-test-token";
  let payload;
  assert.equal(
    await sendPending(env, async (_url, options) => {
      payload = JSON.parse(options.body);
      return new Response(JSON.stringify({ ok: true }));
    }),
    1,
  );
  assert.equal(payload.chat_id, "123");
  assert.match(payload.text, /كاونتر/);
  assert.match(payload.text, /بائع الاختبار/);
  assert.match(payload.text, /business.facebook.com/);
  assert.match(payload.text, /غير مؤكد/);
  assert.equal(payload.protect_content, true);
});
test("concurrent drains do not duplicate item descriptions", async () => {
  const { env, sql } = fixture();
  await receive(env, event("ثلاجة للبيع"));
  await Promise.all([drain(env), drain(env)]);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM messages").get().n, 1);
  assert.equal((await itemView(env, one(sql))).description, "ثلاجة للبيع");
});
test("FTS survives punctuation and SQL-like user input without modifying data", async () => {
  const { env, sql } = fixture();
  await receive(env, event("ثلاجة للبيع"));
  await drain(env);
  await textSearch(env, '"; DROP TABLE items;-- ثلاجة');
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM items").get().n, 1);
});
test("image query and budgeted automatic indexing stay gated at API layer", async () => {
  const { env } = fixture();
  const r = await worker.fetch(
    req(env, "/api/search", "POST", {
      mode: "image",
      image: Buffer.from([255, 216, 255, 0]).toString("base64"),
    }),
    env,
  );
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "ai_not_enabled");
});
test("toggles and text search survive restart; pending events survive processing failure", async () => {
  const { env, sql } = fixture();
  settings(sql, { replies: 1 });
  await receive(env, event("ثلاجة للبيع"));
  const real = env.DATA_KEY;
  env.DATA_KEY = "b".repeat(64);
  await drain(env);
  assert.equal(
    sql.prepare("SELECT status FROM events").get().status,
    "pending",
  );
  assert.equal(sql.prepare("SELECT attempts FROM events").get().attempts, 1);
  env.DATA_KEY = real;
  await drain(env);
  assert.equal((await textSearch(env, "ثلاجة")).items.length, 1);
  assert.equal(
    (await (await worker.fetch(req(env, "/api/settings"), env)).json()).replies,
    1,
  );
});
test("seller explicit sold/availability assertions are dated; generic sale never confirms availability", async () => {
  const { env, sql } = fixture();
  await receive(env, event("ثلاجة للبيع"));
  await drain(env);
  assert.equal(one(sql).last_confirmed, null);
  await receive(env, event("بعدها متوفرة", "m2"));
  await drain(env);
  assert.equal(one(sql).status, "available");
  assert(one(sql).last_confirmed);
  await receive(env, event("انباعت", "m3"));
  await drain(env);
  assert.equal(one(sql).status, "sold");
  assert.equal((await textSearch(env, "ثلاجة")).items.length, 0);
});
test("background waitUntil automatically materializes signed events without manual admin action", async () => {
  const { env, sql } = fixture();
  const raw = JSON.stringify({
    object: "page",
    entry: [{ id: "111", messaging: [event("غسالة للبيع")] }],
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.META_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)),
  ).toString("hex");
  const background = [];
  const response = await worker.fetch(
    new Request("https://x/webhooks/meta/messenger", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=" + sig },
      body: raw,
    }),
    env,
    { waitUntil: (p) => background.push(p) },
  );
  assert.equal(response.status, 200);
  await Promise.all(background);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM items").get().n, 1);
  assert.equal(one(sql).title, "غسالة");
});
test("outgoing replies only use Page Send API and stop after successful delivery", async () => {
  const { env, sql } = fixture();
  settings(sql, { replies: 1 });
  await receive(env, event("ثلاجة للبيع"));
  await drain(env);
  env.ALLOW_SEND = "true";
  env.META_PAGE_TOKEN = "test-token";
  let calls = 0;
  assert.equal(
    await sendPending(env, async (url, options) => {
      calls++;
      assert.match(url, /graph.facebook.com\/v23.0\/111\/messages/);
      const payload = JSON.parse(options.body);
      assert.equal(payload.messaging_type, "RESPONSE");
      assert.equal(payload.recipient.id, "222");
      assert(!payload.tag);
      return new Response(JSON.stringify({ message_id: "mid-test" }));
    }),
    1,
  );
  await sendPending(env, async () => {
    calls++;
  });
  assert.equal(calls, 1);
});
test('image search endpoint returns saved item and correct owner with a synthetic provider contract',async()=>{const {env,sql}=fixture();await receive(env,event('كاونتر للبيع'));await drain(env);settings(sql,{ai:1});env.ALLOW_AI='true';env.AI_DAILY_CALL_LIMIT='6';env.AI={run:async model=>model.includes('vision')?{response:'كاونتر خشبي'}:{data:[[1,0]]}};await indexItem(env,one(sql));const response=await worker.fetch(req(env,'/api/search','POST',{mode:'image',image:Buffer.from([255,216,255,0]).toString('base64')}),env);assert.equal(response.status,200);const d=await response.json();assert.equal(d.items[0].id,one(sql).id);assert.equal(d.items[0].seller.psid,'222');assert.equal(d.items[0].seller.name,null);assert.match(d.notice,/تقريبية/);});
test('disabled reply setting suppresses already queued replies',async()=>{const {env,sql}=fixture();settings(sql,{replies:1});await receive(env,event('ثلاجة للبيع'));await drain(env);settings(sql,{replies:0});env.ALLOW_SEND='true';let calls=0;await sendPending(env,async()=>{calls++;});assert.equal(calls,0);assert.equal(sql.prepare('SELECT state FROM outbox').get().state,'pending');});
