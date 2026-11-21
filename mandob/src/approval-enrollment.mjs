import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { hash, requireValue, Problem, json } from "./security.mjs";

// These routes never approve requests. Only the authenticated Cloudflare control
// plane/operator may insert the single exact fingerprint-bound approval.
export async function approvalEnrollment(req, env, d, tools) {
  const {
    random,
    cookie,
    readCookie,
    challenge,
    consume,
    from64,
    to64,
    requireTopLevel,
  } = tools;
  const path = new URL(req.url).pathname,
    now = Date.now();
  const window = await env.DB.prepare(
    "SELECT * FROM admin_enrollment_windows WHERE slot=1 AND expires_at>? AND created_at<=? AND expires_at-created_at<=900000",
  )
    .bind(now, now)
    .first();
  requireValue(
    window &&
      !(await env.DB.prepare(
        "SELECT slot FROM admin_credentials WHERE slot=1",
      ).first()),
    403,
    "enrollment_closed",
  );
  if (path === "/auth/enrollment/options") {
    const reserved = await env.DB.prepare(
      "UPDATE admin_enrollment_windows SET issued=issued+1 WHERE slot=1 AND id=? AND expires_at>? AND issued<5 RETURNING id",
    )
      .bind(window.id, now)
      .first();
    requireValue(reserved, 429, "enrollment_window_limit");
    const handle = random(),
      c = await challenge(env, "approval_register", handle, {
        windowId: window.id,
      });
    const options = await generateRegistrationOptions({
      rpName: "Mandob Baghdad Admin",
      rpID: env.WEBAUTHN_RP_ID,
      userID: from64(handle),
      userName: "mandob-admin-pending",
      challenge: from64(c.value),
      attestationType: "none",
      supportedAlgorithmIDs: [-7],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
    });
    return new Response(JSON.stringify(options), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie("challenge", c.id, 300),
      },
    });
  }
  if (path === "/auth/enrollment/verify") {
    const c = await consume(req, env, "approval_register");
    requireValue(c.approval_window_id === window.id, 401, "challenge_invalid");
    requireTopLevel(d);
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: d,
        expectedChallenge: c.challenge,
        expectedOrigin: env.ADMIN_ORIGIN,
        expectedRPID: env.WEBAUTHN_RP_ID,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7],
      });
    } catch {
      throw new Problem(401, "passkey_invalid");
    }
    requireValue(
      result.verified && result.registrationInfo?.userVerified,
      401,
      "passkey_invalid",
    );
    const credential = result.registrationInfo.credential;
    const id = crypto.randomUUID(),
      browser = random(),
      key = to64(credential.publicKey),
      expires = Math.min(now + 900000, window.expires_at);
    const fingerprint = await hash(
      JSON.stringify({
        origin: env.ADMIN_ORIGIN,
        rpID: env.WEBAUTHN_RP_ID,
        window: window.id,
        id,
        credential: credential.id,
        key,
        handle: c.user_handle,
      }),
    );
    await env.DB.prepare(
      "INSERT INTO admin_enrollment_requests(id,window_id,browser_hash,credential_id,public_key,counter,user_handle,fingerprint,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        window.id,
        await hash(browser),
        credential.id,
        key,
        credential.counter,
        c.user_handle,
        fingerprint,
        now,
        expires,
      )
      .run();
    return new Response(
      JSON.stringify({
        id,
        fingerprint,
        status: "pending",
        expires_at: expires,
        notice: "هذا رقم طلب غير سري، وليس موافقة أو إثبات ملكية الحساب.",
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": cookie(
            "enrollment",
            browser,
            Math.max(1, Math.floor((expires - now) / 1000)),
          ),
        },
      },
    );
  }
  const browser = readCookie(req, "enrollment");
  requireValue(
    /^[A-Za-z0-9_-]{43}$/.test(browser),
    401,
    "enrollment_request_invalid",
  );
  const row = await env.DB.prepare(
    "SELECT * FROM admin_enrollment_requests WHERE browser_hash=? AND window_id=? AND expires_at>?",
  )
    .bind(await hash(browser), window.id, now)
    .first();
  requireValue(row, 401, "enrollment_request_invalid");
  const decision = await env.DB.prepare(
    "SELECT * FROM admin_enrollment_approvals WHERE slot=1 AND request_id=? AND window_id=? AND fingerprint=? AND approved_at<=? AND expires_at>?",
  )
    .bind(row.id, window.id, row.fingerprint, now, now)
    .first();
  if (path === "/auth/enrollment/check")
    return json({
      id: row.id,
      fingerprint: row.fingerprint,
      status:
        row.state === "denied"
          ? "denied"
          : decision && row.state === "pending"
            ? "approved"
            : "pending",
      expires_at: row.expires_at,
    });
  requireValue(row.state === "pending" && decision, 403, "approval_required");
  if (path === "/auth/enrollment/activate-options") {
    const c = await challenge(env, "approval_activate", row.user_handle, {
      windowId: window.id,
      requestId: row.id,
    });
    const options = await generateAuthenticationOptions({
      rpID: env.WEBAUTHN_RP_ID,
      challenge: from64(c.value),
      userVerification: "required",
      allowCredentials: [{ id: row.credential_id }],
    });
    return new Response(JSON.stringify(options), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie("challenge", c.id, 300),
      },
    });
  }
  if (path === "/auth/enrollment/activate") {
    const c = await consume(req, env, "approval_activate");
    requireValue(
      c.approval_window_id === window.id &&
        c.enrollment_request_id === row.id &&
        c.user_handle === row.user_handle,
      401,
      "challenge_invalid",
    );
    requireValue(
      d.id === row.credential_id &&
        (!d.response?.userHandle || d.response.userHandle === row.user_handle),
      401,
      "passkey_invalid",
    );
    requireTopLevel(d);
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: d,
        expectedChallenge: c.challenge,
        expectedOrigin: env.ADMIN_ORIGIN,
        expectedRPID: env.WEBAUTHN_RP_ID,
        credential: {
          id: row.credential_id,
          publicKey: from64(row.public_key),
          counter: row.counter,
        },
        requireUserVerification: true,
      });
    } catch {
      throw new Problem(401, "passkey_invalid");
    }
    requireValue(
      result.verified && result.authenticationInfo.userVerified,
      401,
      "passkey_invalid",
    );
    // Recheck approval, expiry and exact immutable key at the atomic credential insert.
    const inserted = await env.DB.prepare(
      "INSERT INTO admin_credentials(slot,id,public_key,counter,user_handle,created_at) SELECT 1,r.credential_id,r.public_key,?,r.user_handle,? FROM admin_enrollment_requests r JOIN admin_enrollment_approvals a ON a.request_id=r.id AND a.window_id=r.window_id AND a.fingerprint=r.fingerprint JOIN admin_enrollment_windows w ON w.id=r.window_id WHERE r.id=? AND r.state='pending' AND r.expires_at>? AND a.expires_at>? AND w.expires_at>? AND NOT EXISTS(SELECT 1 FROM admin_credentials) RETURNING id",
    )
      .bind(
        result.authenticationInfo.newCounter,
        Date.now(),
        row.id,
        Date.now(),
        Date.now(),
        Date.now(),
      )
      .first();
    requireValue(inserted, 409, "enrollment_closed");
    await env.DB.prepare(
      "UPDATE admin_enrollment_requests SET state='consumed' WHERE id=?",
    )
      .bind(row.id)
      .run();
    return new Response(
      JSON.stringify({
        ok: true,
        notice: "تم تفعيل المفتاح الموافق عليه. ادخل الآن بمفتاح المرور.",
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": cookie("enrollment", "", 0),
        },
      },
    );
  }
  throw new Problem(404, "not_found");
}
