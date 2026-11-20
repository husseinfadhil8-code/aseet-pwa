export function normalize(s = "") {
  return s
    .normalize("NFKC")
    .replace(/[٠-٩]/g, (x) => String("٠١٢٣٤٥٦٧٨٩".indexOf(x)))
    .replace(/[۰-۹]/g, (x) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(x)))
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[\u064b-\u065fـ]/g, "")
    .toLowerCase();
}
export const terms = (s) => normalize(s).match(/[\p{L}\p{N}]+/gu) || [];
const objects = [
  "ثلاجة",
  "ثلاجه",
  "كاونتر",
  "كنبة",
  "كنبه",
  "قنفة",
  "قنفه",
  "تخت",
  "سرير",
  "غسالة",
  "غساله",
  "طباخ",
  "مكيف",
  "سبلت",
  "اثاث",
  "أثاث",
  "تلفزيون",
  "مكتب",
  "كرسي",
  "مبردة",
  "مبرده",
];
export function extract(text) {
  const n = normalize(text);
  const notForSale = /(مو للبيع|ليس للبيع|ليست للبيع)/.test(n);
  const buyer =
    /(اريد|ابحث|ادور|مطلوب|احتاج|اشتري)/.test(n) &&
    !/(اريد ابيع|اريد بيع)/.test(n);
  const finance =
    /(عربون|حول فلوس|تحويل مبلغ|حساب مصرف|اتفقنا|عموله|عمولة|دفع)/.test(n);
  const price = text.match(
    /(?:السعر|سعرها|سعره|بسعر|بـ)\s*[:：]?\s*([\d٠-٩۰-۹][\d٠-٩۰-۹٬, .]*?)\s*(ألف|الف|مليون|دينار|د\.ع|IQD)(?=\s|$|[،.,!])/i,
  );
  let priceIQD = null;
  if (price) {
    const number = Number(normalize(price[1]).replace(/[٬,\s]/g, ""));
    const multiplier = /مليون/.test(price[2])
      ? 1e6
      : /الف|ألف/.test(price[2])
        ? 1e3
        : 1;
    const v = number * multiplier;
    if (Number.isSafeInteger(v) && v >= 0 && v < 1e12) priceIQD = v;
  }
  const area = text.match(
    /(?:المنطقة|المنطقه|العنوان|المكان)\s*[:：]\s*([^\n،]{2,65})/,
  );
  const title = objects.find((x) => n.includes(normalize(x))) || null;
  const condition = /(مو مستعمل|غير مستعمل|جديد)/.test(n)
    ? "جديد"
    : /(مستعمل)/.test(n)
      ? "مستعمل"
      : null;
  return {
    intent: notForSale
      ? "unclear"
      : finance
        ? "financial"
        : buyer
          ? "buyer"
          : /(للبيع|ابيع|بيع|السعر|سعرها|سعره)/.test(n)
            ? "seller"
            : "unclear",
    title,
    price_iqd: priceIQD,
    area: area?.[1].trim() || null,
    condition,
  };
}
export function questions(item, photoCount) {
  const q = [];
  if (!item.title) q.push("شنو الغرض؟");
  if (item.price_iqd === null) q.push("شكد سعره بالدينار؟ اكتب السعر: … دينار");
  if (!item.area) q.push("بأي منطقة؟ اكتب المنطقة: …");
  if (!item.condition) q.push("حالته جديد لو مستعمل؟");
  if (!photoCount)
    q.push("وتگدر ترسل صور الغرض هنا، راح تبقى خاصة وما ننشرها بدون موافقتك.");
  return q.join(" ");
}
export function cosine(a, b) {
  if (!Array.isArray(a) || a.length !== b.length || !a.length) return 0;
  let s = 0,
    x = 0,
    y = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0;
    s += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return x && y ? s / Math.sqrt(x * y) : 0;
}

// Context rules do not inspect pixels: unclear attachments must be reviewed, never guessed.
export function attachmentContext(text) {
  const n = normalize(text);
  return {
    excluded:
      /(صورتي|صور شخصيه|صوره شخصيه|صور عائل|صوره عائل|سيلفي|هويتي|بطاقتي|مو للبيع|ليس للبيع|ليست للبيع|مو غرض للبيع)/.test(
        n,
      ),
    confirmation:
      /(هاي|هذه|هذي|هاي هي|هذا).*(صور|صوره).*(الغرض|للبيع|ثلاجه|كاونتر|اثاث)/.test(
        n,
      ),
  };
}
export function followupFacts(text, prior, facts) {
  const n = normalize(text).trim();
  const result = { ...facts };
  if (
    result.price_iqd === null &&
    /^[\d٠-٩۰-۹][\d٠-٩۰-۹٬, .]*\s*(?:ألف|الف|مليون|دينار|د\.ع|IQD)\s*$/i.test(
      text.trim(),
    )
  )
    result.price_iqd = extract("السعر: " + text.trim()).price_iqd;
  if (
    !result.area &&
    [
      "المنصور",
      "الكراده",
      "بغداد",
      "الاعظميه",
      "الدوره",
      "زيونه",
      "الشعب",
      "اليرموك",
      "الكاظميه",
      "البياع",
      "الزعفرانيه",
    ].includes(n)
  )
    result.area = text.trim();
  if (!result.condition && /^(نظيف|نظيفه|يحتاج صيانه|بحاجه للصيانه)$/.test(n))
    result.condition = text.trim();
  return result;
}
