import test from "node:test";
import assert from "node:assert/strict";
import { fixture, event, image, req } from "./helpers.mjs";
import { receive, drain, itemView, textSearch } from "../src/memory.mjs";
import { savePhotos, indexPhotos } from "../src/media.mjs";
import { open } from "../src/security.mjs";
import worker from "../src/worker.mjs";
const first = (sql) => sql.prepare("SELECT * FROM items").get();
const count = (sql) => sql.prepare("SELECT count(*) n FROM items").get().n;
async function message(env, e) {
  await receive(env, e);
  await drain(env);
}

test("incomplete sale with no title is saved immediately; each natural answer updates the same draft beyond 24h", async () => {
  const { env, sql } = fixture();
  const initial = event("عندي غرض للبيع", "m1");
  initial.timestamp = Date.now() - 3 * 86400000;
  await message(env, initial);
  const id = first(sql).id;
  assert.equal(first(sql).title, null);
  assert.equal(first(sql).price_iqd, null);
  await message(env, event("ثلاجة", "m2"));
  await message(env, event("٣٠٠ ألف", "m3"));
  await message(env, event("المنصور", "m4"));
  await message(env, event("مستعملة", "m5"));
  assert.equal(count(sql), 1);
  const i = first(sql);
  assert.equal(i.id, id);
  assert.equal(i.title, "ثلاجة");
  assert.equal(i.price_iqd, 300000);
  assert.equal(i.area, "المنصور");
  assert.equal(i.condition, "مستعمل");
  assert.equal(i.status, "unknown");
  assert.equal(i.last_confirmed, null);
  const v = await itemView(env, i);
  assert.equal(v.seller.psid, "222");
  assert(v.conversation_id);
  assert.equal(v.seller.name, null);
});
test("duplicate event and repeated sale wording with new message id do not create duplicate items or photos", async () => {
  const { env, sql } = fixture();
  const e = event("ثلاجة للبيع", "m1", "222", [
    image("https://cdn.fbcdn.net/a.jpg"),
  ]);
  await message(env, e);
  await message(env, e);
  await message(
    env,
    event("ثلاجة للبيع", "m2", "222", [image("https://cdn.fbcdn.net/a.jpg")]),
  );
  assert.equal(count(sql), 1);
  assert.equal(sql.prepare("SELECT count(*) n FROM media").get().n, 1);
  assert.equal((await itemView(env, first(sql))).description, "ثلاجة للبيع");
});
test("explicit second item creates a separate draft without overwriting the first", async () => {
  const { env, sql } = fixture();
  await message(env, event("ثلاجة للبيع", "m1"));
  await message(env, event("ثلاجة ثانية للبيع", "m2"));
  assert.equal(count(sql), 2);
});
test("unexplained photos never create sale items; explicit later sale keeps attachment pending review", async () => {
  const { env, sql } = fixture();
  await message(
    env,
    event("", "photo", "222", [image("https://cdn.fbcdn.net/unknown.jpg")]),
  );
  assert.equal(count(sql), 0);
  assert.equal(sql.prepare("SELECT count(*) n FROM media").get().n, 0);
  await message(env, event("هاي صور ثلاجة للبيع", "sale"));
  assert.equal(count(sql), 1);
  const m = sql.prepare("SELECT * FROM media").get();
  assert.equal(m.state, "review");
  assert.equal(m.approved, 0);
  assert.equal(m.object_key, null);
});
test("explicit personal or non-sale attachments do not become items even during a sale conversation", async () => {
  const { env, sql } = fixture();
  await message(
    env,
    event("صورتي الشخصية", "p1", "222", [
      image("https://cdn.fbcdn.net/person.jpg"),
    ]),
  );
  assert.equal(count(sql), 0);
  await message(env, event("ثلاجة للبيع", "sale"));
  await message(
    env,
    event("هذي صور عائلتي", "p2", "222", [
      image("https://cdn.fbcdn.net/family.jpg"),
    ]),
  );
  await message(
    env,
    event("كرسي مو للبيع", "p3", "222", [
      image("https://cdn.fbcdn.net/other.jpg"),
    ]),
  );
  assert.equal(count(sql), 1);
  assert.equal(sql.prepare("SELECT count(*) n FROM media").get().n, 0);
});
test("photo-only followup attaches to existing draft as unreviewed and never triggers download or AI", async () => {
  const { env, sql } = fixture();
  await message(env, event("غسالة للبيع", "m1"));
  await message(
    env,
    event("", "m2", "222", [image("https://cdn.fbcdn.net/appliance.jpg")]),
  );
  assert.equal(count(sql), 1);
  sql
    .prepare("INSERT INTO settings(page_id,photos,ai) VALUES(?,?,?)")
    .run("111", 1, 1);
  env.ALLOW_MEDIA = "true";
  env.ALLOW_AI = "true";
  let calls = 0;
  env.PHOTOS = {
    put: async () => {
      calls++;
    },
  };
  env.AI = {
    run: async () => {
      calls++;
    },
  };
  assert.equal(
    await savePhotos(env, async () => {
      calls++;
    }),
    0,
  );
  await indexPhotos(env, first(sql).id).catch(() => {});
  assert.equal(calls, 0);
  assert.equal(sql.prepare("SELECT state FROM media").get().state, "review");
});
test("review endpoints are protected and rejection never permits storage or image indexing", async () => {
  const { env, sql } = fixture();
  await message(
    env,
    event("ثلاجة للبيع", "m1", "222", [
      image("https://cdn.fbcdn.net/person.jpg"),
    ]),
  );
  const m = sql.prepare("SELECT * FROM media").get();
  assert.equal(
    (
      await worker.fetch(
        new Request("https://x/api/photos/" + m.id + "/review"),
        env,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await worker.fetch(
        req(env, "/api/photos/" + m.id + "/review", "PATCH", {
          classification: "sale_item",
        }),
        env,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        req(env, "/api/photos/" + m.id + "/review", "PATCH", {
          classification: "personal",
          confirmed: true,
        }),
        env,
      )
    ).status,
    200,
  );
  assert.equal(sql.prepare("SELECT state FROM media").get().state, "rejected");
  assert.equal(sql.prepare("SELECT approved FROM media").get().approved, 0);
  assert.equal(first(sql).publish_consent, 0);
  env.PAGE_ID = "999";
  assert.equal(
    (
      await worker.fetch(
        req(env, "/api/photos/" + m.id + "/review", "PATCH", {
          classification: "sale_item",
          confirmed: true,
        }),
        env,
      )
    ).status,
    404,
  );
});
test("owner retrieval by description and buyer alert retain the actual last confirmation, not a new availability promise", async () => {
  const { env, sql } = fixture();
  sql
    .prepare("INSERT INTO settings(page_id,alerts,replies) VALUES(?,?,?)")
    .run("111", 1, 1);
  await message(env, event("كاونتر خشب بني للبيع", "sale"));
  const i = first(sql);
  const confirmed = Date.now() - 2 * 86400000;
  sql
    .prepare("UPDATE items SET status='available',last_confirmed=? WHERE id=?")
    .run(confirmed, i.id);
  const found = await textSearch(env, "خشب بني");
  assert.equal((await itemView(env, found.items[0])).seller.psid, "222");
  await message(env, event("اريد كاونتر", "buyer", "333"));
  const a = sql.prepare("SELECT * FROM outbox WHERE kind='alert'").get();
  const p = await open(env, a.payload_cipher, "111:outbox:" + a.id);
  assert.equal(p.item_id, i.id);
  assert.equal(p.seller_id, i.seller_id);
  assert.equal(p.last_confirmed, confirmed);
  assert.match(p.notice, /تأكيد التوفر/);
});

test("rejecting a previously indexed attachment invalidates its visual vector without deleting the item", async () => {
  const { env, sql } = fixture();
  await message(
    env,
    event("ثلاجة للبيع", "m1", "222", [
      image("https://cdn.fbcdn.net/test.jpg"),
    ]),
  );
  const i = first(sql),
    m = sql.prepare("SELECT id FROM media").get();
  sql
    .prepare(
      "INSERT INTO embeddings(item_id,page_id,model,vector_cipher,updated_at) VALUES(?,?,?,?,?)",
    )
    .run(
      i.id,
      "111",
      "@cf/baai/bge-m3",
      "test-encrypted-placeholder",
      Date.now(),
    );
  const r = await worker.fetch(
    req(env, "/api/photos/" + m.id + "/review", "PATCH", {
      classification: "unrelated",
      confirmed: true,
    }),
    env,
  );
  assert.equal(r.status, 200);
  assert.match(
    sql.prepare("SELECT model FROM embeddings").get().model,
    /review_required/,
  );
  assert.equal(count(sql), 1);
});
