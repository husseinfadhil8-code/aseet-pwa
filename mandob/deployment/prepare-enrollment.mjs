// LOCAL ONLY. Produces sensitive operator artifacts; never calls Cloudflare.
// Apply the SQL only to the verified independent Mandob DB after authorization.
import { randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] || "");
if (!process.argv[2]) throw Error("A private output directory is required");
const code = randomBytes(32).toString("base64url");
const expires = Date.now() + 10 * 60 * 1000;
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(resolve(output, "bootstrap-code.txt"), code + "\n", {
  mode: 0o600,
  flag: "wx",
});
await writeFile(
  resolve(output, "bootstrap.sql"),
  `INSERT INTO admin_bootstrap(slot,code_hash,expires_at,used) SELECT 1,'${createHash("sha256").update(code).digest("hex")}',${expires},0 WHERE NOT EXISTS(SELECT 1 FROM admin_credentials) ON CONFLICT(slot) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,used=0 WHERE NOT EXISTS(SELECT 1 FROM admin_credentials);\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Private one-use enrollment artifacts prepared locally; no SQL applied and no code printed. Expires in 10 minutes.",
);
