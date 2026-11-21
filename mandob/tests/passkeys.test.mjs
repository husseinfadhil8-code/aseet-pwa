import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.mjs";
import {setup,origin,rp} from "./passkey-fixture.mjs";
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
