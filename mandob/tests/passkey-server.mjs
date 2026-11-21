// Local loopback-only test fixture. No remote calls, no real credentials.
import { createServer } from "node:http";
import worker from "../src/worker.mjs";
import { fixture } from "./helpers.mjs";
import { hash } from "../src/security.mjs";
const { env } = fixture();
Object.assign(env, {
  ADMIN_AUTH_MODE: "passkey",
  ADMIN_ORIGIN: "https://admin.example.test",
  WEBAUTHN_RP_ID: "admin.example.test",
  FREE_ONLY: "true",
  ALLOW_MESSENGER_INTAKE: "false",
});
await env.DB.prepare(
  "INSERT INTO admin_bootstrap(slot,code_hash,expires_at) VALUES(1,?,?)",
)
  .bind(await hash("x".repeat(43)), Date.now() + 300000)
  .run();
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await worker.fetch(
    new Request(env.ADMIN_ORIGIN + req.url, {
      method: req.method,
      headers: req.headers,
      ...(!["GET", "HEAD"].includes(req.method)
        ? { body: Buffer.concat(chunks) }
        : {}),
    }),
    env,
  );
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(4390, "127.0.0.1", () =>
  console.log("Synthetic passkey fixture ready on loopback"),
);
