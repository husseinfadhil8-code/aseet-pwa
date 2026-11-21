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
  if (!r.ok)
    throw Error(
      "تعذر التحقق. تحقق من الرمز أو صلاحية مفتاح المرور، أو انتظر عند تجاوز المحاولات.",
    );
  return r.json();
}
async function run(register) {
  try {
    if (!window.PublicKeyCredential)
      throw Error("استخدم Safari حديثاً يدعم مفاتيح المرور.");
    $("#status").textContent = "جارٍ التحقق…";
    const options = await api(
      register ? "register/options" : "login/options",
      register ? { code: $("#code").value.trim() } : {},
    );
    $("#code").value = "";
    options.challenge = bytes(options.challenge);
    if (register) options.user.id = bytes(options.user.id);
    else
      options.allowCredentials = options.allowCredentials.map((c) => ({
        ...c,
        id: bytes(c.id),
      }));
    const cred = register
      ? await navigator.credentials.create({ publicKey: options })
      : await navigator.credentials.get({ publicKey: options });
    const response = { clientDataJSON: encode(cred.response.clientDataJSON) };
    if (register) {
      response.attestationObject = encode(cred.response.attestationObject);
      response.transports = cred.response.getTransports?.() || [];
    } else {
      response.authenticatorData = encode(cred.response.authenticatorData);
      response.signature = encode(cred.response.signature);
      response.userHandle = cred.response.userHandle
        ? encode(cred.response.userHandle)
        : null;
    }
    await api(register ? "register/verify" : "login/verify", {
      id: cred.id,
      rawId: encode(cred.rawId),
      type: cred.type,
      response,
      clientExtensionResults: cred.getClientExtensionResults(),
    });
    if (register) {
      $("#status").textContent = "تم حفظ مفتاح المرور. اضغط الدخول للتحقق منه.";
    } else location.replace("/");
  } catch (e) {
    $("#status").textContent =
      e.name === "NotAllowedError"
        ? "أُلغي التحقق أو انتهت مهلته. أعد الدخول؛ رمز التهيئة المستهلك يحتاج إعادة إصدار من المشغّل."
        : e.message;
  }
}
$("#signin").onclick = () => run(false);
$("#enroll").onsubmit = (e) => {
  e.preventDefault();
  run(true);
};
