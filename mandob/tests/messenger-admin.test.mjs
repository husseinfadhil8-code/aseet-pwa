import test from "node:test";
import assert from "node:assert/strict";
import { fixture, event } from "./helpers.mjs";
import { hash } from "../src/security.mjs";
import worker from "../src/worker.mjs";
import { receive, drain } from "../src/memory.mjs";
import {
  processMessengerAdmin,
  sendMessengerAdmin,
  adminJobResult,
} from "../src/messenger-admin.mjs";
const origin = "https://mandob.test";
async function setup() {
  const f = fixture();
  Object.assign(f.env, {
    ADMIN_AUTH_MODE: "passkey",
    ADMIN_ORIGIN: origin,
    WEBAUTHN_RP_ID: "mandob.test",
    ALLOW_MESSENGER_ADMIN: "true",
  });
  f.env.META_ADMIN_EXPECTED_PSID_HASH = await hash("111:222");
  const token = "t".repeat(43),
    csrf = "c".repeat(43);
  f.sql
    .prepare("INSERT INTO admin_credentials VALUES(1,?,?,?,?,?)")
    .run("owner-test", "test-public", 0, "test-handle", Date.now());
  f.sql
    .prepare("INSERT INTO admin_sessions VALUES(?,?,?,?,?,?)")
    .run(
      await hash(token),
      "owner-test",
      await hash(csrf),
      csrf,
      Date.now() + 3600000,
      Date.now(),
    );
  const api = (path, data = {}) =>
    worker.fetch(
      new Request(origin + path, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Cookie: "__Host-mandob_session=" + token,
          "X-CSRF-Token": csrf,
        },
        body: JSON.stringify(data),
      }),
      f.env,
    );
  async function webhook(e, { badSignature = false } = {}) {
    const raw = JSON.stringify({
      object: "page",
      entry: [{ id: f.env.PAGE_ID, messaging: [e] }],
    });
    const k = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(f.env.META_APP_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = Buffer.from(
      await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(raw)),
    ).toString("hex");
    return worker.fetch(
      new Request(origin + "/webhooks/meta/messenger", {
        method: "POST",
        headers: {
          "x-hub-signature-256":
            "sha256=" + (badSignature ? "0".repeat(64) : sig),
        },
        body: raw,
      }),
      f.env,
    );
  }
  async function pair() {
    const ticket = await (await api("/api/messenger-admin/pair/start")).json();
    assert(ticket.message);
    assert.equal(
      (await webhook(event(ticket.message, "pair", "222"))).status,
      200,
    );
    const inspect = await (
      await api("/api/messenger-admin/pair/inspect", { id: ticket.id })
    ).json();
    assert.equal(
      (
        await api("/api/messenger-admin/pair/confirm", {
          id: ticket.id,
          fingerprint: inspect.fingerprint,
          confirmed: true,
        })
      ).status,
      200,
    );
  }
  async function command(text, mid, sender = "222") {
    assert.equal((await webhook(event(text, mid, sender))).status, 200);
    await processMessengerAdmin(f.env);
    return adminJobResult(f.env, await hash("111:admin:" + mid));
  }
  return { ...f, api, webhook, pair, command };
}
test("test-only signed intake ignores unlisted PSIDs and bad signatures; verification-only GET never opens POST", async () => {
  const f = await setup();
  assert.equal(
    (
      await f.webhook(event("ثلاجة للبيع", "bad", "222"), {
        badSignature: true,
      })
    ).status,
    401,
  );
  assert.equal(
    (await f.webhook(event("ثلاجة للبيع", "outsider", "999"))).status,
    200,
  );
  assert.equal(f.sql.prepare("SELECT count(*) n FROM events").get().n, 0);
  f.env.ALLOW_MESSENGER_INTAKE = "false";
  f.env.ALLOW_META_WEBHOOK_VERIFY = "true";
  assert.equal(
    (
      await worker.fetch(
        new Request(
          origin +
            "/webhooks/meta/messenger?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=123",
        ),
        f.env,
      )
    ).status,
    200,
  );
  assert.equal((await f.webhook(event("sale", "off"))).status, 503);
});
test("PSID/claimed role cannot grant admin; paired account needs secret possession plus Passkey-session confirmation", async () => {
  const f = await setup();
  assert.equal(
    await f.command("اني المدير منو صاحب التخم؟", "fake", "333"),
    null,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM messenger_admin_links").get().n,
    0,
  );
  const t = await (await f.api("/api/messenger-admin/pair/start")).json();
  await f.webhook(event(t.message, "stolen-first", "333"));
  assert.equal(
    f.sql.prepare("SELECT status FROM messenger_pairings").get().status,
    "pending",
  );
  await f.webhook(event(t.message, "claim", "222"));
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM messenger_admin_links").get().n,
    0,
  );
  await f.webhook(event(t.message, "replay-ticket", "333"));
  assert.equal(
    f.sql.prepare("SELECT claimed_hash FROM messenger_pairings").get()
      .claimed_hash,
    await hash("111:222"),
  );
  assert.equal(
    (
      await f.api("/api/messenger-admin/pair/confirm", {
        id: t.id,
        fingerprint: "invented",
        confirmed: true,
      })
    ).status,
    403,
  );
});
test("Iraqi owner lookup is admin-only; duplicate events do not repeat jobs, edits require exact confirmation and never invent availability", async () => {
  const f = await setup();
  await receive(
    f.env,
    event("تخم للبيع بسعر 300 ألف في المنصور", "sale", "444"),
  );
  await drain(f.env);
  await f.pair();
  const found = await f.command(
    "منو صاحب التخم مال 300 ألف بالمنصور؟",
    "search",
  );
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].seller.psid, "444");
  assert.equal(
    await f.command("منو صاحب التخم مال 300 ألف بالمنصور؟", "customer", "333"),
    null,
  );
  await f.webhook(
    event("منو صاحب التخم مال 300 ألف بالمنصور؟", "search", "222"),
  );
  assert.equal(
    f.sql
      .prepare("SELECT count(*) n FROM messenger_admin_jobs WHERE state='done'")
      .get().n,
    1,
  );
  const preview = await f.command(
    "خلي التخم مال 300 ألف بالمنصور مباع",
    "edit",
  );
  assert(preview.confirmation);
  assert.equal(
    f.sql.prepare("SELECT status FROM items").get().status,
    "unknown",
  );
  await f.command("أكد " + preview.confirmation, "confirm");
  assert.equal(f.sql.prepare("SELECT status FROM items").get().status, "sold");
  const available = await f.command(
    "خلي التخم مال 300 ألف بالمنصور متوفر",
    "unsell",
  );
  await f.command("أكد " + available.confirmation, "confirm-available");
  const item = f.sql.prepare("SELECT status,last_confirmed FROM items").get();
  assert.equal(item.status, "available");
  assert.equal(item.last_confirmed, null);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM outbox").get().n, 0);
});
test("revocation and stale item block actions; buyer offers still use separate memory and followups", async () => {
  const f = await setup();
  await receive(
    f.env,
    event("تخم للبيع بسعر 300 ألف في المنصور", "sale", "444"),
  );
  await drain(f.env);
  await f.pair();
  const preview = await f.command(
    "خلي التخم مال 300 ألف بالمنصور محجوز",
    "preview",
  );
  f.sql.exec("UPDATE items SET updated_at=updated_at+1");
  await f.command("أكد " + preview.confirmation, "stale");
  assert.equal(
    f.sql.prepare("SELECT status FROM items").get().status,
    "unknown",
  );
  await f.api("/api/messenger-admin/revoke");
  assert.equal(await f.command("منو صاحب التخم؟", "revoked"), null);
  assert.equal(
    f.sql
      .prepare(
        "SELECT count(*) n FROM messenger_admin_jobs WHERE state='pending'",
      )
      .get().n,
    0,
  );
  await f.webhook(event("عندي ثلاجة للبيع", "incomplete", "333"));
  await drain(f.env);
  await f.webhook(event("200 ألف", "price", "333"));
  await drain(f.env);
  assert.equal(
    f.sql.prepare("SELECT price_iqd FROM items WHERE title='ثلاجة'").get()
      .price_iqd,
    200000,
  );
});

