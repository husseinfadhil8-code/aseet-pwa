import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  // Prefer the platform-provided legacy service-role JWT for database admin queries.
  // New sb_secret_* API keys are not JWT service-role tokens and should not be
  // used as the Authorization bearer for PostgREST admin queries.
  let serviceRoleKey: string | undefined = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) {
    const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
    if (secretKeysRaw) {
      try {
        const secretKeys = JSON.parse(secretKeysRaw) as Record<string, unknown>;
        const defaultKey = secretKeys.default;
        if (typeof defaultKey === "string" && defaultKey.startsWith("sb_secret_")) {
          serviceRoleKey = defaultKey;
        } else {
          serviceRoleKey = Object.values(secretKeys).find(
            (value): value is string => typeof value === "string" && value.startsWith("sb_secret_"),
          );
        }
      } catch (error) {
        console.error("Could not parse SUPABASE_SECRET_KEYS", error);
      }
    }
  }
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
    return json({ error: "Push service is not configured. Set required Supabase secrets." }, 503);
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization) return json({ error: "Unauthorized" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  const user = authData?.user;
  if (authError || !user) return json({ error: "Unauthorized" }, 401);

  // Supabase's newer sb_secret_* keys must be sent in the apikey header only.
  // supabase-js also adds Authorization: Bearer <key> by default; strip that
  // header for secret API keys so the gateway can apply the elevated key role.
  const usesSecretApiKey = serviceRoleKey.startsWith("sb_secret_");
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(usesSecretApiKey
      ? {
          global: {
            fetch: (input: RequestInfo | URL, init?: RequestInit) => {
              const headers = new Headers(
                init?.headers ?? (input instanceof Request ? input.headers : undefined),
              );
              headers.delete("Authorization");
              return fetch(input, { ...init, headers });
            },
          },
        }
      : {}),
  });

  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (input.action === "get_public_key") {
    return json({ publicKey: vapidPublicKey });
  }

  const { data: actor, error: actorError } = await admin
    .from("profiles").select("id, role, status, full_name").eq("id", user.id).maybeSingle();
  if (actorError) {
    console.error("Profile lookup query failed", actorError.code, actorError.message);
    return json({ error: "Profile lookup failed", code: actorError.code }, 500);
  }
  if (!actor) return json({ error: "Profile not found" }, 403);

  const eventType = String(input.event || "");
  console.log("Push request received:", eventType);

  if (eventType === "presence_update") {
    if (actor.role !== "rep" && actor.role !== "admin") return json({ error: "Forbidden" }, 403);
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    const hasCoordinates = input.locationShared === true &&
      Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
      Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
    const updates: Record<string, unknown> = {
      online: input.online !== false,
      last_seen_at: new Date().toISOString(),
    };
    if (hasCoordinates) {
      updates.last_latitude = latitude;
      updates.last_longitude = longitude;
      updates.location_accuracy = Number.isFinite(Number(input.locationAccuracy))
        ? Math.max(0, Number(input.locationAccuracy))
        : null;
      updates.location_updated_at = new Date().toISOString();
    }
    const { error: presenceError } = await admin.from("profiles").update(updates).eq("id", user.id);
    if (presenceError) {
      console.error("Presence update failed", presenceError.code, presenceError.message);
      return json({ error: "Presence update failed", code: presenceError.code }, 500);
    }
    return json({ ok: true, locationUpdated: hasCoordinates });
  }

  let recipientIds: string[] = [];
  let title = "وسيط";
  let body = "لديك تحديث جديد في تطبيق وسيط";
  let tag = "waseet-update";

  if (eventType === "user_login") {
    if (actor.status !== "approved" && actor.status !== "restricted") return json({ error: "Account is not active" }, 403);
    const { data: admins, error: adminsError } = await admin
      .from("profiles").select("id").eq("role", "admin").eq("status", "approved");
    if (adminsError) return json({ error: "Could not load administrators" }, 500);
    recipientIds = (admins || []).map((row: { id: string }) => row.id);
    title = "دخول إلى تطبيق وسيط";
    body = "دخل " + String(actor.full_name || (actor.role === "rep" ? "مندوب" : "المدير")).slice(0, 80) + " إلى التطبيق.";
    tag = "user-login";
  } else if (eventType === "app_update") {
    if (actor.role !== "admin" || actor.status !== "approved") {
      return json({ error: "Only an approved admin can announce app updates" }, 403);
    }
    const updateTitle = String(input.updateTitle || "").trim();
    const updateMessage = String(input.updateMessage || "").trim();
    if (!updateTitle || !updateMessage) {
      return json({ error: "Update title and message are required" }, 400);
    }
    if (updateTitle.length > 90 || updateMessage.length > 220) {
      return json({ error: "Update title or message is too long" }, 400);
    }
    const { data: recipients, error: recipientsError } = await admin
      .from("profiles").select("id").eq("role", "rep").in("status", ["approved", "restricted"]);
    if (recipientsError) return json({ error: "Could not load representatives" }, 500);
    recipientIds = (recipients || []).map((row: { id: string }) => row.id);
    title = "🚀 " + updateTitle;
    body = updateMessage;
    tag = "waseet-app-update";
  } else if (eventType === "test_push") {
    if (actor.role !== "admin" || actor.status !== "approved") return json({ error: "Only an approved admin can test push notifications" }, 403);
    recipientIds = [user.id];
    title = "اختبار إشعارات وسيط";
    body = "إذا وصلك هذا الإشعار خارج التطبيق، فخدمة Push تعمل على هذا الجهاز.";
    tag = "waseet-push-test";
  } else if (eventType === "new_goods") {
    if (actor.role !== "admin" || actor.status === "banned") return json({ error: "Forbidden" }, 403);
    const goodsId = String(input.goodsId || "");
    const { data: item } = await admin.from("goods").select("id, title, created_by").eq("id", goodsId).maybeSingle();
    if (!item || item.created_by !== user.id) return json({ error: "Goods not found or not authorized" }, 403);
    const { data: recipients } = await admin.from("profiles").select("id").eq("role", "rep").in("status", ["approved", "restricted"]);
    recipientIds = (recipients || []).map((row: { id: string }) => row.id);
    title = "غرض جديد في وسيط";
    body = "تمت إضافة غرض جديد: " + String(item.title || "غرض جديد").slice(0, 100);
    tag = "new-goods";
  } else if (eventType === "new_rep") {
    if (actor.role !== "rep" || actor.status !== "pending") return json({ error: "Forbidden" }, 403);
    const { data: recipients } = await admin.from("profiles").select("id").eq("role", "admin").eq("status", "approved");
    recipientIds = (recipients || []).map((row: { id: string }) => row.id);
    title = "طلب مندوب جديد";
    body = "وصل طلب انضمام جديد من " + String(actor.full_name || "مندوب جديد").slice(0, 80);
    tag = "new-rep";
  } else if (eventType === "sale") {
    if (actor.role !== "admin" || actor.status === "banned") return json({ error: "Forbidden" }, 403);
    const saleId = String(input.saleId || "");
    const { data: sale, error: saleError } = await admin.from("sales").select("id, rep_id, goods_id, verified_by").eq("id", saleId).maybeSingle();
    if (saleError) {
      console.error("Sale lookup failed:", saleError.code, saleError.message);
      return json({ error: "Sale lookup failed", code: saleError.code }, 500);
    }
    if (!sale || sale.verified_by !== user.id) {
      console.error("Sale push rejected: sale missing or verifier mismatch");
      return json({ error: "Sale not found or not authorized" }, 403);
    }
    const { data: rep } = await admin.from("profiles").select("id").eq("id", sale.rep_id).maybeSingle();
    const { data: item } = await admin.from("goods").select("title").eq("id", sale.goods_id).maybeSingle();
    recipientIds = rep ? [rep.id] : [];
    title = "تم تسجيل عملية بيع";
    body = "تم تسجيل بيع " + String(item?.title || "غرض") + " وتحديث سجل العمولة";
    tag = "sale-recorded";
  } else if (eventType === "commission_paid") {
    if (actor.role !== "admin" || actor.status !== "approved") {
      return json({ error: "Only an approved admin can notify commission payouts" }, 403);
    }
    const saleId = String(input.saleId || "");
    const { data: sale, error: saleError } = await admin
      .from("sales")
      .select("id, rep_id, goods_id, commission_paid_at, commission_paid_by")
      .eq("id", saleId)
      .maybeSingle();
    if (saleError) return json({ error: "Could not load sale payout status" }, 500);
    if (!sale || sale.commission_paid_by !== user.id || !sale.commission_paid_at) {
      return json({ error: "Confirmed payout not found or not authorized" }, 403);
    }
    const { data: rep } = await admin.from("profiles").select("id").eq("id", sale.rep_id).maybeSingle();
    const { data: item } = await admin.from("goods").select("title").eq("id", sale.goods_id).maybeSingle();
    recipientIds = rep ? [rep.id] : [];
    title = "💰 تم إرسال مستحقاتك";
    body = "تم تأكيد تحويل مستحقاتك عن بيع «" + String(item?.title || "غرض").slice(0, 100) + "». افتح وسيط للاطلاع على التفاصيل.";
    tag = "commission-paid";
  } else if (eventType === "rep_status") {
    if (actor.role !== "admin" || actor.status === "banned") return json({ error: "Forbidden" }, 403);
    const targetUserId = String(input.targetUserId || "");
    if (!targetUserId || targetUserId === user.id) return json({ error: "Invalid recipient" }, 400);
    const { data: target } = await admin.from("profiles").select("id, role, status").eq("id", targetUserId).maybeSingle();
    if (!target || (target.role !== "rep" && !(target.role === "admin" && input.statusAction === "promote"))) {
      return json({ error: "Recipient not found or unsupported role" }, 404);
    }
    recipientIds = [target.id];
    const statusAction = String(input.statusAction || "");
    if (statusAction === "promote" && target.role === "admin") {
      title = "تمت ترقيتك إلى مدير";
      body = "تمت ترقيتك في منصة وسيط. افتح التطبيق لتحديث صلاحيات حسابك.";
      tag = "rep-promoted";
    } else if (statusAction === "unban" && target.status === "approved") {
      title = "تمت إعادة تفعيل حسابك";
      body = "أعادت الإدارة تفعيل حسابك في وسيط. يمكنك الآن تسجيل الدخول ومتابعة العمل.";
      tag = "rep-reactivated";
    } else if (statusAction === "approve" && target.status === "approved") {
      title = "تم قبول طلبك في وسيط";
      body = "مبروك! تمت الموافقة على طلب انضمامك، يمكنك الآن تسجيل الدخول والبدء بالعمل.";
      tag = "rep-approved";
    } else if (target.status === "approved") {
      title = "تم تحديث حسابك في وسيط";
      body = "حسابك مفعّل حالياً. افتح التطبيق للاطلاع على آخر التحديثات.";
      tag = "rep-status-approved";
    } else if (target.status === "restricted") {
      title = "تم تقييد حسابك";
      body = "تم تقييد بعض صلاحيات حسابك في تطبيق وسيط. راجع الإدارة إذا احتجت توضيحاً.";
      tag = "rep-restricted";
    } else if (target.status === "banned") {
      title = "تم حظر حسابك";
      body = "لم يعد بإمكانك استخدام تطبيق وسيط. تواصل مع الإدارة عند الحاجة.";
      tag = "rep-banned";
    } else {
      return json({ error: "Unsupported account status" }, 400);
    }
  } else {
    return json({ error: "Unsupported event" }, 400);
  }

  recipientIds = [...new Set(recipientIds)].filter((id) => eventType === "test_push" || id !== user.id);
  console.log("Push recipients resolved:", eventType, recipientIds.length);
  if (!recipientIds.length) {
    console.warn("Push skipped: no eligible recipients", eventType);
    return json({ ok: true, sent: 0, reason: "No recipients with push subscriptions" });
  }

  webpush.setVapidDetails("mailto:notifications@waseet.app", vapidPublicKey, vapidPrivateKey);

  const { data: subscriptions, error: subError } = await admin
    .from("push_subscriptions").select("id, user_id, endpoint, subscription").in("user_id", recipientIds);
  if (subError) {
    console.error("Push subscription query failed:", subError.code, subError.message);
    return json({ error: "Could not load push subscriptions", code: subError.code }, 500);
  }
  console.log("Push subscriptions found:", (subscriptions || []).length, "for event", eventType);

  let sent = 0;
  const staleIds: string[] = [];
  for (const row of subscriptions || []) {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify({
        title, body, tag, url: "./",
      }), { TTL: 60 * 60, urgency: "high" });
      sent++;
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 404 || statusCode === 410) staleIds.push(row.id);
      else console.error("Web Push delivery error:", statusCode || "unknown", String(error));
    }
  }
  if (staleIds.length) {
    await admin.from("push_subscriptions").delete().in("id", staleIds);
  }
  console.log("Push delivery completed:", eventType, "sent", sent, "stale removed", staleIds.length);
  return json({ ok: true, sent, staleRemoved: staleIds.length });
});