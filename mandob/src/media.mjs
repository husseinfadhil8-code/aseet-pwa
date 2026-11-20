import { open, seal, requireValue, b64 } from "./security.mjs";
import { stmt } from "./memory.mjs";
import { settings, caption, indexItem } from "./ai.mjs";
export function imageType(b) {
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (
    b[0] === 137 &&
    b[1] === 80 &&
    b[2] === 78 &&
    b[3] === 71 &&
    b.length >= 24
  )
    return "image/png";
  if (
    String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}
export async function boundedImage(response) {
  requireValue(response.ok, 502, "image_unavailable");
  requireValue(
    Number(response.headers.get("content-length") || 0) <= 2097152,
    413,
    "image_too_large",
  );
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2097152) {
      await reader.cancel();
      throw new Error("image_too_large");
    }
    chunks.push(value);
  }
  const b = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    b.set(c, offset);
    offset += c.length;
  }
  requireValue(imageType(b), 415, "unsupported_image");
  return b;
}
export async function savePhotos(env, fetcher = fetch) {
  const s = await settings(env);
  if (!s.photos || !env.PHOTOS || env.ALLOW_MEDIA !== "true") return 0;
  const rows = await stmt(
    env,
    "SELECT * FROM media WHERE page_id=? AND state='pending' LIMIT 5",
    env.PAGE_ID,
  ).all();
  let saved = 0;
  for (const row of rows.results) {
    try {
      const source = await open(
        env,
        row.source_cipher,
        env.PAGE_ID + ":media:" + row.id,
      );
      const url = new URL(source);
      requireValue(
        url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.port &&
          (url.hostname.endsWith(".fbcdn.net") ||
            url.hostname.endsWith(".fbsbx.com")),
        400,
        "untrusted_image_host",
      );
      const response = await fetcher(url.href, {
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      const bytes = await boundedImage(response);
      const key = env.PAGE_ID + "/" + row.item_id + "/" + row.id;
      await env.PHOTOS.put(
        key,
        await seal(env, b64(bytes), env.PAGE_ID + ":photo:" + row.id),
        { httpMetadata: { contentType: "application/octet-stream" } },
      );
      await stmt(
        env,
        "UPDATE media SET object_key=?,state='stored',error=NULL WHERE id=? AND page_id=?",
        key,
        row.id,
        env.PAGE_ID,
      ).run();
      saved++;
      if ((await settings(env)).ai && env.ALLOW_AI === "true") {
        try {
          await indexPhotos(env, row.item_id);
        } catch {
          /* Stored image remains available for later manual indexing. */
        }
      }
    } catch {
      await stmt(
        env,
        "UPDATE media SET state='failed',error='image_storage_failed' WHERE id=? AND page_id=?",
        row.id,
        env.PAGE_ID,
      ).run();
    }
  }
  return saved;
}
export async function photoBytes(env, id) {
  requireValue(env.PHOTOS, 503, "private_storage_not_configured");
  const row = await stmt(
    env,
    "SELECT * FROM media WHERE id=? AND page_id=? AND state='stored'",
    id,
    env.PAGE_ID,
  ).first();
  requireValue(row, 404, "photo_not_found");
  const object = await env.PHOTOS.get(row.object_key);
  requireValue(object, 404, "photo_not_found");
  return Uint8Array.from(
    atob(await open(env, await object.text(), env.PAGE_ID + ":photo:" + id)),
    (c) => c.charCodeAt(0),
  );
}
export async function indexPhotos(env, itemId) {
  const item = await stmt(
    env,
    "SELECT * FROM items WHERE id=? AND page_id=?",
    itemId,
    env.PAGE_ID,
  ).first();
  requireValue(item, 404);
  const rows = await stmt(
    env,
    "SELECT id FROM media WHERE item_id=? AND page_id=? AND state='stored' LIMIT 3",
    itemId,
    env.PAGE_ID,
  ).all();
  const descriptions = [];
  for (const row of rows.results)
    descriptions.push(await caption(env, await photoBytes(env, row.id)));
  await indexItem(env, {
    ...item,
    search_text: item.search_text + " " + descriptions.join(" "),
  });
  return {
    indexed: rows.results.length,
    notice: "وصف بصري تقريبي للبحث فقط، ليس إثبات ملكية أو توفر",
  };
}
