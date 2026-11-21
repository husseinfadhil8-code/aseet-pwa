import test from "node:test";
import assert from "node:assert/strict";
import { setup, origin, rp } from "./passkey-fixture.mjs";
import { operatorApproval } from "../deployment/approval-operator.mjs";
test(
  "native workerd/D1 approval request requires exact operator decision and fresh key assertion",
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
          ALLOW_ADMIN_APPROVAL_ENROLLMENT: "true",
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
        noBootstrap: true,
        dispatch: async (r) =>
          mf.dispatchFetch(r.url, {
            method: r.method,
            headers: Object.fromEntries(r.headers),
            ...(!["GET", "HEAD"].includes(r.method)
              ? { body: await r.arrayBuffer() }
              : {}),
          }),
      });
      const now = Date.now();
      await DB.prepare("INSERT INTO admin_enrollment_windows VALUES(1,?,?,?,0)")
        .bind(crypto.randomUUID(), now, now + 900000)
        .run();
      let r = await f.call("/auth/enrollment/options", {});
      assert.equal(r.status, 200);
      r = await f.call(
        "/auth/enrollment/verify",
        await f.registration(await r.json()),
      );
      assert.equal(r.status, 200);
      const pending = await r.json();
      assert.equal((await f.call("/api/items")).status, 401);
      const decision = operatorApproval({
        accountId: "b2095b7419974a8e91484f2f1169f482",
        databaseId: "a28b6985-e1dc-4eae-b422-fdb04419e89a",
        requestId: pending.id,
        fingerprint: pending.fingerprint,
        verificationRef: "synthetic trusted operator evidence",
      });
      assert(
        await DB.prepare(decision.sql)
          .bind(...decision.params)
          .first(),
      );
      const o = await (
        await f.call("/auth/enrollment/activate-options", {})
      ).json();
      r = await f.call("/auth/enrollment/activate", await f.assertion(o));
      assert.equal(r.status, 200);
      const login = await (await f.call("/auth/login/options", {})).json();
      r = await f.call(
        "/auth/login/verify",
        await f.assertion(login, { counter: 2 }),
      );
      assert.equal(r.status, 200);
      assert.equal((await f.call("/api/settings")).status, 200);
    } finally {
      await mf.dispose();
    }
  },
);
