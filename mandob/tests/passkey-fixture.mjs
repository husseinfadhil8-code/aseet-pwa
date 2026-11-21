import assert from "node:assert/strict";
import { encodeCBOR } from "@levischuck/tiny-cbor";
import { fixture } from "./helpers.mjs";
import { hash } from "../src/security.mjs";
import worker from "../src/worker.mjs";
const origin = "https://admin.example.test",
  rp = "admin.example.test";
const b64 = (x) => Buffer.from(x).toString("base64url");
const bytes = (x) => Buffer.from(x, "base64url");
const concat = (...x) => Buffer.concat(x.map((a) => Buffer.from(a)));
async function sha(x) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", x));
}
function der(raw) {
  const int = (a) => {
    let b = Buffer.from(a);
    while (b.length > 1 && b[0] === 0) b = b.subarray(1);
    if (b[0] & 128) b = concat([0], b);
    return concat([2, b.length], b);
  };
  const parts = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat([0x30, parts.length], parts);
}
async function setup(native = {}) {
  const f = fixture();
  if (native.DB) f.env.DB = native.DB;
  Object.assign(f.env, {
    ADMIN_AUTH_MODE: "passkey",
    ADMIN_ORIGIN: origin,
    WEBAUTHN_RP_ID: rp,
    FREE_ONLY: "true",
  });
  const code = b64(crypto.getRandomValues(new Uint8Array(32)));
  if (!native.noBootstrap)
    await f.env.DB.prepare(
      "INSERT INTO admin_bootstrap(slot,code_hash,expires_at) VALUES(1,?,?)",
    )
      .bind(await hash(code), Date.now() + 300000)
      .run();
  const key = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
  const id = crypto.getRandomValues(new Uint8Array(32));
  const cookies = new Map();
  const cookieString = () =>
    [...cookies].map(([k, v]) => k + "=" + v).join("; ");
  async function call(path, data, headers = {}) {
    const request = new Request(origin + path, {
      method:
        data === undefined
          ? "GET"
          : path === "/api/settings"
            ? "PATCH"
            : "POST",
      headers: {
        ...(data === undefined
          ? {}
          : { Origin: origin, "Content-Type": "application/json" }),
        Cookie: cookieString(),
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const r = native.dispatch
      ? await native.dispatch(request)
      : await worker.fetch(request, f.env);
    const set = r.headers.get("set-cookie");
    if (set) {
      const pair = set.split(";")[0],
        at = pair.indexOf("=");
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return r;
  }
  const client = (type, challenge, site = origin) =>
    Buffer.from(
      JSON.stringify({ type, challenge, origin: site, crossOrigin: false }),
    );
  async function registration(options, { flags = 0x45, site = origin } = {}) {
    const cd = client("webauthn.create", options.challenge, site);
    const cose = encodeCBOR(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, bytes(jwk.x)],
        [-3, bytes(jwk.y)],
      ]),
    );
    const ad = concat(
      await sha(Buffer.from(rp)),
      [flags],
      [0, 0, 0, 0],
      new Uint8Array(16),
      [0, id.length],
      id,
      cose,
    );
    return {
      id: b64(id),
      rawId: b64(id),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(cd),
        attestationObject: b64(
          encodeCBOR(
            new Map([
              ["fmt", "none"],
              ["attStmt", new Map()],
              ["authData", new Uint8Array(ad)],
            ]),
          ),
        ),
        transports: ["internal"],
      },
    };
  }
  async function assertion(
    options,
    {
      flags = 5,
      site = origin,
      counter = 1,
      challenge = options.challenge,
      wrongKey = false,
    } = {},
  ) {
    const cd = client("webauthn.get", challenge, site),
      count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const ad = concat(await sha(Buffer.from(rp)), [flags], count);
    const signing = wrongKey
      ? (
          await crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"],
          )
        ).privateKey
      : key.privateKey;
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signing,
      concat(ad, await sha(cd)),
    );
    return {
      id: b64(id),
      rawId: b64(id),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(cd),
        authenticatorData: b64(ad),
        signature: b64(der(new Uint8Array(sig))),
        userHandle: null,
      },
    };
  }
  async function enroll() {
    let r = await call("/auth/register/options", { code });
    assert.equal(r.status, 200);
    r = await call("/auth/register/verify", await registration(await r.json()));
    assert.equal(r.status, 200);
  }
  return {
    ...f,
    code,
    call,
    registration,
    assertion,
    enroll,
    getCookie: cookieString,
  };
}

export { setup, origin, rp };
