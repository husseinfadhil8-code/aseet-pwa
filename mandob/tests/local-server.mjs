// Loopback only. Entire database and identities are synthetic test fixtures.
import { createServer } from "node:http";
import worker from "../src/worker.mjs";
import { fixture, event, image } from "./helpers.mjs";
import { receive, drain } from "../src/memory.mjs";
const { env } = fixture();
await receive(
  env,
  event(
    "ثلاجة مستعملة للبيع السعر: ٣٠٠ ألف\nالمنطقة: المنصور",
    "seller1",
    "222",
    [image("https://cdn.fbcdn.net/example.jpg")],
  ),
);
await drain(env);
await receive(
  env,
  event("كاونتر للبيع السعر: ١٥٠ ألف\nالمنطقة: الكرادة", "seller2", "444"),
);
await drain(env);
await receive(env, event("اريد ثلاجة", "buyer", "333"));
await drain(env);
createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request("http://127.0.0.1:4389" + req.url, {
      method: req.method,
      headers: req.headers,
      ...(!["GET", "HEAD"].includes(req.method)
        ? { body: Buffer.concat(chunks) }
        : {}),
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end("test_server_error");
  }
}).listen(4389, "127.0.0.1", () => console.log("Test-only local Mandob ready"));
