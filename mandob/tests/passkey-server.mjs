import { writeFileSync } from "node:fs";
import { operatorApproval } from "../deployment/approval-operator.mjs";
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
if (process.env.LOCAL_APPROVAL_TEST === "true") {
  env.ALLOW_ADMIN_APPROVAL_ENROLLMENT = "true";
  const now = Date.now();
  await env.DB.prepare("INSERT INTO admin_enrollment_windows VALUES(1,?,?,?,0)")
    .bind(crypto.randomUUID(), now, now + 900000)
    .run();
  writeFileSync("/tmp/mandob-approval-test.pid", String(process.pid), {
    mode: 0o600,
  });
  process.on("SIGUSR1", async () => {
    const r = await env.DB.prepare(
      "SELECT * FROM admin_enrollment_requests WHERE state='pending'",
    ).first();
    if (!r) return;
    const op = operatorApproval({
      accountId: "b2095b7419974a8e91484f2f1169f482",
      databaseId: "a28b6985-e1dc-4eae-b422-fdb04419e89a",
      requestId: r.id,
      fingerprint: r.fingerprint,
      verificationRef: "local synthetic operator identity",
    });
    await env.DB.prepare(op.sql)
      .bind(...op.params)
      .run();
    console.log("Synthetic local approval committed");
  });
} else {
  await env.DB.prepare(
    "INSERT INTO admin_bootstrap(slot,code_hash,expires_at) VALUES(1,?,?)",
  )
    .bind(await hash("x".repeat(43)), Date.now() + 300000)
    .run();
}
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
