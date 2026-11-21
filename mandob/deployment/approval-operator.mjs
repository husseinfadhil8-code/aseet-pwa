// LOCAL preparation only: no network calls, SQL execution, or public endpoint.
// The operator must authenticate to the correct Cloudflare account separately.
const ACCOUNT = "b2095b7419974a8e91484f2f1169f482",
  DATABASE = "a28b6985-e1dc-4eae-b422-fdb04419e89a";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function operatorApproval({
  accountId,
  databaseId,
  requestId,
  fingerprint,
  verificationRef,
  now = Date.now(),
}) {
  if (
    accountId !== ACCOUNT ||
    databaseId !== DATABASE ||
    !uuid.test(requestId) ||
    !/^[a-f0-9]{64}$/.test(fingerprint) ||
    typeof verificationRef !== "string" ||
    verificationRef.trim().length < 12 ||
    verificationRef.length > 200
  )
    throw Error(
      "Explicit account, database, exact request fingerprint and trusted identity verification reference required",
    );
  return {
    sql: "INSERT INTO admin_enrollment_approvals(slot,request_id,window_id,fingerprint,approved_at,expires_at,verification_ref) SELECT 1,r.id,r.window_id,r.fingerprint,?,MIN(r.expires_at,?),? FROM admin_enrollment_requests r JOIN admin_enrollment_windows w ON w.id=r.window_id WHERE r.id=? AND r.fingerprint=? AND r.state='pending' AND r.expires_at>? AND w.expires_at>? AND NOT EXISTS(SELECT 1 FROM admin_credentials) AND NOT EXISTS(SELECT 1 FROM admin_enrollment_approvals) RETURNING request_id,fingerprint",
    params: [
      now,
      now + 300000,
      verificationRef,
      requestId,
      fingerprint,
      now,
      now,
    ],
  };
}

export function operatorWindow({
  accountId,
  databaseId,
  now = Date.now(),
  minutes = 10,
}) {
  if (
    accountId !== ACCOUNT ||
    databaseId !== DATABASE ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > 15
  )
    throw Error("Wrong pilot identity or window duration");
  const id = crypto.randomUUID();
  return {
    id,
    sql: "INSERT INTO admin_enrollment_windows(slot,id,created_at,expires_at,issued) SELECT 1,?,?,?,0 WHERE NOT EXISTS(SELECT 1 FROM admin_credentials) ON CONFLICT(slot) DO UPDATE SET id=excluded.id,created_at=excluded.created_at,expires_at=excluded.expires_at,issued=0 WHERE admin_enrollment_windows.expires_at<=? AND NOT EXISTS(SELECT 1 FROM admin_credentials) RETURNING id",
    params: [id, now, now + minutes * 60000, now],
  };
}
// snapshot must come from the operator's authenticated Cloudflare settings read,
// never a browser POST or a user-supplied screenshot/JSON. No public API uses it.
export function ownerMarker(snapshot, requestId, fingerprint) {
  if (
    snapshot?.accountId !== ACCOUNT ||
    snapshot?.worker !== "mandob-baghdad-api" ||
    !uuid.test(requestId) ||
    !/^[a-f0-9]{64}$/.test(fingerprint)
  )
    throw Error("Owner proof mismatch");
  const matches = snapshot.bindings?.filter(
    (b) => b.name === "ADMIN_ENROLLMENT_OWNER_PROOF",
  );
  if (
    matches?.length !== 1 ||
    matches[0].type !== "plain_text" ||
    matches[0].text !== requestId + ":" + fingerprint
  )
    throw Error("Exact owner control-plane marker is required");
  return "cloudflare-owner-marker:" + requestId;
}
