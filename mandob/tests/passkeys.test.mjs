import test from "node:test";
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
  let cookie = "";
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
        Cookie: cookie,
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const r = native.dispatch
      ? await native.dispatch(request)
      : await worker.fetch(request, f.env);
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
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
    getCookie: () => cookie,
  };
}

test("real synthetic WebAuthn registration/signature login, protected data, CSRF, secure cookies and revocation", async () => {
  const f = await setup();
  let r = await f.call("/api/items");
  assert.equal(r.status, 401);
  assert.equal((await f.call("/")).status, 303);
  assert.equal((await f.call("/login")).status, 200);
  await f.enroll();
  assert.equal(
    (await f.call("/auth/register/options", { code: f.code })).status,
    403,
  );
  r = await f.call("/auth/login/options", {});
  const options = await r.json(),
    assertion = await f.assertion(options);
  r = await f.call("/auth/login/verify", assertion);
  assert.equal(r.status, 200);
  assert.match(
    r.headers.get("set-cookie"),
    /HttpOnly; Secure; SameSite=Strict/,
  );
  const { csrf } = await r.json();
  assert.equal((await f.call("/api/items")).status, 200);
  assert.equal((await f.call("/auth/session")).status, 200);
  assert.equal((await f.call("/api/settings", { ai: true })).status, 403);
  assert.equal(
    (await f.call("/api/settings", { ai: false }, { "X-CSRF-Token": csrf }))
      .status,
    200,
  );
  assert.equal(
    (
      await f.call(
        "/api/settings",
        { ai: false },
        { "X-CSRF-Token": csrf, Origin: "https://evil.test" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.call("/auth/revoke-all", {}, { "X-CSRF-Token": csrf })).status,
    200,
  );
  assert.equal((await f.call("/api/items")).status, 401);
});
test("one-use challenge is browser-bound, replayed response rejected", async () => {
  const f = await setup();
  await f.enroll();
  let r = await f.call("/auth/login/options", {}),
    o = await r.json(),
    a = await f.assertion(o);
  const originalChallengeCookie = f.getCookie();
  r = await f.call("/auth/login/verify", a, { Cookie: "" });
  assert.equal(r.status, 401);
  r = await f.call("/auth/login/verify", a);
  assert.equal(r.status, 200);
  r = await f.call("/auth/login/verify", a, {Cookie:originalChallengeCookie});
  assert.equal(r.status, 401);
});
for (const [name, opts] of [
  ["wrong origin", { site: "https://evil.test" }],
  ["missing user verification", { flags: 1 }],
  ["wrong challenge", { challenge: "bad" }],
  ["forged signature", { wrongKey: true }],
])
  test("reject " + name, async () => {
    const f = await setup();
    await f.enroll();
    const o = await (await f.call("/auth/login/options", {})).json();
    assert.equal(
      (await f.call("/auth/login/verify", await f.assertion(o, opts))).status,
      401,
    );
  });
test("expired challenges/bootstrap, unknown credential and rate limit fail closed", async () => {
  const f = await setup();
  f.sql.exec("UPDATE admin_bootstrap SET expires_at=0");
  assert.equal(
    (await f.call("/auth/register/options", { code: f.code })).status,
    403,
  );
  for (let i = 0; i < 10; i++) await f.call("/auth/login/options", {});
  assert.equal((await f.call("/auth/login/options", {})).status, 429);
});
test("registration requires UV and cannot be completed from unrelated origin", async () => {
  const f = await setup();
  const o = await (
    await f.call("/auth/register/options", { code: f.code })
  ).json();
  assert.equal(
    (
      await f.call(
        "/auth/register/verify",
        await f.registration(o, { flags: 0x41 }),
      )
    ).status,
    401,
  );
  assert.equal(
    (await f.call("/auth/register/verify", await f.registration(o))).status,
    401,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM admin_credentials").get().n,
    0,
  );
});
test("expired challenges and sessions rejected; counter rollback and wrong credential rejected", async () => {
  const f = await setup();
  await f.enroll();
  let o = await (await f.call("/auth/login/options", {})).json();
  f.sql.exec("UPDATE admin_challenges SET expires_at=0");
  assert.equal(
    (await f.call("/auth/login/verify", await f.assertion(o))).status,
    401,
  );
  o = await (await f.call("/auth/login/options", {})).json();
  assert.equal(
    (await f.call("/auth/login/verify", await f.assertion(o, { counter: 2 })))
      .status,
    200,
  );
  f.sql.exec("UPDATE admin_sessions SET expires_at=0");
  assert.equal((await f.call("/api/items")).status, 401);
  o = await (await f.call("/auth/login/options", {})).json();
  assert.equal(
    (await f.call("/auth/login/verify", await f.assertion(o, { counter: 1 })))
      .status,
    401,
  );
});
test("Meta webhook stays independent of administrator passkey login", async () => {
  const f = await setup();
  f.env.ALLOW_MESSENGER_INTAKE = "true";
  const r = await worker.fetch(
    new Request(
      origin +
        "/webhooks/meta/messenger?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=synthetic",
    ),
    f.env,
  );
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "synthetic");
  assert.equal((await f.call("/api/items")).status, 401);
});
test("concurrent bootstrap and repeated signed assertion each succeed only once", async () => {
  const f = await setup();
  const options = await Promise.all([
    f.call("/auth/register/options", { code: f.code }),
    f.call("/auth/register/options", { code: f.code }),
  ]);
  assert.deepEqual(options.map((x) => x.status).sort(), [200, 403]);
  const o = await options.find((x) => x.status === 200).json();
  assert.equal(
    (await f.call("/auth/register/verify", await f.registration(o))).status,
    200,
  );
  const a = await f.assertion(
    await (await f.call("/auth/login/options", {})).json(),
  );
  const replies = await Promise.all([
    f.call("/auth/login/verify", a),
    f.call("/auth/login/verify", a),
  ]);
  assert.deepEqual(replies.map((x) => x.status).sort(), [200, 401]);
});
test(
  "bundled workerd and native local D1 complete synthetic passkey login and revoke",
  { skip: !process.env.MANDOB_LOCAL_SDK },
  async () => {
    const { createRequire } = await import("node:module"),
      require = createRequire(import.meta.url),
      { spawnSync } = await import("node:child_process"),
      { fileURLToPath } = await import("node:url");
    const root = process.env.MANDOB_LOCAL_SDK,
      { build } = require(root + "/esbuild"),
      { Miniflare, convertV4MiniflareOptions } = require(root + "/miniflare");
    const bundle = await build({
      entryPoints: [
        fileURLToPath(new URL("../src/worker.mjs", import.meta.url)),
      ],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
    });
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-11-20",
        bindings: {
          ADMIN_AUTH_MODE: "passkey",
          ADMIN_ORIGIN: origin,
          WEBAUTHN_RP_ID: rp,
          FREE_ONLY: "true",
          PAGE_ID: "111",
          ALLOW_MESSENGER_INTAKE: "false",
        },
        d1Databases: { DB: "passkey-native-local" },
      }),
    );
    try {
      const DB = await mf.getD1Database("DB");
      const p = spawnSync(
        "python",
        [
          "-c",
          `import sqlite3,json,pathlib,sys
out=[]
for p in sorted(pathlib.Path(sys.argv[1]).glob('*.sql')):
 s=''
 for line in p.read_text().splitlines(True):
  s+=line
  if sqlite3.complete_statement(s):out.append(s);s=''
print(json.dumps(out))`,
          fileURLToPath(new URL("../migrations", import.meta.url)),
        ],
        { encoding: "utf8" },
      );
      assert.equal(p.status, 0);
      for (const q of JSON.parse(p.stdout)) await DB.prepare(q).run();
      const f = await setup({
        DB,
        dispatch: async (r) =>
          mf.dispatchFetch(r.url, {
            method: r.method,
            headers: Object.fromEntries(r.headers),
            ...(!["GET", "HEAD"].includes(r.method)
              ? { body: await r.arrayBuffer() }
              : {}),
          }),
      });
      await f.enroll();
      const o = await (await f.call("/auth/login/options", {})).json();
      let r = await f.call("/auth/login/verify", await f.assertion(o));
      assert.equal(r.status, 200);
      const { csrf } = await r.json();
      assert.equal((await f.call("/api/settings")).status, 200);
      assert.equal(
        (await f.call("/auth/revoke-all", {}, { "X-CSRF-Token": csrf })).status,
        200,
      );
      assert.equal((await f.call("/api/settings")).status, 401);
    } finally {
      await mf.dispose();
    }
  },
);
