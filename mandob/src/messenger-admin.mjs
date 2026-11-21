import { hash, seal, open, requireValue, json } from "./security.mjs";
import { passkeySession } from "./passkeys.mjs";
import { normalize } from "./extract.mjs";
import { retrievalQuery, applyConstraints } from "./retrieval.mjs";
import { textSearch, itemView } from "./memory.mjs";
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
export async function allowedMetaSender(env, e) {
  requireValue(
    ["test", "public"].includes(env.MESSENGER_INTAKE_MODE),
    503,
    "messenger_mode_required",
  );
  requireValue(
    /^\d{1,40}$/.test(e.sender?.id || "") &&
      e.recipient?.id === env.PAGE_ID &&
      typeof e.message?.mid === "string" &&
      e.message.mid.length <= 200 &&
      Number.isFinite(e.timestamp) &&
      e.timestamp > 0 &&
      e.timestamp <= Date.now() + 300000,
    400,
    "invalid_message",
  );
  if (env.MESSENGER_INTAKE_MODE === "public") {
    requireValue(
      env.ALLOW_MESSENGER_PUBLIC === "true",
      503,
      "public_intake_disabled",
    );
    return true;
  }
  const list = (env.META_TEST_SENDER_HASHES || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  requireValue(
    list.length > 0 &&
      list.length <= 20 &&
      list.every((x) => /^[a-f0-9]{64}$/.test(x)),
    503,
    "test_sender_list_required",
  );
  return list.includes(await hash(env.PAGE_ID + ":" + e.sender.id));
}
async function linked(env, psidHash) {
  return env.DB.prepare(
    "SELECT l.* FROM messenger_admin_links l JOIN admin_credentials c ON c.id=l.credential_id WHERE l.slot=1 AND l.page_id=? AND l.psid_hash=? AND l.revoked_at IS NULL",
  )
    .bind(env.PAGE_ID, psidHash)
    .first();
}
export async function messengerPairingAPI(req, env, d) {
  requireValue(
    env.ADMIN_AUTH_MODE === "passkey" && env.ALLOW_MESSENGER_ADMIN === "true",
    503,
    "messenger_admin_disabled",
  );
  const session = await passkeySession(req, env);
  const path = new URL(req.url).pathname;
  if (path === "/api/messenger-admin/status") {
    const l = await env.DB.prepare(
      "SELECT created_at,revoked_at FROM messenger_admin_links WHERE slot=1 AND page_id=? AND credential_id=?",
    )
      .bind(env.PAGE_ID, session.credential_id)
      .first();
    return json({ linked: !!l && !l.revoked_at, link: l });
  }
  requireValue(
    Date.now() - session.created_at < 300000,
    403,
    "recent_passkey_login_required",
  );
  if (path === "/api/messenger-admin/pair/start") {
    requireValue(
      /^[a-f0-9]{64}$/.test(env.META_ADMIN_EXPECTED_PSID_HASH || ""),
      503,
      "admin_meta_candidate_required",
    );
    const active = await env.DB.prepare(
      "SELECT count(*) n FROM messenger_pairings WHERE page_id=? AND expires_at>? AND status IN('pending','claimed')",
    )
      .bind(env.PAGE_ID, Date.now())
      .first();
    requireValue(active.n < 3, 429, "pairing_limit");
    const id = crypto.randomUUID(),
      secret = random(),
      expires = Date.now() + 300000;
    await env.DB.prepare(
      "INSERT INTO messenger_pairings(id,page_id,credential_id,secret_hash,expected_hash,expires_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        id,
        env.PAGE_ID,
        session.credential_id,
        await hash(secret),
        env.META_ADMIN_EXPECTED_PSID_HASH,
        expires,
      )
      .run();
    return json({
      id,
      expires_at: expires,
      message: `ربط الإدارة ${id} ${secret}`,
      notice:
        "انسخ هذه الرسالة إلى محادثتك مع الصفحة فقط، ولا ترسلها إلى ChatGPT أو أي شخص.",
    });
  }
  if (
    path === "/api/messenger-admin/pair/inspect" ||
    path === "/api/messenger-admin/pair/confirm"
  ) {
    const p = await env.DB.prepare(
      "SELECT * FROM messenger_pairings WHERE id=? AND page_id=? AND credential_id=? AND expires_at>? AND status='claimed'",
    )
      .bind(
        typeof d.id === "string" ? d.id : "",
        env.PAGE_ID,
        session.credential_id,
        Date.now(),
      )
      .first();
    requireValue(p, 404, "pairing_claim_missing");
    const fingerprint = await hash(
      env.PAGE_ID + ":" + p.id + ":" + p.claimed_hash,
    );
    if (path.endsWith("inspect"))
      return json({
        id: p.id,
        fingerprint,
        expires_at: p.expires_at,
        notice:
          "تأكد أنك أرسلت رسالة الربط من حسابك أنت. هذا الربط يمنحه صلاحية قراءة بيانات الإدارة.",
      });
    requireValue(
      d.fingerprint === fingerprint && d.confirmed === true,
      403,
      "pairing_confirmation_required",
    );
    const psid = await open(
      env,
      p.claimed_cipher,
      env.PAGE_ID + ":pair:" + p.id,
    );
    const r = await env.DB.prepare(
      "INSERT INTO messenger_admin_links(slot,page_id,credential_id,psid_hash,psid_cipher,created_at) SELECT 1,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM messenger_pairings WHERE id=? AND status='claimed' AND expires_at>?) AND NOT EXISTS(SELECT 1 FROM messenger_admin_links WHERE revoked_at IS NULL) ON CONFLICT(slot) DO UPDATE SET page_id=excluded.page_id,credential_id=excluded.credential_id,psid_hash=excluded.psid_hash,psid_cipher=excluded.psid_cipher,created_at=excluded.created_at,revoked_at=NULL WHERE messenger_admin_links.revoked_at IS NOT NULL RETURNING slot",
    )
      .bind(
        env.PAGE_ID,
        session.credential_id,
        p.claimed_hash,
        await seal(env, psid, env.PAGE_ID + ":admin-link"),
        Date.now(),
        p.id,
        Date.now(),
      )
      .first();
    requireValue(r, 409, "admin_link_exists");
    await env.DB.prepare(
      "UPDATE messenger_pairings SET status='confirmed' WHERE id=?",
    )
      .bind(p.id)
      .run();
    return json({ linked: true });
  }
  if (path === "/api/messenger-admin/revoke") {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE messenger_admin_links SET revoked_at=? WHERE page_id=? AND credential_id=?",
      ).bind(Date.now(), env.PAGE_ID, session.credential_id),
      env.DB.prepare(
        "UPDATE messenger_pairings SET status='revoked' WHERE page_id=? AND credential_id=?",
      ).bind(env.PAGE_ID, session.credential_id),
      env.DB.prepare(
        "UPDATE messenger_admin_jobs SET state='cancelled' WHERE page_id=? AND state IN('pending','processing')",
      ).bind(env.PAGE_ID),
      env.DB.prepare(
        "UPDATE messenger_admin_actions SET state='cancelled' WHERE page_id=? AND state='pending'",
      ).bind(env.PAGE_ID),
    ]);
    return json({ revoked: true });
  }
  return null;
}
// Called ONLY after raw-body Meta HMAC, Page and test-sender checks.
export async function messengerControl(env, e) {
  if (env.ALLOW_MESSENGER_ADMIN !== "true") return false;
  const text = typeof e.message.text === "string" ? e.message.text.trim() : "";
  const senderHash = await hash(env.PAGE_ID + ":" + e.sender.id);
  const pair = /^ربط الإدارة ([a-f0-9-]{36}) ([a-f0-9]{64})$/.exec(text);
  if (pair) {
    const p = await env.DB.prepare(
      "SELECT id FROM messenger_pairings WHERE id=? AND page_id=? AND secret_hash=? AND expected_hash=? AND status='pending' AND expires_at>?",
    )
      .bind(pair[1], env.PAGE_ID, await hash(pair[2]), senderHash, Date.now())
      .first();
    if (p)
      await env.DB.prepare(
        "UPDATE messenger_pairings SET status='claimed',claimed_hash=?,claimed_cipher=?,claimed_at=? WHERE id=? AND status='pending' AND expires_at>?",
      )
        .bind(
          senderHash,
          await seal(env, e.sender.id, env.PAGE_ID + ":pair:" + p.id),
          Date.now(),
          p.id,
          Date.now(),
        )
        .run();
    return true;
  }
  const l = await linked(env, senderHash);
  if (!l)
    return /^(منو صاحب|حدث حاله|خل.?يه|اكد |أكد |اني المدير|انا المدير)/.test(
      normalize(text),
    );
  if (Date.now() - e.timestamp > 300000) return true;
  const id = await hash(env.PAGE_ID + ":admin:" + e.message.mid);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO messenger_admin_jobs(id,page_id,psid_hash,command_cipher,created_at,inbound_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      id,
      env.PAGE_ID,
      senderHash,
      await seal(env, text.slice(0, 1000), env.PAGE_ID + ":admin-job:" + id),
      Date.now(),
      e.timestamp,
    )
    .run();
  return true;
}
export async function processMessengerAdmin(env) {
  if (env.ALLOW_MESSENGER_ADMIN !== "true") return 0;
  await env.DB.prepare(
    "UPDATE messenger_admin_jobs SET state='cancelled' WHERE page_id=? AND state='processing' AND created_at<?",
  )
    .bind(env.PAGE_ID, Date.now() - 300000)
    .run();
  const row = await env.DB.prepare(
    "SELECT * FROM messenger_admin_jobs WHERE page_id=? AND state='pending' ORDER BY created_at LIMIT 1",
  )
    .bind(env.PAGE_ID)
    .first();
  if (!row) return 0;
  const claim = await env.DB.prepare(
    "UPDATE messenger_admin_jobs SET state='processing' WHERE id=? AND state='pending' RETURNING id",
  )
    .bind(row.id)
    .first();
  if (!claim) return 0;
  if (
    !(await linked(env, row.psid_hash)) ||
    Date.now() - row.created_at > 300000
  ) {
    await env.DB.prepare(
      "UPDATE messenger_admin_jobs SET state='cancelled' WHERE id=?",
    )
      .bind(row.id)
      .run();
    return 0;
  }
  const text = await open(
      env,
      row.command_cipher,
      env.PAGE_ID + ":admin-job:" + row.id,
    ),
    n = normalize(text);
  let result;
  const confirmation = /^اكد ([a-f0-9-]{36})$/.exec(n);
  if (confirmation) {
    const action = await env.DB.prepare(
      "SELECT * FROM messenger_admin_actions WHERE id=? AND page_id=? AND psid_hash=? AND state='pending' AND expires_at>?",
    )
      .bind(confirmation[1], env.PAGE_ID, row.psid_hash, Date.now())
      .first();
    if (!action)
      result = { text: "التأكيد منتهي أو غير صالح، اطلب التحديث من جديد." };
    else {
      const updated = await env.DB.prepare(
        "UPDATE items SET status=?,last_confirmed=NULL,updated_at=? WHERE id=? AND page_id=? AND updated_at=? AND EXISTS(SELECT 1 FROM messenger_admin_actions WHERE id=? AND state='pending' AND expires_at>?) AND EXISTS(SELECT 1 FROM messenger_admin_links l JOIN admin_credentials c ON c.id=l.credential_id WHERE l.page_id=? AND l.psid_hash=? AND l.revoked_at IS NULL) RETURNING id",
      )
        .bind(
          action.status,
          Date.now(),
          action.item_id,
          env.PAGE_ID,
          action.expected_updated_at,
          action.id,
          Date.now(),
          env.PAGE_ID,
          row.psid_hash,
        )
        .first();
      await env.DB.prepare(
        "UPDATE messenger_admin_actions SET state='consumed' WHERE id=?",
      )
        .bind(action.id)
        .run();
      result = {
        text: updated
          ? "تحدثت الحالة إدارياً. ما نعتبرها تأكيد توفر من البائع."
          : "تغير السجل أو انلغت الصلاحية؛ راجعه قبل تحديث جديد.",
        item_id: action.item_id,
      };
    }
  } else {
    const f = retrievalQuery(text);
    const changing = /(حدث|خلي|خلييه|غير حاله)/.test(n);
    const status = /(مباع|انباع)/.test(n)
      ? "sold"
      : /(محجوز)/.test(n)
        ? "reserved"
        : /(متوفر)/.test(n)
          ? "available"
          : /(غير معروف|انتظار التاكيد)/.test(n)
            ? "unknown"
            : null;
    if (!f.title || /(عربون|حول فلوس|اتفقنا|نزل السعر|خصم)/.test(n))
      result = {
        text: "أگدر أبحث عن الغرض وصاحبه، أو أجهز تحديث حالة بتأكيد منفصل. الاتفاق المالي يحتاج مراجعتك.",
      };
    else {
      const found = await textSearch(env, f.title, { includeInactive: true });
      const items = applyConstraints(found.items, f, { exactPrice: true });
      if (changing) {
        if (items.length !== 1 || !status)
          result = {
            text: "لازم غرض واحد وحالة واضحة؛ حدد الاسم والسعر والمنطقة.",
            matches: items.length,
          };
        else {
          const i = items[0],
            id = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO messenger_admin_actions(id,page_id,psid_hash,item_id,status,expected_updated_at,expires_at) VALUES(?,?,?,?,?,?,?)",
          )
            .bind(
              id,
              env.PAGE_ID,
              row.psid_hash,
              i.id,
              status,
              i.updated_at,
              Date.now() + 300000,
            )
            .run();
          result = {
            text: `طلب تحديث ${i.title} إلى ${status}. للتأكيد اكتب: أكد ${id}`,
            confirmation: id,
            item_id: i.id,
          };
        }
      } else
        result = {
          text: items.length
            ? "هاي السجلات المحفوظة. التوفر يحتاج آخر تأكيد من البائع."
            : "ما لگيت سجل مطابق، وما أگدر أخمّن صاحبه.",
          items: await Promise.all(
            items.slice(0, 3).map(async (i) => {
              const v = await itemView(env, i);
              return {
                id: i.id,
                title: i.title,
                price_iqd: i.price_iqd,
                area: i.area,
                status: i.status,
                last_confirmed: i.last_confirmed,
                seller: v.seller,
                inbox_url: v.inbox_url,
              };
            }),
          ),
        };
    }
  }
  await env.DB.prepare(
    "UPDATE messenger_admin_jobs SET result_cipher=?,state='done' WHERE id=?",
  )
    .bind(
      await seal(env, result, env.PAGE_ID + ":admin-result:" + row.id),
      row.id,
    )
    .run();
  return 1;
}
export async function adminJobResult(env, id) {
  const r = await env.DB.prepare(
    "SELECT * FROM messenger_admin_jobs WHERE id=? AND page_id=? AND state='done'",
  )
    .bind(id, env.PAGE_ID)
    .first();
  return r
    ? open(env, r.result_cipher, env.PAGE_ID + ":admin-result:" + id)
    : null;
}

