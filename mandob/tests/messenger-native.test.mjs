import test from "node:test";
import assert from "node:assert/strict";
import { setup, origin, rp } from "./passkey-fixture.mjs";
import { hash } from "../src/security.mjs";
import { receive, drain } from "../src/memory.mjs";
import { event } from "./helpers.mjs";
test(
  "native signed Messenger pairing requires authenticated Passkey owner and keeps results private",
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
          ALLOW_MESSENGER_ADMIN: "true",
          META_APP_SECRET: "test-secret-not-real",
          DATA_KEY: "a".repeat(64),
          MESSENGER_INTAKE_MODE: "test",
          META_TEST_SENDER_HASHES: await hash("111:222"),
          META_ADMIN_EXPECTED_PSID_HASH:await hash("111:222"),
          ADMIN_ORIGIN: origin,
          WEBAUTHN_RP_ID: rp,
          FREE_ONLY: "true",
          PAGE_ID: "111",
          ALLOW_MESSENGER_INTAKE: "true",
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
      let options = await (await f.call("/auth/login/options", {})).json();
      let response = await f.call(
        "/auth/login/verify",
        await f.assertion(options),
      );
      assert.equal(response.status, 200);
      const csrf = (await response.json()).csrf;
      const headers = { "X-CSRF-Token": csrf };
      const ticket = await (
        await f.call("/api/messenger-admin/pair/start", {}, headers)
      ).json();
      assert(ticket.message);
      const sendEvent = async (e) => {
        const raw = JSON.stringify({
          object: "page",
          entry: [{ id: "111", messaging: [e] }],
        });
        const k = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode("test-secret-not-real"),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const sig = Buffer.from(
          await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(raw)),
        ).toString("hex");
        return mf.dispatchFetch(origin + "/webhooks/meta/messenger", {
          method: "POST",
          headers: { "x-hub-signature-256": "sha256=" + sig },
          body: raw,
        });
      };
      assert.equal(
        (await sendEvent(event(ticket.message, "link", "222"))).status,
        200,
      );
      const claim = await (
        await f.call(
          "/api/messenger-admin/pair/inspect",
          { id: ticket.id },
          headers,
        )
      ).json();
      assert.equal(
        (
          await f.call(
            "/api/messenger-admin/pair/confirm",
            { id: ticket.id, fingerprint: claim.fingerprint, confirmed: true },
            headers,
          )
        ).status,
        200,
      );
      await receive(
        f.env,
        event("تخم للبيع بسعر 300 ألف في المنصور", "sale", "333"),
      );
      await drain(f.env);
      assert.equal(
        (
          await sendEvent(
            event("منو صاحب التخم مال 300 ألف بالمنصور؟", "lookup", "222"),
          )
        ).status,
        200,
      );
      await f.call("/api/messenger-admin/process", {}, headers);
      const id = await hash("111:admin:lookup");
      let result;
      for (let i = 0; i < 5; i++) {
        result = await (await f.call("/api/messenger-admin/jobs/" + id)).json();
        if (result.result) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(result.result.items[0].seller.psid, "333");
      assert.equal(result.delivery, "draft_only_no_messages_sent");
      const unauth = await mf.dispatchFetch(
        origin + "/api/messenger-admin/jobs/" + id,
      );
      assert.equal(unauth.status, 401);
    } finally {
      await mf.dispose();
    }
  },
);
