import {passkeyRoute} from "./passkeys.mjs";
import { authenticateAdmin } from "./admin-auth.mjs";
import { retrievalQuery, applyConstraints, groundedSelection } from "./retrieval.mjs";
import {
  Problem,
  requireValue,
  body,
  json,
  signature,
  equal,
  hash,
  inboxURL,
  open,
} from "./security.mjs";
import { receive, drain, textSearch, itemView, stmt, pageSize } from "./memory.mjs";
import { settings, semantic, caption, indexItem, indexPending } from "./ai.mjs";
import {
  savePhotos,
  photoBytes,
  imageType,
  indexPhotos,
  reviewPhotoBytes,
} from "./media.mjs";
import { sendPending } from "./outbox.mjs";
const audit = (env, action, target) =>
  stmt(
    env,
    "INSERT INTO audit(id,page_id,action,target,created_at) VALUES(?,?,?,?,?)",
    crypto.randomUUID(),
    env.PAGE_ID,
    action,
    target,
    Date.now(),
  );
async function admin(req, env) {
  await authenticateAdmin(req, env);
  const origin = req.headers.get("origin");
  requireValue(
    !origin || origin === new URL(req.url).origin,
    403,
    "origin_denied",
  );
}
async function data(req, max = 16384) {
  try {
    return JSON.parse(new TextDecoder().decode(await body(req, max)));
  } catch (e) {
    if (e instanceof Problem) throw e;
    throw new Problem(400, "invalid_json");
  }
}
async function route(req, env) {
  const url = new URL(req.url),
    path = url.pathname;
  if (env.ADMIN_AUTH_MODE === "passkey") {
    if(path.startsWith("/auth/"))return passkeyRoute(req,env);
    if(["/login","/passkey.js","/passkey.css"].includes(path)){
      requireValue(req.method==="GET",405);
      return env.ASSETS.fetch(new Request(new URL(path,url),req));
    }
    if(path==="/"){try{await admin(req,env);}catch(e){if(e.status===401)return new Response(null,{status:303,headers:{Location:"/login"}});throw e;}}
  }
  if (path === "/webhooks/meta/messenger") {
    requireValue(env.ALLOW_MESSENGER_INTAKE !== "false", 503, "messenger_intake_disabled");
    requireValue(env.PAGE_ID && env.DB, 503, "page_not_configured");
    if (req.method === "GET") {
      requireValue(
        env.META_VERIFY_TOKEN &&
          url.searchParams.get("hub.mode") === "subscribe" &&
          (await equal(
            url.searchParams.get("hub.verify_token") || "",
            env.META_VERIFY_TOKEN,
          )),
        403,
        "verification_failed",
      );
      const c = url.searchParams.get("hub.challenge");
      requireValue(c && c.length <= 200);
      return new Response(c, { headers: { "Cache-Control": "no-store" } });
    }
    requireValue(req.method === "POST", 405);
    const raw = await body(req);
    requireValue(
      await signature(
        raw,
        env.META_APP_SECRET,
        req.headers.get("x-hub-signature-256"),
      ),
      401,
      "invalid_signature",
    );
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new Problem(400, "invalid_json");
    }
    requireValue(
      payload.object === "page" &&
        Array.isArray(payload.entry) &&
        payload.entry.length <= 100,
      400,
    );
    for (const entry of payload.entry) {
      requireValue(
        entry.id === env.PAGE_ID &&
          Array.isArray(entry.messaging) &&
          entry.messaging.length <= 100,
        403,
        "page_denied",
      );
      for (const e of entry.messaging) {
        if (e.message && !e.message.is_echo) await receive(env, e);
      }
    }
    return json({ received: true });
  }
  if (!path.startsWith("/api/")) {
    if ((env.ADMIN_AUTH_MODE === "access" || env.ADMIN_AUTH_MODE === "passkey") || env.FREE_ONLY === "true") await admin(req,env);
    requireValue(req.method === "GET", 405);
    requireValue(["/", "/admin.js", "/admin.css", "/viewport.js"].includes(path), 404);
    requireValue(env.ASSETS, 503, "assets_not_configured");
    return env.ASSETS.fetch(
      new Request(new URL(path, url), req),
    );
  }
  await admin(req, env);
  requireValue(env.DB && env.PAGE_ID, 503, "database_not_configured");
  if (path === "/api/assistant" && req.method === "POST") {
    const d = await data(req, 4096);
    requireValue(typeof d.query === "string" && d.query.trim().length > 0 && d.query.length <= 400);
    const facts = retrievalQuery(d.query);
    // An object must be identified: never fall back to a broad private-owner dump.
    requireValue(facts.title, 400, "object_required");
    const found = await textSearch(env, facts.title);
    const candidates = applyConstraints(found.items, facts, {exactPrice:true});
    const selection = await groundedSelection(env, d.query, candidates);
    const items = await Promise.all(selection.items.map(i=>itemView(env,i)));
    await audit(env, "admin_memory_lookup", "assistant").run();
    return json({items, engine:selection.engine, usage:selection.usage, limited:found.limited,
      answer:items.length ? "هاي السجلات المطابقة المحفوظة وأصحابها؛ التوفر يحتاج مراجعة آخر تأكيد." : "ما لگيت سجل مطابق للمعلومات المذكورة، وما أگدر أخمّن صاحبه."});
  }
  if (path === "/api/settings" && req.method === "GET")
    return json({
      ...(await settings(env)),
      authentication: env.ADMIN_AUTH_MODE || "local_bearer",
      capabilities: {
        ai: env.ALLOW_AI === "true" && !!env.AI,
        photos: env.ALLOW_MEDIA === "true" && !!env.PHOTOS,
        replies: env.ALLOW_SEND === "true",
        alerts: env.ALLOW_ALERT_SEND === "true",
      },
    });
  if (path === "/api/settings" && req.method === "PATCH") {
    const d = await data(req);
    const old = await settings(env);
    for (const k of Object.keys(d))
      requireValue(
        ["replies", "alerts", "ai", "photos"].includes(k) &&
          typeof d[k] === "boolean",
      );
    const merged = { ...old, ...d };
    await env.DB.batch([
      stmt(
        env,
        "INSERT INTO settings(page_id,replies,alerts,ai,photos) VALUES(?,?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET replies=excluded.replies,alerts=excluded.alerts,ai=excluded.ai,photos=excluded.photos",
        env.PAGE_ID,
        +merged.replies,
        +merged.alerts,
        +merged.ai,
        +merged.photos,
      ),
      audit(env, "settings_changed", "settings"),
    ]);
    return json({ ok: true });
  }
  if (path === "/api/items" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").slice(0, 200);
    const seller = url.searchParams.get("seller");
    let found;
    if (q) found = await textSearch(env, q);
    else {
      const offset = Math.max(
        0,
        Math.min(10000, Number(url.searchParams.get("offset")) || 0),
      );
      const r = await stmt(
        env,
        "SELECT * FROM items WHERE page_id=? AND (? IS NULL OR seller_id=?) ORDER BY updated_at DESC LIMIT ? OFFSET ?",
        env.PAGE_ID,
        seller,
        seller,
        pageSize(env)+1,
        offset,
      ).all();
      found = {
        items: r.results.slice(0, pageSize(env)),
        limited: r.results.length > pageSize(env),
        next_offset: r.results.length > pageSize(env) ? offset + pageSize(env) : null,
      };
    }
    return json({
      ...found,
      items: await Promise.all(found.items.map((x) => itemView(env, x))),
    });
  }
  if (path === "/api/sellers" && req.method === "GET") {
    const r = await stmt(
      env,
      "SELECT s.id,s.name,s.created_at,COUNT(i.id) AS item_count FROM sellers s LEFT JOIN items i ON i.seller_id=s.id AND i.page_id=s.page_id WHERE s.page_id=? GROUP BY s.id HAVING COUNT(i.id)>0 ORDER BY s.created_at DESC LIMIT 100",
      env.PAGE_ID,
    ).all();
    return json({ sellers: r.results, limit: 100 });
  }
  if (path === "/api/interests" && req.method === "GET") {
    const r = await stmt(
      env,
      "SELECT n.*,i.title,i.seller_id,i.conversation_id,i.status,i.last_confirmed,s.name,c.inbox_url FROM interests n JOIN items i ON i.id=n.item_id JOIN sellers s ON s.id=i.seller_id JOIN conversations c ON c.id=i.conversation_id WHERE n.page_id=? ORDER BY n.created_at DESC LIMIT 100",
      env.PAGE_ID,
    ).all();
    return json({ interests: r.results });
  }
  if (path === "/api/operations" && req.method === "GET") {
    const r = await stmt(
      env,
      "SELECT id,kind,state,attempts,error,next_at FROM outbox WHERE page_id=? ORDER BY next_at DESC LIMIT 100",
      env.PAGE_ID,
    ).all();
    const e = await stmt(
      env,
      "SELECT id,status,attempts,error FROM events WHERE page_id=? ORDER BY received_at DESC LIMIT 100",
      env.PAGE_ID,
    ).all();
    return json({ outbox: r.results, events: e.results });
  }
  if (path === "/api/search" && req.method === "POST") {
    const d = await data(req, 3000000);
    requireValue(["semantic", "image"].includes(d.mode));
    let query = d.query;
    if (d.mode === "image") {
      requireValue(typeof d.image === "string" && d.image.length < 2800000);
      let image;
      try {
        image = Uint8Array.from(atob(d.image), (c) => c.charCodeAt(0));
      } catch {
        throw new Problem(400, "invalid_image");
      }
      requireValue(
        image.length <= 2097152 && imageType(image),
        415,
        "unsupported_image",
      );
      query = await caption(env, image);
    }
    requireValue(
      typeof query === "string" && query.length > 0 && query.length <= 2000,
    );
    const found = await semantic(env, query);
    return json({
      ...found,
      notice:
        "مطابقات تقريبية للمراجعة، البحث بالصورة يعتمد وصفاً بصرياً وليس إثبات تطابق أو ملكية",
      items: await Promise.all(found.items.map((i) => itemView(env, i))),
    });
  }
  if (path === "/api/process" && req.method === "POST") {
    await data(req);
    const count = await drain(env);
    return json({
      processed: count,
      photos: await savePhotos(env),
      sent: await sendPending(env),
      ai: await indexPending(env),
    });
  }
  const review = path.match(/^\/api\/photos\/([a-f0-9]{64})\/review$/);
  if (review && req.method === "GET") {
    const bytes = await reviewPhotoBytes(env, review[1]);
    return new Response(bytes, {
      headers: {
        "Content-Type": imageType(bytes),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (review && req.method === "PATCH") {
    const d = await data(req);
    requireValue(
      ["sale_item", "personal", "unrelated"].includes(d.classification) &&
        d.confirmed === true,
      400,
      "image_review_required",
    );
    const row = await stmt(
      env,
      "SELECT id,item_id,object_key,state FROM media WHERE id=? AND page_id=?",
      review[1],
      env.PAGE_ID,
    ).first();
    requireValue(row, 404, "photo_not_found");
    await env.DB.batch([
      stmt(
        env,
        "UPDATE media SET approved=?,state=? WHERE id=? AND page_id=?",
        d.classification === "sale_item" ? 1 : 0,
        d.classification === "sale_item"
          ? row.object_key
            ? "stored"
            : "pending"
          : "rejected",
        review[1],
        env.PAGE_ID,
      ),
      ...(d.classification !== "sale_item"
        ? [
            stmt(
              env,
              "UPDATE embeddings SET model=model||':review_required' WHERE item_id=? AND page_id=?",
              row.item_id,
              env.PAGE_ID,
            ),
          ]
        : []),
      audit(env, "image_review_" + d.classification, review[1]),
    ]);
    return json({ ok: true });
  }
  const photo = path.match(/^\/api\/photos\/([a-f0-9]{64})$/);
  if (photo && req.method === "GET") {
    const bytes = await photoBytes(env, photo[1]);
    return new Response(bytes, {
      headers: {
        "Content-Type": imageType(bytes),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  const item = path.match(/^\/api\/items\/([a-f0-9]{64})(?:\/(index))?$/);
  if (item) {
    const id = item[1];
    const row = await stmt(
      env,
      "SELECT * FROM items WHERE id=? AND page_id=?",
      id,
      env.PAGE_ID,
    ).first();
    requireValue(row, 404, "item_not_found");
    if (item[2] && req.method === "POST") {
      const d = await data(req);
      if (d.photos) return json(await indexPhotos(env, id));
      await indexItem(env, row);
      return json({ indexed: true });
    }
    if (req.method === "PATCH") {
      const d = await data(req);
      requireValue(
        Object.keys(d).every((k) =>
          [
            "status",
            "confirmed",
            "inbox_url",
            "name",
            "resume",
            "reviewed",
          ].includes(k),
        ),
      );
      const list = [];
      if (d.status !== undefined) {
        requireValue(
          ["unknown", "available", "reserved", "sold", "withdrawn"].includes(
            d.status,
          ),
        );
        requireValue(
          d.status !== "available" || d.confirmed === true,
          400,
          "confirmation_required",
        );
        list.push(
          stmt(
            env,
            "UPDATE items SET status=?,last_confirmed=?,review=? WHERE id=? AND page_id=?",
            d.status,
            d.confirmed === true ? Date.now() : null,
            d.reviewed === true ? 0 : 1,
            id,
            env.PAGE_ID,
          ),
        );
      }
      if (d.name !== undefined) {
        requireValue(
          typeof d.name === "string" &&
            d.name.trim().length > 0 &&
            d.name.length <= 100,
        );
        list.push(
          stmt(
            env,
            "UPDATE sellers SET name=? WHERE id=? AND page_id=?",
            d.name.trim(),
            row.seller_id,
            env.PAGE_ID,
          ),
        );
      }
      if (d.inbox_url !== undefined)
        list.push(
          stmt(
            env,
            "UPDATE conversations SET inbox_url=? WHERE id=? AND page_id=?",
            inboxURL(d.inbox_url),
            row.conversation_id,
            env.PAGE_ID,
          ),
        );
      if (d.resume !== undefined) {
        requireValue(typeof d.resume === "boolean");
        list.push(
          stmt(
            env,
            "UPDATE conversations SET handoff=? WHERE id=? AND page_id=?",
            d.resume ? 0 : 1,
            row.conversation_id,
            env.PAGE_ID,
          ),
        );
      }
      list.push(audit(env, "item_reviewed", id));
      await env.DB.batch(list);
      return json({ ok: true });
    }
  }
  throw new Problem(404, "not_found");
}
export default {
  async fetch(req, env, ctx) {
    try {
      const response = await route(req, env);
      if (
        response.ok &&
        req.method === "POST" &&
        new URL(req.url).pathname === "/webhooks/meta/messenger" &&
        ctx?.waitUntil
      )
        ctx.waitUntil(
          (async () => {
            await drain(env);
            await indexPending(env);
            await savePhotos(env);
            await sendPending(env);
          })().catch(() => {
            /* Durable events/outbox remain for scheduled recovery; never log customer content. */
          }),
        );
      const h = new Headers(response.headers);
      h.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
      h.set("X-Frame-Options", "DENY");
      h.set("Referrer-Policy", "no-referrer");
      h.set("Permissions-Policy", "publickey-credentials-create=(self), publickey-credentials-get=(self)");
      h.set("X-Content-Type-Options", "nosniff");
      h.set("Cache-Control", "no-store");
      return new Response(response.body, {
        status: response.status,
        headers: h,
      });
    } catch (e) {
      return json(
        { error: e instanceof Problem ? e.message : "internal_error" },
        e instanceof Problem ? e.status : 500,
      );
    }
  },
  async scheduled(_event, env) {
    await drain(env);
    await savePhotos(env);
    await indexPending(env);
    await sendPending(env);
  },
};
