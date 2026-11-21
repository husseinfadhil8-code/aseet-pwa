import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(
    readFileSync(
      new URL("../migrations/0001_memory.sql", import.meta.url),
      "utf8",
    ),
  );
  sql.exec(
    readFileSync(
      new URL("../migrations/0002_attachment_review.sql", import.meta.url),
      "utf8",
    ),
  );
  sql.exec(readFileSync(new URL('../migrations/0003_ai_analyses.sql',import.meta.url),'utf8'));
  sql.exec(readFileSync(new URL('../migrations/0004_ai_reservations.sql',import.meta.url),'utf8'));
  sql.exec(readFileSync(new URL('../migrations/0005_passkeys.sql',import.meta.url),'utf8'));
  const wrap = (query, args = []) => ({
    bind(...a) {
      return wrap(query, a);
    },
    async first() {
      return sql.prepare(query).get(...args) || null;
    },
    async all() {
      return { results: sql.prepare(query).all(...args) };
    },
    async run() {
      return { meta: sql.prepare(query).run(...args) };
    },
  });
  const env = {
    PAGE_ID: "111",
    ADMIN_AUTH_MODE: "local_bearer",
    LOCAL_TEST_ONLY: "true",
    DATA_KEY: "a".repeat(64),
    META_APP_SECRET: "test-secret-not-real",
    META_VERIFY_TOKEN: "verify",
    ADMIN_TOKEN: "admin-test-".repeat(5),
    GRAPH_VERSION: "v23.0",
    DB: {
      prepare: (q) => wrap(q),
      async batch(list) {
        sql.exec("BEGIN");
        try {
          const r = [];
          for (const s of list) r.push(await s.run());
          sql.exec("COMMIT");
          return r;
        } catch (e) {
          sql.exec("ROLLBACK");
          throw e;
        }
      },
    },
    ASSETS: {
      async fetch(r) {
        const p = new URL(r.url).pathname;
        const type = p.endsWith(".js")
          ? "application/javascript"
          : p.endsWith(".css")
            ? "text/css"
            : "text/html";
        return new Response(
          readFileSync(new URL("../public" + p, import.meta.url)),
          { headers: { "Content-Type": type } },
        );
      },
    },
  };
  return { env, sql };
}
export const event = (text, mid = "m1", sender = "222", attachments = []) => ({
  sender: { id: sender },
  recipient: { id: "111" },
  timestamp: Date.now(),
  message: { mid, text, attachments },
});
export const image = (url) => ({ type: "image", payload: { url } });
export function req(env, path, method = "GET", data) {
  return new Request("https://mandob.test" + path, {
    method,
    headers: {
      Authorization: "Bearer " + env.ADMIN_TOKEN,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}
