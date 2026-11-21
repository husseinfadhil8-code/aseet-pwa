import { open, seal, requireValue } from "./security.mjs";
import { stmt } from "./memory.mjs";
import { settings } from "./ai.mjs";
export async function sendPending(env, fetcher = fetch, now = Date.now()) {
  const s = await settings(env);
  const rows = await stmt(
    env,
    "SELECT * FROM outbox WHERE page_id=? AND state='pending' AND attempts<5 AND next_at<=? AND lease_until<? ORDER BY next_at LIMIT 10",
    env.PAGE_ID,
    now,
    now,
  ).all();
  let sent = 0;
  for (const row of rows.results) {
    if (row.kind === "reply" && (!s.replies || env.ALLOW_SEND !== "true" || env.ALLOW_CUSTOMER_SEND !== "true"))
      continue;
    if (row.kind === "alert" && (!s.alerts || env.ALLOW_ALERT_SEND !== "true"))
      continue;
    const claimed = await stmt(
      env,
      "UPDATE outbox SET lease_until=?,attempts=attempts+1 WHERE id=? AND state='pending' AND lease_until<? RETURNING id",
      now + 60000,
      row.id,
      now,
    ).first();
    if (!claimed) continue;
    try {
      const payload = await open(
        env,
        row.payload_cipher,
        env.PAGE_ID + ":outbox:" + row.id,
      );
      let response;
      if (row.kind === "reply") {
        const conv = await stmt(
          env,
          "SELECT last_inbound,handoff FROM conversations WHERE id=? AND page_id=?",
          row.conversation_id,
          env.PAGE_ID,
        ).first();
        if (!conv || conv.handoff || now - conv.last_inbound > 86400000) {
          await stmt(
            env,
            "UPDATE outbox SET state='cancelled',error='handoff_or_window_expired' WHERE id=?",
            row.id,
          ).run();
          continue;
        }
        requireValue(
          env.META_PAGE_TOKEN && /^v\d+\.\d+$/.test(env.GRAPH_VERSION || ""),
          503,
          "send_not_configured",
        );
        response = await fetcher(
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
              recipient: { id: payload.psid },
              messaging_type: "RESPONSE",
              message: { text: payload.text },
            }),
            signal: AbortSignal.timeout(10000),
          },
        );
      } else {
        requireValue(
          env.ADMIN_BOT_TOKEN && /^\d+$/.test(env.ADMIN_CHAT_ID || ""),
          503,
          "admin_channel_not_configured",
        );
        let summary = "Mandob Baghdad — يحتاج مراجعتك\n" + payload.type;
        if (payload.item_id) {
          const item = await stmt(
            env,
            "SELECT title,seller_id,conversation_id,last_confirmed,status FROM items WHERE id=? AND page_id=?",
            payload.item_id,
            env.PAGE_ID,
          ).first();
          const seller = item
            ? await stmt(
                env,
                "SELECT name FROM sellers WHERE id=? AND page_id=?",
                item.seller_id,
                env.PAGE_ID,
              ).first()
            : null;
          const conv = item
            ? await stmt(
                env,
                "SELECT inbox_url FROM conversations WHERE id=? AND page_id=?",
                item.conversation_id,
                env.PAGE_ID,
              ).first()
            : null;
          summary +=
            "\nالغرض: " +
            (item?.title || "غير محدد") +
            "\nالبائع: " +
            (seller?.name || "اسم غير معروف") +
            " (" +
            (item?.seller_id || "") +
            ")\nالحالة: " +
            (item?.status || "unknown") +
            "\nآخر تأكيد: " +
            (item?.last_confirmed
              ? new Date(item.last_confirmed).toISOString()
              : "غير مؤكد") +
            "\n" +
            (conv?.inbox_url || "رابط المحادثة غير متوفر") +
            "\nلا يُعد هذا تأكيداً للتوفر.";
        }
        response = await fetcher(
          "https://api.telegram.org/bot" + env.ADMIN_BOT_TOKEN + "/sendMessage",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: env.ADMIN_CHAT_ID,
              text: summary,
              protect_content: true,
              link_preview_options: { is_disabled: true },
            }),
            signal: AbortSignal.timeout(10000),
          },
        );
      }
      const result = await response.json();
      requireValue(
        response.ok &&
          (row.kind === "alert"
            ? result.ok === true
            : typeof result.message_id === "string"),
        502,
        "send_rejected",
      );
      await stmt(
        env,
        "UPDATE outbox SET state='sent',lease_until=0,error=NULL WHERE id=?",
        row.id,
      ).run();
      sent++;
    } catch {
      await stmt(
        env,
        "UPDATE outbox SET lease_until=0,next_at=?,error='delivery_failed' WHERE id=?",
        now + Math.min(3600000, 30000 * 2 ** row.attempts),
        row.id,
      ).run();
    }
  }
  return sent;
}
