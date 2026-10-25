# Public images — 2026-10-25-public-images-8

Public submissions reuse the existing goods-image compressor for JPEG/PNG/WebP,
limiting dimensions to 1800px while retaining the original if resizing is not
needed and JPEG would be larger. Upload filename and content type match the
prepared file. GIF and other previously accepted formats remain unchanged.
Unreadable supported images stop before upload with a local image error and
preserve the form. The existing single-submit guard covers preparation too.

Focused local validation: three new browser cases (real canvas resize/MIME,
unchanged GIF, decode failure) and the impacted concurrent-submit case pass.
No hosted writes, database/preview changes, Storage deletion or paid service.