// Disabled unless two explicit sending gates are approved. Never sends drafts
// to an arbitrary PSID, uses HUMAN_AGENT, or retries an uncertain delivery.
export async function sendMessengerAdmin(env, fetcher = fetch) {
  if (
    env.ALLOW_MESSENGER_ADMIN !== "true" ||
    env.ALLOW_SEND !== "true" ||
    env.ALLOW_MESSENGER_ADMIN_SEND !== "true"
  )
    return 0;
  requireValue(
    env.META_PAGE_TOKEN && /^v\d+\.\d+$/.test(env.GRAPH_VERSION || ""),
    503,
    "send_not_configured",
  );
  const job = await env.DB.prepare(
    "SELECT * FROM messenger_admin_jobs WHERE page_id=? AND state='done' AND delivery_state='pending' ORDER BY created_at LIMIT 1",
  )
    .bind(env.PAGE_ID)
    .first();
  if (!job) return 0;
  const link = await linked(env, job.psid_hash);
  const now = Date.now();
  if (!link || job.inbound_at > now || now - job.inbound_at >= 86400000) {
    await env.DB.prepare(
      "UPDATE messenger_admin_jobs SET delivery_state='blocked',delivery_error='role_or_window' WHERE id=?",
    )
      .bind(job.id)
      .run();
    return 0;
  }
  const claimed = await env.DB.prepare(
    "UPDATE messenger_admin_jobs SET delivery_state='sending' WHERE id=? AND delivery_state='pending' RETURNING id",
  )
    .bind(job.id)
    .first();
  if (!claimed) return 0;
  const result = await open(
    env,
    job.result_cipher,
    env.PAGE_ID + ":admin-result:" + job.id,
  );
  let text = result.text || "نتيجة أمر الإدارة";
  for (const item of result.items || [])
    text +=
      "\n" +
      [
        item.title,
        item.price_iqd == null ? "السعر غير مسجل" : item.price_iqd + " دينار",
        item.area || "المنطقة غير مسجلة",
        item.seller?.name || "اسم البائع غير مسجل",
        item.seller?.psid ? "معرف البائع المحفوظ: " + item.seller.psid : "",
        item.inbox_url || "",
        item.last_confirmed
          ? "آخر تأكيد: " + new Date(item.last_confirmed).toISOString()
          : "التوفر غير مؤكد",
      ]
        .filter(Boolean)
        .join(" — ");
  try {
    if (!(await linked(env, job.psid_hash))) throw Error("role_revoked");
    const psid = await open(env, link.psid_cipher, env.PAGE_ID + ":admin-link");
    const r = await fetcher(
      "https://graph.facebook.com/" +
        env.GRAPH_VERSION +
        "/" +
        env.PAGE_ID +
        "/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.META_PAGE_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipient: { id: psid },
          messaging_type: "RESPONSE",
          message: { text: text.slice(0, 1800) },
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const data = await r.json();
    if (!r.ok || !data.message_id) throw Error("delivery_not_confirmed");
    await env.DB.prepare(
      "UPDATE messenger_admin_jobs SET delivery_state='sent' WHERE id=?",
    )
      .bind(job.id)
      .run();
    return 1;
  } catch {
    await env.DB.prepare(
      "UPDATE messenger_admin_jobs SET delivery_state='unknown',delivery_error='delivery_not_confirmed' WHERE id=?",
    )
      .bind(job.id)
      .run();
    return 0;
  }
}
