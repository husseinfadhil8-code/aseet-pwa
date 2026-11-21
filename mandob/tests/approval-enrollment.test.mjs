import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./passkey-fixture.mjs";
import { operatorApproval } from "../deployment/approval-operator.mjs";
const accountId = "b2095b7419974a8e91484f2f1169f482",
  databaseId = "a28b6985-e1dc-4eae-b422-fdb04419e89a";
async function pending() {
  const f = await setup({ noBootstrap: true });
  f.env.ALLOW_ADMIN_APPROVAL_ENROLLMENT = "true";
  const window = crypto.randomUUID(),
    now = Date.now();
  f.sql
    .prepare(
      "INSERT INTO admin_enrollment_windows(slot,id,created_at,expires_at) VALUES(1,?,?,?)",
    )
    .run(window, now, now + 900000);
  const options = await (await f.call("/auth/enrollment/options", {})).json();
  const r = await f.call(
    "/auth/enrollment/verify",
    await f.registration(options),
  );
  assert.equal(r.status, 200);
  const request = await r.json();
  return { ...f, request };
}
async function approve(f, fingerprint = f.request.fingerprint) {
  const op = operatorApproval({
    accountId,
    databaseId,
    requestId: f.request.id,
    fingerprint,
    verificationRef: "synthetic verified control-plane identity",
  });
  return f.env.DB.prepare(op.sql)
    .bind(...op.params)
    .first();
}
async function activate(f, options) {
  options ||= await (
    await f.call("/auth/enrollment/activate-options", {})
  ).json();
  return f.call("/auth/enrollment/activate", await f.assertion(options));
}
test("pending registration never creates an administrator; exact operator approval and fresh signature required", async () => {
  const f = await pending();
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM admin_credentials").get().n,
    0,
  );
  assert.equal((await f.call("/api/items")).status, 401);
  assert.equal((await f.call("/auth/login/options", {})).status, 403);
  assert.equal(
    (await f.call("/auth/enrollment/activate-options", {})).status,
    403,
  );
  assert.equal((await f.call("/auth/enrollment/check", {})).status, 200);
  assert(await approve(f));
  assert.equal((await activate(f)).status, 200);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM admin_credentials").get().n,
    1,
  );
  assert.equal(
    f.sql.prepare("SELECT state FROM admin_enrollment_requests").get().state,
    "consumed",
  );
});
test("request number alone, spoofed admin role and another browser cannot check or activate", async () => {
  const f = await pending();
  await approve(f);
  assert.equal(
    (
      await f.call(
        "/auth/enrollment/check",
        { id: f.request.id, role: "admin" },
        { Cookie: "" },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call(
        "/auth/enrollment/activate-options",
        { id: f.request.id },
        { Cookie: "" },
      )
    ).status,
    401,
  );
  assert.notEqual(
    (
      await f.call("/auth/enrollment/approve", {
        id: f.request.id,
        approved: true,
      })
    ).status,
    200,
  );
});
test("immutable request key, wrong fingerprint and wrong signing key cannot be approved or substituted", async () => {
  const f = await pending();
  assert.throws(
    () =>
      f.sql
        .prepare("UPDATE admin_enrollment_requests SET public_key='replaced'")
        .run(),
    /immutable/,
  );
  assert.equal(await approve(f, "0".repeat(64)), null);
  assert.equal(
    (await f.call("/auth/enrollment/activate-options", {})).status,
    403,
  );
  assert(await approve(f));
  const o = await (
    await f.call("/auth/enrollment/activate-options", {})
  ).json();
  assert.equal(
    (
      await f.call(
        "/auth/enrollment/activate",
        await f.assertion(o, { wrongKey: true }),
      )
    ).status,
    401,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM admin_credentials").get().n,
    0,
  );
});
test("approval revocation after challenge and expired window both fail closed", async () => {
  const f = await pending();
  await approve(f);
  const o = await (
    await f.call("/auth/enrollment/activate-options", {})
  ).json();
  f.sql.exec("DELETE FROM admin_enrollment_approvals");
  assert.equal((await activate(f, o)).status, 403);
  f.sql.exec("UPDATE admin_enrollment_windows SET expires_at=0");
  assert.equal((await f.call("/auth/enrollment/check", {})).status, 403);
});
test("feature default closed, operator window mandatory, five-reservation cap and no legacy bypass", async () => {
  const f = await setup();
  assert.equal((await f.call("/auth/enrollment/options", {})).status, 503);
  f.env.ALLOW_ADMIN_APPROVAL_ENROLLMENT = "true";
  assert.equal((await f.call("/auth/enrollment/options", {})).status, 403);
  assert.equal(
    (await f.call("/auth/register/options", { code: f.code })).status,
    403,
  );
  const now = Date.now();
  f.sql
    .prepare(
      "INSERT INTO admin_enrollment_windows(slot,id,created_at,expires_at) VALUES(1,?,?,?)",
    )
    .run(crypto.randomUUID(), now, now + 900000);
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await f.call(
          "/auth/enrollment/options",
          {},
          { "cf-connecting-ip": "synthetic-" + i },
        )
      ).status,
      200,
    );
  assert.equal(
    (
      await f.call(
        "/auth/enrollment/options",
        {},
        { "cf-connecting-ip": "synthetic-last" },
      )
    ).status,
    429,
  );
  assert.equal(
    f.sql.prepare("SELECT issued FROM admin_enrollment_windows").get().issued,
    5,
  );
});
test("approval helper rejects other project/account and missing trusted verification evidence", () => {
  for (const change of [
    { accountId: "wrong" },
    { databaseId: "07dc23a5-2b16-46e3-ab3a-180fc1fddf79" },
    { verificationRef: "" },
  ])
    assert.throws(() =>
      operatorApproval({
        accountId,
        databaseId,
        requestId: crypto.randomUUID(),
        fingerprint: "0".repeat(64),
        verificationRef: "synthetic evidence only",
        ...change,
      }),
    );
});
test("operator window cannot reset a live quota and owner marker must come from exact account/worker/key", async () => {
  const { operatorWindow, ownerMarker } =
    await import("../deployment/approval-operator.mjs");
  const f = await setup({ noBootstrap: true });
  const w = operatorWindow({ accountId, databaseId });
  assert(
    await f.env.DB.prepare(w.sql)
      .bind(...w.params)
      .first(),
  );
  const again = operatorWindow({ accountId, databaseId });
  assert.equal(
    await f.env.DB.prepare(again.sql)
      .bind(...again.params)
      .first(),
    null,
  );
  const id = crypto.randomUUID(),
    fp = "a".repeat(64),
    snapshot = {
      accountId,
      worker: "mandob-baghdad-api",
      bindings: [
        {
          name: "ADMIN_ENROLLMENT_OWNER_PROOF",
          type: "plain_text",
          text: id + ":" + fp,
        },
      ],
    };
  assert.match(ownerMarker(snapshot, id, fp), /^cloudflare-owner-marker/);
  assert.throws(() => ownerMarker(snapshot, id, "b".repeat(64)));
  assert.throws(() => ownerMarker({ ...snapshot, accountId: "wrong" }, id, fp));
});
test("expired approval cannot activate; duplicate activation never creates another admin", async () => {
  const f = await pending();
  await approve(f);
  f.sql.exec("UPDATE admin_enrollment_approvals SET expires_at=0");
  assert.equal(
    (await f.call("/auth/enrollment/activate-options", {})).status,
    403,
  );
  f.sql.exec("DELETE FROM admin_enrollment_approvals");
  assert(await approve(f));
  assert.equal((await activate(f)).status, 200);
  assert.equal(
    (await f.call("/auth/enrollment/activate-options", {})).status,
    403,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM admin_credentials").get().n,
    1,
  );
});
test("cross-site request denied before reserving quota; approving a different key never approves this browser", async () => {
  const f = await pending();
  assert.equal(
    (
      await f.call(
        "/auth/enrollment/options",
        {},
        { Origin: "https://evil.test" },
      )
    ).status,
    403,
  );
  const other = crypto.randomUUID();
  f.sql
    .prepare("INSERT INTO admin_enrollment_approvals VALUES(1,?,?,?,?,?,?)")
    .run(
      other,
      "other-window",
      "a".repeat(64),
      Date.now(),
      Date.now() + 60000,
      "synthetic unrelated decision",
    );
  assert.equal(
    (await f.call("/auth/enrollment/activate-options", {})).status,
    403,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM admin_credentials").get().n,
    0,
  );
});
test("approval revoked after signature verification is rechecked atomically before credential creation", async () => {
  const f = await pending();
  await approve(f);
  const o = await (
    await f.call("/auth/enrollment/activate-options", {})
  ).json();
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = (q) => {
    if (
      q.startsWith("INSERT INTO admin_credentials") &&
      q.includes("admin_enrollment_requests")
    )
      f.sql.exec("DELETE FROM admin_enrollment_approvals");
    return prepare(q);
  };
  assert.equal((await activate(f, o)).status, 409);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM admin_credentials").get().n,
    0,
  );
});
