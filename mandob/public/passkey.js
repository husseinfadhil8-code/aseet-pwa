const $ = (s) => document.querySelector(s);
const bytes = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
const encode = (b) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
async function api(path, data) {
  const r = await fetch("/auth/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) {
    const d = await r.json();
    const messages = {
      enrollment_closed:
        "استقبال طلبات المسؤول مغلق أو انتهت نافذته. تواصل مع المشغّل.",
      approval_required: "الطلب ينتظر موافقة المشغّل على المفتاح المحدد.",
      enrollment_window_limit:
        "بلغت نافذة التهيئة حدها. يلزم تنسيق نافذة جديدة مع المشغّل.",
      auth_rate_limit: "بلغت حد المحاولات. انتظر ولا تكرر التحديث.",
      enrollment_request_invalid:
        "لا يوجد طلب صالح مرتبط بهذا المتصفح؛ قد انتهت صلاحيته أو حُذفت الكوكيز.",
    };
    throw Error(messages[d.error] || "تعذر التحقق من مفتاح المرور أو الطلب.");
  }
  return r.json();
}
async function credential(create, options) {
  if (!window.PublicKeyCredential)
    throw Error("استخدم Safari حديثاً يدعم مفاتيح المرور.");
  options.challenge = bytes(options.challenge);
  if (create) options.user.id = bytes(options.user.id);
  else
    options.allowCredentials = options.allowCredentials.map((c) => ({
      ...c,
      id: bytes(c.id),
    }));
  const cred = create
    ? await navigator.credentials.create({ publicKey: options })
    : await navigator.credentials.get({ publicKey: options });
  const response = { clientDataJSON: encode(cred.response.clientDataJSON) };
  if (create) {
    response.attestationObject = encode(cred.response.attestationObject);
    response.transports = cred.response.getTransports?.() || [];
  } else {
    response.authenticatorData = encode(cred.response.authenticatorData);
    response.signature = encode(cred.response.signature);
    response.userHandle = cred.response.userHandle
      ? encode(cred.response.userHandle)
      : null;
  }
  return {
    id: cred.id,
    rawId: encode(cred.rawId),
    type: cred.type,
    response,
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}
const run = (fn) => async (e) => {
  e?.preventDefault();
  const buttons = [...document.querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  try {
    $("#status").textContent = "جارٍ التحقق…";
    await fn();
  } catch (e) {
    $("#status").textContent =
      e.name === "NotAllowedError"
        ? "أُلغي التحقق أو انتهت مهلته. لم يُفعّل أي حساب."
        : e.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
};
function showRequest(d) {
  $("#request-info").hidden = false;
  $("#request-id").textContent = d.id;
  $("#fingerprint").textContent = d.fingerprint;
  $("#request-state").textContent =
    {
      pending: "بانتظار الموافقة",
      approved: "وافق المشغّل — أكّد بالمفتاح نفسه",
      denied: "رُفض الطلب",
    }[d.status] || "غير مفعّل";
  $("#activate").hidden = d.status !== "approved";
  $("#status").textContent =
    "رقم الطلب وبصمته غير سريين، ولا يمنحان الدخول. تنتهي المهلة: " +
    new Date(d.expires_at).toLocaleTimeString("ar-IQ");
}
$("#signin").onclick = run(async () => {
  const o = await api("login/options", {});
  await api("login/verify", await credential(false, o));
  location.replace("/");
});
$("#enroll").onsubmit = run(async () => {
  const o = await api("register/options", { code: $("#code").value.trim() });
  $("#code").value = "";
  await api("register/verify", await credential(true, o));
  $("#status").textContent = "تم حفظ مفتاح المرور. اضغط الدخول للتحقق منه.";
});
$("#request-admin").onclick = run(async () => {
  const o = await api("enrollment/options", {});
  const d = await api("enrollment/verify", await credential(true, o));
  showRequest(d);
});
$("#check-request").onclick = run(async () =>
  showRequest(await api("enrollment/check", {})),
);
$("#activate").onclick = run(async () => {
  const o = await api("enrollment/activate-options", {});
  await api("enrollment/activate", await credential(false, o));
  $("#request-info").hidden = true;
  $("#status").textContent =
    "تم تفعيل المفتاح الموافق عليه. اضغط الدخول بمفتاح المرور.";
});

$("#copy-request").onclick = run(async () => {
  await navigator.clipboard.writeText(
    $("#request-id").textContent + ":" + $("#fingerprint").textContent,
  );
  $("#status").textContent =
    "نُسخ رقم الطلب وبصمة المفتاح فقط؛ لا توجد أسرار في النص المنسوخ.";
});
