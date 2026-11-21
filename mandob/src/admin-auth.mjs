import { passkeySession } from "./passkeys.mjs";
import { requireValue, equal } from "./security.mjs";
const decode = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
export async function authenticateAdmin(req, env, fetcher = fetch) {
  if (env.ADMIN_AUTH_MODE === "passkey") {
    const session = await passkeySession(req, env);
    return { subject: session.credential_id, mode: "passkey" };
  }
  if (env.ADMIN_AUTH_MODE === "access") {
    requireValue(
      /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(
        env.ACCESS_ISSUER || "",
      ) &&
        env.ACCESS_AUD &&
        env.ACCESS_ADMIN_EMAILS,
      503,
      "access_not_configured",
    );
    try {
      const jwt = req.headers.get("cf-access-jwt-assertion") || "";
      requireValue(jwt.length < 16000, 401, "unauthorized");
      const parts = jwt.split(".");
      requireValue(parts.length === 3, 401, "unauthorized");
      const header = JSON.parse(new TextDecoder().decode(decode(parts[0]))),
        claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
      const now = Date.now() / 1000;
      requireValue(
        header.alg === "RS256" &&
          typeof header.kid === "string" &&
          claims.iss === env.ACCESS_ISSUER &&
          Array.isArray(claims.aud) &&
          claims.aud.includes(env.ACCESS_AUD) &&
          Number.isFinite(claims.exp) &&
          claims.exp > now &&
          Number.isFinite(claims.iat) &&
          claims.iat <= now + 60 &&
          (!claims.nbf || claims.nbf <= now + 60) &&
          typeof claims.sub === "string" &&
          claims.sub.length > 0,
        401,
        "unauthorized",
      );
      requireValue(
        typeof claims.email === "string" &&
          env.ACCESS_ADMIN_EMAILS.split(",")
            .map((x) => x.trim().toLowerCase())
            .includes(claims.email.toLowerCase()),
        403,
        "admin_denied",
      );
      const r = await fetcher(env.ACCESS_ISSUER + "/cdn-cgi/access/certs", {
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      requireValue(r.ok, 401, "unauthorized");
      const keys = (await r.json()).keys;
      requireValue(
        Array.isArray(keys) && keys.length <= 20,
        401,
        "unauthorized",
      );
      const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
      requireValue(jwk, 401, "unauthorized");
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      requireValue(
        await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          decode(parts[2]),
          new TextEncoder().encode(parts[0] + "." + parts[1]),
        ),
        401,
        "unauthorized",
      );
      return { subject: claims.sub, mode: "access" };
    } catch (e) {
      if (e.status) throw e;
      requireValue(false, 401, "unauthorized");
    }
  }
  requireValue(
    env.ADMIN_AUTH_MODE === "local_bearer" &&
      env.LOCAL_TEST_ONLY === "true" &&
      env.FREE_ONLY !== "true",
    503,
    "private_auth_required",
  );
  requireValue(env.ADMIN_TOKEN?.length >= 32, 503, "admin_not_configured");
  const token = req.headers.get("authorization") || "";
  requireValue(
    token.startsWith("Bearer ") &&
      (await equal(token.slice(7), env.ADMIN_TOKEN)),
    401,
    "unauthorized",
  );
  return { mode: "local_bearer" };
}