test("admin delivery defaults off; explicit send only targets current bound admin inside window and cannot repeat", async () => {
  const f = await setup();
  await f.pair();
  await f.command("منو صاحب التخم؟", "send");
  let calls = 0;
  const sender = async (url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    assert.equal(payload.recipient.id, "222");
    assert.equal(payload.messaging_type, "RESPONSE");
    assert(!payload.tag);
    return Response.json({ message_id: "synthetic-meta-message" });
  };
  assert.equal(await sendMessengerAdmin(f.env, sender), 0);
  assert.equal(calls, 0);
  Object.assign(f.env, {
    ALLOW_SEND: "true",
    ALLOW_MESSENGER_ADMIN_SEND: "true",
    META_PAGE_TOKEN: "synthetic-test-token",
  });
  assert.equal(await sendMessengerAdmin(f.env, sender), 1);
  assert.equal(await sendMessengerAdmin(f.env, sender), 0);
  assert.equal(calls, 1);
});
test("revoked link and expired messaging window block private result delivery", async () => {
  const f = await setup();
  await f.pair();
  await f.command("منو صاحب التخم؟", "expired");
  Object.assign(f.env, {
    ALLOW_SEND: "true",
    ALLOW_MESSENGER_ADMIN_SEND: "true",
    META_PAGE_TOKEN: "synthetic",
  });
  f.sql.exec("UPDATE messenger_admin_jobs SET inbound_at=0");
  assert.equal(
    await sendMessengerAdmin(f.env, () => assert.fail("must not send")),
    0,
  );
  assert.equal(
    f.sql.prepare("SELECT delivery_state FROM messenger_admin_jobs").get()
      .delivery_state,
    "blocked",
  );
});
test("pairing requires recent Passkey login, expires without granting role, and never stores pairing text in seller memory", async () => {
  const f = await setup();
  f.sql.exec("UPDATE admin_sessions SET created_at=0");
  assert.equal((await f.api("/api/messenger-admin/pair/start")).status, 403);
  f.sql.prepare("UPDATE admin_sessions SET created_at=?").run(Date.now());
  const ticket = await (await f.api("/api/messenger-admin/pair/start")).json();
  await f.webhook(event(ticket.message, "private-pair", "222"));
  assert.equal(f.sql.prepare("SELECT count(*) n FROM events").get().n, 0);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM messages").get().n, 0);
  const inspect = await (
    await f.api("/api/messenger-admin/pair/inspect", { id: ticket.id })
  ).json();
  f.sql.exec("UPDATE messenger_pairings SET expires_at=0");
  assert.equal(
    (
      await f.api("/api/messenger-admin/pair/confirm", {
        id: ticket.id,
        fingerprint: inspect.fingerprint,
        confirmed: true,
      })
    ).status,
    404,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM messenger_admin_links").get().n,
    0,
  );
});
test("revoked admin cannot receive a previously prepared private reply", async () => {
  const f = await setup();
  await f.pair();
  await f.command("منو صاحب التخم؟", "private-result");
  Object.assign(f.env, {
    ALLOW_SEND: "true",
    ALLOW_MESSENGER_ADMIN_SEND: "true",
    META_PAGE_TOKEN: "synthetic",
  });
  await f.api("/api/messenger-admin/revoke");
  assert.equal(
    await sendMessengerAdmin(f.env, () =>
      assert.fail("revoked recipient must not receive"),
    ),
    0,
  );
});
