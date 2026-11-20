import { hash, seal, open, requireValue } from "./security.mjs";
import {
  extract,
  normalize,
  terms,
  questions,
  attachmentContext,
  followupFacts,
} from "./extract.mjs";
import { settings, indexItem, semantic, groundedExtract } from "./ai.mjs";
export const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
export async function receive(env, event, now = Date.now()) {
  requireValue(
    event?.sender?.id &&
      event.recipient?.id === env.PAGE_ID &&
      event.message?.mid &&
      typeof event.message.mid === "string",
    400,
    "invalid_message",
  );
  if (event.message.is_echo) return false;
  requireValue(
    /^\d{1,40}$/.test(event.sender.id) && event.message.mid.length <= 200,
    400,
    "invalid_identity",
  );
  requireValue(
    Number.isFinite(event.timestamp) &&
      event.timestamp > 0 &&
      event.timestamp <= now + 300000,
    400,
    "invalid_timestamp",
  );
  const id = await hash(env.PAGE_ID + ":" + event.message.mid);
  await stmt(
    env,
    "INSERT OR IGNORE INTO events(id,page_id,conversation_id,body_cipher,received_at) VALUES(?,?,?,?,?)",
    id,
    env.PAGE_ID,
    await hash(env.PAGE_ID + ":" + event.sender.id),
    await seal(env, event, env.PAGE_ID + ":event:" + id),
    Math.min(event.timestamp, now),
  ).run();
  return id;
}
export async function textSearch(env, query) {
  const t = terms(query).slice(0, 12);
  if (!t.length) return { items: [], limited: false };
  const match = t.map((x) => '"' + x.replaceAll('"', "") + '"').join(" OR ");
  const r = await stmt(
    env,
    "SELECT i.*,bm25(items_fts) AS rank FROM items_fts JOIN items i ON i.id=items_fts.id WHERE items_fts MATCH ? AND i.page_id=? AND i.status NOT IN('sold','withdrawn') ORDER BY rank LIMIT 31",
    match,
    env.PAGE_ID,
  ).all();
  return {
    items: r.results
      .slice(0, 30)
      .map((x) => ({ ...x, match_type: "text_candidate" })),
    limited: r.results.length > 30,
  };
}
async function enqueue(env, id, conv, kind, payload, now) {
  return stmt(
    env,
    "INSERT OR IGNORE INTO outbox(id,page_id,conversation_id,kind,payload_cipher,next_at) VALUES(?,?,?,?,?,?)",
    id,
    env.PAGE_ID,
    conv,
    kind,
    await seal(env, payload, env.PAGE_ID + ":outbox:" + id),
    now,
  );
}
export async function processEvent(env, row) {
  const e = await open(env, row.body_cipher, env.PAGE_ID + ":event:" + row.id);
  const now = row.received_at;
  const text = (typeof e.message.text === "string" ? e.message.text : "").slice(
    0,
    12000,
  );
  let facts = extract(text);
  const switches = await settings(env);
  if (switches.ai && env.ALLOW_AI === "true") {
    try {
      facts = await groundedExtract(env, text, facts);
    } catch {
      /* Budget/provider failure preserves rules extraction. */
    }
  }
  const sellerId = row.conversation_id,
    convId = sellerId;
  await env.DB.batch([
    stmt(
      env,
      "INSERT OR IGNORE INTO sellers(id,page_id,psid_cipher,created_at) VALUES(?,?,?,?)",
      sellerId,
      env.PAGE_ID,
      await seal(env, e.sender.id, env.PAGE_ID + ":seller:" + sellerId),
      now,
    ),
    stmt(
      env,
      "INSERT INTO conversations(id,page_id,seller_id,last_inbound) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_inbound=MAX(last_inbound,excluded.last_inbound)",
      convId,
      env.PAGE_ID,
      sellerId,
      now,
    ),
  ]);
  const conv = await stmt(
    env,
    "SELECT * FROM conversations WHERE id=? AND page_id=?",
    convId,
    env.PAGE_ID,
  ).first();
  let prior = conv.active_item
    ? await stmt(
        env,
        "SELECT * FROM items WHERE id=? AND page_id=?",
        conv.active_item,
        env.PAGE_ID,
      ).first()
    : null;
  const list = [
    stmt(
      env,
      "INSERT OR IGNORE INTO messages(id,page_id,conversation_id,text_cipher,intent,created_at) VALUES(?,?,?,?,?,?)",
      row.id,
      env.PAGE_ID,
      convId,
      await seal(env, text, env.PAGE_ID + ":message:" + row.id),
      facts.intent,
      now,
    ),
  ];
  const toggles = await settings(env);
  if (facts.intent === "financial") {
    list.push(
      stmt(
        env,
        "UPDATE conversations SET handoff=1 WHERE id=? AND page_id=?",
        convId,
        env.PAGE_ID,
      ),
    );
    if (toggles.alerts)
      list.push(
        await enqueue(
          env,
          "finance:" + row.id,
          convId,
          "alert",
          {
            type: "financial_handoff",
            conversation_id: convId,
            seller_id: sellerId,
          },
          now,
        ),
      );
  } else if (facts.intent === "buyer") {
    const search = facts.title || text;
    let matches = await textSearch(env, search);
    if (!matches.items.length && toggles.ai && env.ALLOW_AI === "true") {
      try {
        matches = await semantic(env, search);
      } catch {
        /* Text remains usable, no fabricated matches. */
      }
    }
    matches.items = matches.items.filter((x) => x.seller_id !== sellerId);
    for (const item of matches.items.slice(0, 5)) {
      const iid = await hash(row.id + ":" + item.id);
      list.push(
        stmt(
          env,
          "INSERT OR IGNORE INTO interests(id,page_id,buyer_id,item_id,message_id,created_at) VALUES(?,?,?,?,?,?)",
          iid,
          env.PAGE_ID,
          sellerId,
          item.id,
          row.id,
          now,
        ),
      );
      if (toggles.alerts)
        list.push(
          await enqueue(
            env,
            "interest:" + iid,
            convId,
            "alert",
            {
              type: "buyer_interest",
              item_id: item.id,
              seller_id: item.seller_id,
              buyer_id: sellerId,
              conversation_id: item.conversation_id,
              last_confirmed: item.last_confirmed,
              status: item.status,
              notice: "مطابقة مرشحة، يلزم تأكيد التوفر من البائع",
            },
            now,
          ),
        );
    }
    if (toggles.replies && !conv.handoff)
      list.push(
        await enqueue(
          env,
          "reply:" + row.id,
          convId,
          "reply",
          {
            text: matches.items.length
              ? "هلا بيك، عدنا أغراض محفوظة ممكن تناسب طلبك، بس نحتاج نتأكد من أصحابها إذا بعدها متوفرة."
              : "هلا بيك، ما لگينا مطابقة مؤكدة هسه. گولنا مواصفات الغرض والمنطقة حتى يراجعه المسؤول.",
            psid: e.sender.id,
          },
          now,
        ),
      );
  } else {
    const photoContext = attachmentContext(text);
    const attachments = (
      Array.isArray(e.message.attachments) ? e.message.attachments : []
    )
      .filter((a) => a.type === "image" && typeof a.payload?.url === "string")
      .slice(0, 6);
    const replyId = e.message.reply_to?.mid
      ? await hash(env.PAGE_ID + ":" + e.message.reply_to.mid)
      : null;
    const reference = replyId
      ? await stmt(
          env,
          "SELECT i.* FROM messages m JOIN items i ON i.id=m.item_id WHERE m.id=? AND m.conversation_id=? AND i.page_id=?",
          replyId,
          convId,
          env.PAGE_ID,
        ).first()
      : null;
    if (reference) prior = reference;
    const newOffer = /(للبيع|اريد ابيع|عندي.*للبيع)/.test(normalize(text));
    const priorText = prior
      ? await open(
          env,
          prior.description_cipher,
          env.PAGE_ID + ":item:" + prior.id,
        )
      : "";
    const repeatedOffer =
      prior &&
      (normalize(priorText).split("\n").includes(normalize(text).trim()) ||
        (facts.title &&
          normalize(facts.title) === normalize(prior.title || "") &&
          facts.price_iqd === prior.price_iqd &&
          facts.area === prior.area &&
          facts.condition === prior.condition));
    const explicitNew =
      /(غرض جديد|غرض ثاني|ثلاجه ثانيه|كاونتر ثاني|اعلان جديد|غير الغرض السابق)/.test(
        normalize(text),
      );
    const continuation =
      prior &&
      (!newOffer || !!reference || repeatedOffer || !prior.title) &&
      !explicitNew &&
      !photoContext.excluded &&
      now >= prior.updated_at &&
      (!facts.title ||
        !prior.title ||
        normalize(facts.title) === normalize(prior.title));
    if (continuation) facts = followupFacts(text, prior, facts);
    const saleEvidence = !photoContext.excluded && facts.intent === "seller";
    if (saleEvidence || continuation) {
      const itemId = continuation ? prior.id : await hash("item:" + row.id);
      const original = continuation
        ? await open(
            env,
            prior.description_cipher,
            env.PAGE_ID + ":item:" + itemId,
          )
        : "";
      const item = {
        title: facts.title || (continuation ? prior.title : null),
        price_iqd: facts.price_iqd ?? (continuation ? prior.price_iqd : null),
        area: facts.area || (continuation ? prior.area : null),
        condition: facts.condition || (continuation ? prior.condition : null),
      };
      if (!continuation) item.title = facts.title;
      const description = (
        normalize(original).split("\n").includes(normalize(text).trim())
          ? original
          : original + "\n" + text
      )
        .trim()
        .slice(-16000);
      const search = normalize(
        [
          item.title,
          item.area,
          item.condition,
          description
            .replace(/(?:\+?964|0)[\d٠-٩۰-۹\s,+()-]{7,}/g, " ")
            .replace(/https?:\/\/\S+/g, " "),
        ]
          .filter(Boolean)
          .join(" "),
      );
      list.push(
        stmt(
          env,
          `INSERT INTO items(id,page_id,seller_id,conversation_id,title,price_iqd,area,condition,description_cipher,search_text,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,price_iqd=excluded.price_iqd,area=excluded.area,condition=excluded.condition,description_cipher=excluded.description_cipher,search_text=excluded.search_text,updated_at=excluded.updated_at WHERE excluded.updated_at>=items.updated_at`,
          itemId,
          env.PAGE_ID,
          sellerId,
          convId,
          item.title,
          item.price_iqd,
          item.area,
          item.condition,
          await seal(env, description, env.PAGE_ID + ":item:" + itemId),
          search,
          now,
        ),
      );
      const statusText = normalize(text);
      const asserted = /(انباع|انباعت|تم البيع|مباع)/.test(statusText)
        ? "sold"
        : /(انحجز|محجوز)/.test(statusText)
          ? "reserved"
          : /(بعده متوفر|بعدها متوفره|ما زال متوفر|الغرض متوفر)/.test(
                statusText,
              )
            ? "available"
            : null;
      if (asserted && continuation)
        list.push(
          stmt(
            env,
            "UPDATE items SET status=?,last_confirmed=? WHERE id=? AND page_id=? AND updated_at<=?",
            asserted,
            now,
            itemId,
            env.PAGE_ID,
            now,
          ),
        );
      list.push(
        stmt(
          env,
          "UPDATE messages SET item_id=? WHERE id=? AND page_id=?",
          itemId,
          row.id,
          env.PAGE_ID,
        ),
      );
      list.push(
        stmt(
          env,
          "UPDATE conversations SET active_item=? WHERE id=? AND page_id=? AND last_inbound=?",
          itemId,
          convId,
          env.PAGE_ID,
          now,
        ),
      );
      let offeredAttachments = photoContext.excluded ? [] : attachments;
      // A later explicit confirmation can attach a previously unassigned photo message,
      // but never fetches/indexes it without administrator image review.
      if (
        !offeredAttachments.length &&
        (photoContext.confirmation || saleEvidence)
      ) {
        const candidates = await stmt(
          env,
          "SELECT e.*,m.item_id FROM events e JOIN messages m ON m.id=e.id WHERE e.conversation_id=? AND e.page_id=? AND m.item_id IS NULL AND e.id<>? AND e.received_at<=? ORDER BY e.received_at DESC LIMIT 3",
          convId,
          env.PAGE_ID,
          row.id,
          now,
        ).all();
        for (const candidate of candidates.results) {
          const previousEvent = await open(
            env,
            candidate.body_cipher,
            env.PAGE_ID + ":event:" + candidate.id,
          );
          if (attachmentContext(previousEvent.message?.text || "").excluded)
            continue;
          if (
            e.message.reply_to?.mid &&
            previousEvent.message?.mid !== e.message.reply_to.mid
          )
            continue;
          const pending = Array.isArray(previousEvent.message?.attachments)
            ? previousEvent.message.attachments.filter(
                (a) => a.type === "image" && typeof a.payload?.url === "string",
              )
            : [];
          if (pending.length) {
            offeredAttachments = pending.slice(0, 6);
            list.push(
              stmt(
                env,
                "UPDATE messages SET item_id=? WHERE id=? AND page_id=?",
                itemId,
                candidate.id,
                env.PAGE_ID,
              ),
            );
            break;
          }
        }
      }
      for (let i = 0; i < offeredAttachments.length; i++) {
        const mediaId = await hash(
          itemId + ":photo:" + offeredAttachments[i].payload.url,
        );
        list.push(
          stmt(
            env,
            "INSERT OR IGNORE INTO media(id,page_id,item_id,source_cipher,state) VALUES(?,?,?,?,'review')",
            mediaId,
            env.PAGE_ID,
            itemId,
            await seal(
              env,
              offeredAttachments[i].payload.url,
              env.PAGE_ID + ":media:" + mediaId,
            ),
          ),
        );
      }
      const existing = continuation
        ? (
            await stmt(
              env,
              "SELECT COUNT(*) AS n FROM media WHERE item_id=?",
              itemId,
            ).first()
          ).n
        : 0;
      const q = questions(item, existing + offeredAttachments.length);
      if (q && toggles.replies && !conv.handoff)
        list.push(
          await enqueue(
            env,
            "reply:" + row.id,
            convId,
            "reply",
            {
              psid: e.sender.id,
              text: "هلا بيك 🌹 حفظنا التفاصيل كمسودة خاصة. " + q,
            },
            now,
          ),
        );
    } else if (toggles.replies && !conv.handoff)
      list.push(
        await enqueue(
          env,
          "reply:" + row.id,
          convId,
          "reply",
          {
            psid: e.sender.id,
            text: photoContext.excluded
              ? "هذي الصورة ما راح نحفظها أو نفهرسها كغرض للبيع."
              : attachments.length
                ? "هل هاي الصور لغرض تريد تبيعه؟ اكتب نوع الغرض وگول صور الغرض للبيع. الصور الشخصية ما نحفظها كأغراض، وأي صورة تنتظر مراجعة قبل الفهرسة."
                : "هلا بيك، تريد تعرض غرض لو تدور على غرض؟ اكتب نوعه حتى ما نخلط تفاصيلك.",
          },
          now,
        ),
      );
  }
  list.push(
    stmt(
      env,
      "UPDATE events SET status='done',error=NULL WHERE id=? AND page_id=?",
      row.id,
      env.PAGE_ID,
    ),
  );
  await env.DB.batch(list);
}
export async function drain(env) {
  const owner = crypto.randomUUID(),
    now = Date.now();
  const lock = await stmt(
    env,
    "INSERT INTO processing_locks(page_id,owner,expires_at) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE expires_at<? RETURNING owner",
    env.PAGE_ID,
    owner,
    now + 300000,
    now,
  ).first();
  if (!lock) return 0;
  let processed = 0;
  try {
    const rows = await stmt(
      env,
      "SELECT * FROM events WHERE page_id=? AND status='pending' AND attempts<5 ORDER BY received_at LIMIT 20",
      env.PAGE_ID,
    ).all();
    for (const row of rows.results) {
      const lease = await stmt(
        env,
        "UPDATE processing_locks SET expires_at=? WHERE page_id=? AND owner=? RETURNING owner",
        Date.now() + 300000,
        env.PAGE_ID,
        owner,
      ).first();
      if (!lease) break;
      try {
        await processEvent(env, row);
        processed++;
      } catch {
        await stmt(
          env,
          "UPDATE events SET attempts=attempts+1,error='processing_failed' WHERE id=? AND status='pending'",
          row.id,
        ).run();
      }
    }
    return processed;
  } finally {
    await stmt(
      env,
      "DELETE FROM processing_locks WHERE page_id=? AND owner=?",
      env.PAGE_ID,
      owner,
    ).run();
  }
}
export async function itemView(env, item) {
  const seller = await stmt(
    env,
    "SELECT * FROM sellers WHERE id=? AND page_id=?",
    item.seller_id,
    env.PAGE_ID,
  ).first();
  const conv = await stmt(
    env,
    "SELECT inbox_url FROM conversations WHERE id=? AND page_id=?",
    item.conversation_id,
    env.PAGE_ID,
  ).first();
  const photos = await stmt(
    env,
    "SELECT id,state,approved FROM media WHERE item_id=? AND page_id=?",
    item.id,
    env.PAGE_ID,
  ).all();
  return {
    ...item,
    description_cipher: undefined,
    search_text: undefined,
    description: await open(
      env,
      item.description_cipher,
      env.PAGE_ID + ":item:" + item.id,
    ),
    seller: {
      id: seller.id,
      name: seller.name,
      psid: await open(
        env,
        seller.psid_cipher,
        env.PAGE_ID + ":seller:" + seller.id,
      ),
    },
    inbox_url: conv?.inbox_url || null,
    photos: photos.results,
    availability_notice: item.last_confirmed
      ? "آخر تأكيد مسجّل، وقد تتغير الحالة بعده"
      : "لم يتم تأكيد التوفر",
  };
}
