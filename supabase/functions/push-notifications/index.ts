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
  // Prefer the modern Supabase secret API key when available; retain legacy fallback.
  let serviceRoleKey: string | undefined;
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
  serviceRoleKey ||= Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
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

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
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
  let recipientIds: string[] = [];
  let title = "وسيط";
  let body = "لديك تحديث جديد في تطبيق وسيط";
  let tag = "waseet-update";

  if (eventType === "test_push") {
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
    const { data: sale } = await admin.from("sales").select("id, rep_id, goods_id, verified_by").eq("id", saleId).maybeSingle();
    if (!sale || sale.verified_by !== user.id) return json({ error: "Sale not found or not authorized" }, 403);
    const { data: rep } = await admin.from("profiles").select("id").eq("id", sale.rep_id).maybeSingle();
    const { data: item } = await admin.from("goods").select("title").eq("id", sale.goods_id).maybeSingle();
    recipientIds = rep ? [rep.id] : [];
    title = "تم تسجيل عملية بيع";
    body = "تم تسجيل بيع " + String(item?.title || "غرض") + " وتحديث سجل العمولة";
    tag = "sale-recorded";
  } else if (eventType === "rep_status") {
    if (actor.role !== "admin" || actor.status === "banned") return json({ error: "Forbidden" }, 403);
    const targetUserId = String(input.targetUserId || "");
    if (!targetUserId || targetUserId === user.id) return json({ error: "Invalid recipient" }, 400);
    const { data: target } = await admin.from("profiles").select("id, role, status").eq("id", targetUserId).maybeSingle();
    if (!target || target.role !== "rep") return json({ error: "Rep not found" }, 404);
    recipientIds = [target.id];
    if (target.status === "approved") {
      title = "تم قبول طلبك في وسيط";
      body = "تمت الموافقة على حسابك، يمكنك الآن تسجيل الدخول واستخدام التطبيق.";
      tag = "rep-approved";
    } else if (target.status === "restricted") {
      title = "تم تقييد حسابك";
      body = "تم تحديث صلاحيات حسابك في تطبيق وسيط. راجع الإدارة إذا احتجت توضيحاً.";
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
  if (!recipientIds.length) return json({ ok: true, sent: 0, reason: "No recipients with push subscriptions" });

  webpush.setVapidDetails("mailto:notifications@waseet.app", vapidPublicKey, vapidPrivateKey);

  const { data: subscriptions, error: subError } = await admin
    .from("push_subscriptions").select("id, user_id, endpoint, subscription").in("user_id", recipientIds);
  if (subError) return json({ error: "Could not load push subscriptions" }, 500);

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
      else console.error("Web Push delivery error:", statusCode || "unknown");
    }
  }
  if (staleIds.length) {
    await admin.from("push_subscriptions").delete().in("id", staleIds);
  }
  return json({ ok: true, sent, staleRemoved: staleIds.length });
});