const enc = new TextEncoder();
export class Problem extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}
export const requireValue = (ok, status = 400, code = "invalid_request") => {
  if (!ok) throw new Problem(status, code);
};
export const hash = async (s) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
export async function equal(a, b) {
  return (await hash(a)) === (await hash(b));
}
export async function signature(raw, secret, header) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(header || "")) return false;
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    k,
    Uint8Array.from(header.slice(7).match(/../g), (x) => parseInt(x, 16)),
    raw,
  );
}
export const b64 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192)
    s += String.fromCharCode(...b.slice(i, i + 8192));
  return btoa(s);
};
const bytes = (s) => Uint8Array.from(atob(s), (x) => x.charCodeAt(0));
async function key(env) {
  requireValue(
    /^[a-f0-9]{64}$/i.test(env.DATA_KEY || ""),
    503,
    "encryption_not_configured",
  );
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(env.DATA_KEY.match(/../g), (x) => parseInt(x, 16)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(env, value, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    await key(env),
    enc.encode(JSON.stringify(value)),
  );
  return b64(iv) + "." + b64(new Uint8Array(data));
}
export async function open(env, value, aad) {
  const [iv, data] = value.split(".");
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes(iv), additionalData: enc.encode(aad) },
        await key(env),
        bytes(data),
      ),
    ),
  );
}
export async function body(req, max = 262144) {
  const n = Number(req.headers.get("content-length"));
  requireValue(!n || n <= max, 413, "too_large");
  requireValue(req.body, 400);
  const reader = req.body.getReader();
  let size = 0;
  const parts = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Problem(413, "too_large");
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}
export const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
export function inboxURL(value) {
  if (value === null) return null;
  const u = new URL(value);
  requireValue(
    u.protocol === "https:" &&
      ["business.facebook.com", "www.facebook.com"].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.hash,
    400,
    "invalid_inbox_url",
  );
  requireValue(
    u.pathname.startsWith("/latest/inbox") ||
      u.pathname.startsWith("/messages/"),
    400,
    "invalid_inbox_url",
  );
  return u.href;
}
