import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { requireValue, hash, body, json, Problem } from "./security.mjs";
export const to64 = (b) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const from64 = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
const random = () => to64(crypto.getRandomValues(new Uint8Array(32)));
const cookie = (name, value, age) =>
  `__Host-mandob_${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
const readCookie = (req, name) => {
  const all = (req.headers.get("cookie") || "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith("__Host-mandob_" + name + "="));
  requireValue(all.length <= 1, 401, "unauthorized");
  return all[0]?.split("=")[1] || "";
};
function config(env) {
  let u;
  try {
    u = new URL(env.ADMIN_ORIGIN);
  } catch {
    throw new Problem(503, "passkey_not_configured");
  }
  requireValue(
    u.protocol === "https:" &&
      u.origin === env.ADMIN_ORIGIN &&
      u.hostname === env.WEBAUTHN_RP_ID,
    503,
    "passkey_not_configured",
  );
  return { origin: u.origin, rpID: u.hostname };
}
export function sameOrigin(req, env) {
  const { origin } = config(env);
  requireValue(
    new URL(req.url).origin === origin && req.headers.get("origin") === origin,
    403,
    "origin_denied",
  );
  requireValue(
    !["cross-site", "none"].includes(req.headers.get("sec-fetch-site")),
    403,
    "origin_denied",
  );
}
async function rate(req, env) {
  const now = Date.now(),
    window = Math.floor(now / 900000);
  const ip = await hash(req.headers.get("cf-connecting-ip") || "unknown");
  for (const [id, max] of [
    [`ip:${ip}:${window}`, 10],
    [`global:${window}`, 60],
  ]) {
    const row = await env.DB.prepare(
      "INSERT INTO admin_auth_limits(bucket,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 WHERE attempts<? RETURNING attempts",
    )
      .bind(id, now + 1800000, max)
      .first();
    requireValue(row, 429, "auth_rate_limit");
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_auth_limits WHERE expires_at<?").bind(
      now,
    ),
    env.DB.prepare("DELETE FROM admin_challenges WHERE expires_at<?").bind(now),
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<?").bind(now),
  ]);
}
async function challenge(env, kind, userHandle) {
  const id = random(),
    value = random();
  await env.DB.prepare(
    "INSERT INTO admin_challenges(id_hash,challenge,kind,user_handle,expires_at) VALUES(?,?,?,?,?)",
  )
    .bind(await hash(id), value, kind, userHandle, Date.now() + 300000)
    .run();
  return { id, value };
}
function requireTopLevel(d) {
  try {
    requireValue(
      typeof d.response?.clientDataJSON === "string" &&
        d.response.clientDataJSON.length <= 8192,
      401,
      "passkey_invalid",
    );
    const c = JSON.parse(
      new TextDecoder().decode(from64(d.response.clientDataJSON)),
    );
    requireValue(
      c.crossOrigin !== true && !c.topOrigin,
      401,
      "passkey_invalid",
    );
  } catch {
    throw new Problem(401, "passkey_invalid");
  }
}
async function consume(req, env, kind) {
  const id = readCookie(req, "challenge");
  requireValue(/^[A-Za-z0-9_-]{43}$/.test(id), 401, "challenge_invalid");
  const c = await env.DB.prepare(
    "DELETE FROM admin_challenges WHERE id_hash=? AND kind=? RETURNING *",
  )
    .bind(await hash(id), kind)
    .first();
  requireValue(c && c.expires_at > Date.now(), 401, "challenge_invalid");
  return c;
}
export async function passkeySession(req, env) {
  const { origin } = config(env);
  requireValue(new URL(req.url).origin === origin, 401, "unauthorized");
  const token = readCookie(req, "session");
  requireValue(/^[A-Za-z0-9_-]{43}$/.test(token), 401, "unauthorized");
  const session = await env.DB.prepare(
    "SELECT s.* FROM admin_sessions s JOIN admin_credentials c ON c.id=s.credential_id WHERE token_hash=? AND expires_at>?",
  )
    .bind(await hash(token), Date.now())
    .first();
  requireValue(session, 401, "unauthorized");
  if (!["GET", "HEAD"].includes(req.method)) {
    sameOrigin(req, env);
    requireValue(
      (await hash(req.headers.get("x-csrf-token") || "")) === session.csrf_hash,
      403,
      "csrf_failed",
    );
  }
  return session;
}
// All public auth endpoints carry no seller data. Bootstrap is operator-provisioned,
// one-use and short-lived; there is no public "create administrator" facility.
export async function passkeyRoute(req, env) {
  config(env);
  const path = new URL(req.url).pathname;
  if (path === "/auth/session" && req.method === "GET") {
    const s = await passkeySession(req, env);
    return json({ ok: true, csrf: s.csrf_token, authentication: "passkey" });
  }
  if (path === "/auth/logout" || path === "/auth/revoke-all") {
    requireValue(req.method === "POST", 405);
    const s = await passkeySession(req, env);
    await env.DB.prepare(
      path.endsWith("revoke-all")
        ? "DELETE FROM admin_sessions"
        : "DELETE FROM admin_sessions WHERE token_hash=?",
    )
      .bind(...(path.endsWith("revoke-all") ? [] : [s.token_hash]))
      .run();
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie("session", "", 0),
      },
    });
  }
  requireValue(req.method === "POST", 405);
  sameOrigin(req, env);
  requireValue(
    (req.headers.get("content-type") || "").startsWith("application/json"),
    415,
    "json_required",
  );
  await rate(req, env);
  let d;
  try {
    d = JSON.parse(new TextDecoder().decode(await body(req, 32768)));
  } catch {
    throw new Problem(400, "invalid_json");
  }
  if (path === "/auth/register/options") {
    requireValue(
      typeof d.code === "string" && /^[A-Za-z0-9_-]{43}$/.test(d.code),
      403,
      "enrollment_closed",
    );
    const grant = await env.DB.prepare(
      "UPDATE admin_bootstrap SET used=1 WHERE slot=1 AND used=0 AND expires_at>? AND code_hash=? AND NOT EXISTS(SELECT 1 FROM admin_credentials) RETURNING slot",
    )
      .bind(Date.now(), await hash(d.code))
      .first();
    requireValue(grant, 403, "enrollment_closed");
    const handle = random(),
      c = await challenge(env, "register", handle);
    const options = await generateRegistrationOptions({
      rpName: "Mandob Baghdad Admin",
      rpID: env.WEBAUTHN_RP_ID,
      userID: from64(handle),
      userName: "mandob-admin",
      challenge: from64(c.value),
      attestationType: "none",
      supportedAlgorithmIDs: [-7],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
    });
    return new Response(JSON.stringify(options), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie("challenge", c.id, 300),
      },
    });
  }
  if (path === "/auth/register/verify") {
    const c = await consume(req, env, "register");
    requireTopLevel(d);
    let v;
    try {
      v = await verifyRegistrationResponse({
        response: d,
        expectedChallenge: c.challenge,
        expectedOrigin: env.ADMIN_ORIGIN,
        expectedRPID: env.WEBAUTHN_RP_ID,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7],
      });
    } catch {
      throw new Problem(401, "passkey_invalid");
    }
    requireValue(
      v.verified && v.registrationInfo?.userVerified,
      401,
      "passkey_invalid",
    );
    const cred = v.registrationInfo.credential;
    const row = await env.DB.prepare(
      "INSERT INTO admin_credentials(slot,id,public_key,counter,user_handle,created_at) SELECT 1,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM admin_credentials) RETURNING id",
    )
      .bind(
        cred.id,
        to64(cred.publicKey),
        cred.counter,
        c.user_handle,
        Date.now(),
      )
      .first();
    requireValue(row, 403, "enrollment_closed");
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie("challenge", "", 0),
      },
    });
  }
  if (path === "/auth/login/options") {
    const cred = await env.DB.prepare(
      "SELECT * FROM admin_credentials WHERE slot=1",
    ).first();
    requireValue(cred, 403, "enrollment_closed");
    const c = await challenge(env, "login", cred.user_handle);
    const options = await generateAuthenticationOptions({
      rpID: env.WEBAUTHN_RP_ID,
      challenge: from64(c.value),
      userVerification: "required",
      allowCredentials: [{ id: cred.id }],
    });
    return new Response(JSON.stringify(options), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie("challenge", c.id, 300),
      },
    });
  }
  if (path === "/auth/login/verify") {
    const c = await consume(req, env, "login"),
      cred = await env.DB.prepare(
        "SELECT * FROM admin_credentials WHERE slot=1 AND id=?",
      )
        .bind(typeof d.id === "string" ? d.id : "")
        .first();
    requireValue(cred, 401, "passkey_invalid");
    requireTopLevel(d);
    requireValue(
      !d.response?.userHandle || d.response.userHandle === c.user_handle,
      401,
      "passkey_invalid",
    );
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: d,
        expectedChallenge: c.challenge,
        expectedOrigin: env.ADMIN_ORIGIN,
        expectedRPID: env.WEBAUTHN_RP_ID,
        credential: {
          id: cred.id,
          publicKey: from64(cred.public_key),
          counter: cred.counter,
        },
        requireUserVerification: true,
      });
    } catch {
      throw new Problem(401, "passkey_invalid");
    }
    requireValue(
      v.verified && v.authenticationInfo.userVerified,
      401,
      "passkey_invalid",
    );
    const updated = await env.DB.prepare(
      "UPDATE admin_credentials SET counter=? WHERE slot=1 AND counter=? RETURNING id",
    )
      .bind(v.authenticationInfo.newCounter, cred.counter)
      .first();
    requireValue(updated, 401, "passkey_invalid");
    const token = random(),
      csrf = random(),
      now = Date.now();
    await env.DB.prepare(
      "INSERT INTO admin_sessions(token_hash,credential_id,csrf_hash,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        await hash(token),
        cred.id,
        await hash(csrf),
        csrf,
        now + 3600000,
        now,
      )
      .run();
    return new Response(JSON.stringify({ ok: true, csrf }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie("session", token, 3600),
      },
    });
  }
  throw new Problem(404, "not_found");
}
