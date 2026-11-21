let accessSession = false;
let token = "",
  cursor = null,
  filterSeller = null;
const $ = (s) => document.querySelector(s);
const el = (tag, text) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
};
const notice = (s) => ($("#notice").textContent = s);
const friendly = {
  ai_not_enabled: "الذكاء الاصطناعي غير مفعّل أو غير مربوط. البحث النصي متاح.",
  ai_budget_required: "لم يُحدد سقف استخدام الذكاء الاصطناعي.",
  ai_daily_limit: "وصل استخدام AI للحد اليومي.",
  private_storage_not_configured: "تخزين الصور الخاص غير مربوط.",
  unauthorized: "اعتماد الإدارة غير صحيح.",
  confirmation_required: "يلزم تأكيد أنك تحققت من التوفر.",
};
const urls = [];
async function api(path, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!r.ok) {
    const d = await r.json();
    throw new Error(friendly[d.error] || "تعذرت العملية: " + d.error);
  }
  return r.json();
}
const run = (fn) => async (e) => {
  e?.preventDefault();
  try {
    await fn(e);
  } catch (err) {
    notice(err.message);
  }
};
const date = (value) =>
  value ? new Date(value).toLocaleString("ar-IQ") : "لم يُؤكد";
const button = (text, fn) => {
  const b = el("button", text);
  b.type = "button";
  b.addEventListener("click", run(fn));
  return b;
};
const link = (url) => {
  if (!url) return el("p", "رابط المحادثة غير متوفر؛ لم ننشئ رابطاً تخمينياً.");
  const a = el("a", "فتح المحادثة");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
};
$("#login").addEventListener(
  "submit",
  run(async () => {
    token = $("#token").value;
    await api("/api/settings");
    $("#token").value = "";
    $("#login").hidden = true;
    $("#panel").hidden = false;
    notice("اتصال موثّق بلوحة الإدارة");
    await loadItems();
  }),
);
$("#logout").onclick = () => {
  if(accessSession){location.href="/cdn-cgi/access/logout";return;}
  token = "";
  for (const u of urls) URL.revokeObjectURL(u);
  location.reload();
};
for (const b of document.querySelectorAll("[data-tab]"))
  b.addEventListener(
    "click",
    run(async () => {
      for (const id of ["items", "sellers", "interests", "settings"])
        $("#" + id).hidden = id !== b.dataset.tab;
      await {
        items: loadItems,
        sellers: loadSellers,
        interests: loadInterests,
        settings: loadSettings,
      }[b.dataset.tab]();
    }),
  );
async function showItems(items, append = false) {
  if (!append) {
    $("#results").replaceChildren();
    for (const u of urls) URL.revokeObjectURL(u);
    urls.length = 0;
  }
  for (const item of items) {
    const c = el("article");
    c.append(
      el("h2", item.title || "غرض يحتاج تحديد اسمه"),
      el(
        "span",
        item.status === "available"
          ? "متوفر حسب آخر تأكيد"
          : {
              unknown: "التوفر غير مؤكد",
              sold: "مباع",
              reserved: "محجوز",
              withdrawn: "مسحوب",
            }[item.status] || "غير مؤكد",
      ),
    );
    c.append(
      el(
        "p",
        "البائع: " +
          (item.seller.name || "الاسم غير معروف") +
          " • PSID: " +
          item.seller.psid,
      ),
      el(
        "p",
        "السعر: " +
          (item.price_iqd === null
            ? "غير مذكور"
            : item.price_iqd.toLocaleString("ar-IQ") + " د.ع") +
          " • المنطقة: " +
          (item.area || "غير مذكورة") +
          " • الحالة: " +
          (item.condition || "غير معروفة"),
      ),
      el("p", "آخر تأكيد للتوفر: " + date(item.last_confirmed)),
      el("p", "آخر رسالة محفوظة: " + date(item.updated_at)),
      el("pre", item.description),
      link(item.inbox_url),
    );
    const photos = el("div");
    photos.className = "photos";
    for (const p of item.photos) {
      if (!p.approved && p.state !== "rejected") {
        const review = el("div");
        review.append(
          el(
            "p",
            "مرفق غير مصنّف — لا يُحفظ أو يُفهرس كصورة غرض قبل المراجعة.",
          ),
        );
        review.append(
          button("معاينة خاصة للمراجعة", async () => {
            const r = await fetch("/api/photos/" + p.id + "/review", {
              headers: { Authorization: "Bearer " + token },
            });
            if (!r.ok) throw new Error("تعذرت المعاينة الخاصة");
            const url = URL.createObjectURL(await r.blob());
            urls.push(url);
            const img = el("img");
            img.src = url;
            img.alt = "مرفق غير مصنّف للمراجعة فقط";
            review.prepend(img);
          }),
        );
        for (const [classification, label] of [
          ["sale_item", "أؤكد أنها صورة الغرض"],
          ["personal", "صورة شخصية — استبعاد"],
          ["unrelated", "غير مرتبطة — استبعاد"],
        ])
          review.append(
            button(label, async () => {
              await api("/api/photos/" + p.id + "/review", {
                method: "PATCH",
                body: JSON.stringify({ classification, confirmed: true }),
              });
              notice("حُفظ تصنيف المرفق");
              await loadItems();
            }),
          );
        photos.append(review);
      } else if (p.state === "rejected") {
        photos.append(
          el("small", "مرفق مستبعد؛ لا يُخزّن أو يُفهرس كصورة غرض."),
        );
      } else if (p.state === "stored") {
        const b = button("عرض الصورة الخاصة", async () => {
          const r = await fetch("/api/photos/" + p.id, {
            headers: { Authorization: "Bearer " + token },
          });
          if (!r.ok) throw new Error("تعذر عرض الصورة");
          const url = URL.createObjectURL(await r.blob());
          urls.push(url);
          const img = el("img");
          img.src = url;
          img.alt = "صورة الغرض المرسلة على الخاص";
          b.replaceWith(img);
        });
        photos.append(b);
      } else
        photos.append(
          el(
            "small",
            p.state === "failed"
              ? "فشل حفظ الصورة؛ راجع السجل"
              : "الصورة بانتظار التخزين الخاص",
          ),
        );
    }
    c.append(photos);
    const form = el("form"),
      label = el("label", "تحديث حالة الغرض"),
      select = el("select");
    for (const [v, l] of Object.entries({
      unknown: "غير مؤكد",
      available: "متوفر بعد التحقق",
      reserved: "محجوز",
      sold: "مباع",
      withdrawn: "مسحوب",
    })) {
      const o = el("option", l);
      o.value = v;
      select.append(o);
    }
    select.value = item.status;
    const check = el("input");
    check.type = "checkbox";
    const confirm = el("label", "تواصلت مع البائع وتحققت من الحالة الآن");
    confirm.className = "toggle";
    confirm.prepend(check);
    const inbox = el("input");
    inbox.type = "url";
    inbox.placeholder = "رابط المحادثة الحقيقي، اختياري";
    inbox.value = item.inbox_url || "";
    inbox.setAttribute("aria-label", "رابط المحادثة الحقيقي");
    const name = el("input");
    name.placeholder = "اسم البائع بعد معرفته، اختياري";
    name.value = item.seller.name || "";
    name.setAttribute("aria-label", "اسم البائع المعلوم");
    const submit = el("button", "حفظ المراجعة");
    form.append(label, select, confirm, name, inbox, submit);
    form.addEventListener(
      "submit",
      run(async () => {
        const d = {
          status: select.value,
          confirmed: check.checked,
          reviewed: true,
        };
        if (name.value.trim()) d.name = name.value.trim();
        if (inbox.value) d.inbox_url = inbox.value;
        await api("/api/items/" + item.id, {
          method: "PATCH",
          body: JSON.stringify(d),
        });
        notice("حُفظت المراجعة");
        await loadItems();
      }),
    );
    c.append(
      form,
      button("فهرسة دلالية", async () => {
        await api("/api/items/" + item.id + "/index", {
          method: "POST",
          body: "{}",
        });
        notice("تمت الفهرسة الدلالية");
      }),
      button("فهرسة الصور الخاصة", async () => {
        await api("/api/items/" + item.id + "/index", {
          method: "POST",
          body: '{"photos":true}',
        });
        notice("تمت فهرسة الأوصاف البصرية التقريبية");
      }),
    );
    $("#results").append(c);
  }
  if (!items.length && !append)
    $("#results").append(el("p", "لا توجد أغراض مطابقة محفوظة."));
}
async function loadItems(append = false) {
  const p = new URLSearchParams();
  if (filterSeller) p.set("seller", filterSeller);
  if (append && cursor) p.set("offset", cursor);
  else if ($("#q").value) p.set("q", $("#q").value);
  const d = await api("/api/items?" + p);
  await showItems(d.items, append);
  cursor = d.next_offset;
  $("#more").hidden = !cursor;
  notice(
    d.limited
      ? "تظهر أول النتائج فقط؛ استخدم وصفاً أدق أو حمّل المزيد."
      : "عدد النتائج: " + d.items.length,
  );
}
$("#search").addEventListener(
  "submit",
  run(() => loadItems()),
);
$("#all").onclick = run(async () => {
  $("#q").value = "";
  filterSeller = null;
  await loadItems();
});
$("#more").onclick = run(() => loadItems(true));
$("#semantic").onclick = run(async () => {
  const d = await api("/api/search", {
    method: "POST",
    body: JSON.stringify({ mode: "semantic", query: $("#q").value }),
  });
  await showItems(d.items);
  $("#more").hidden = true;
  notice(d.notice);
});
$("#image").addEventListener(
  "change",
  run(async () => {
    const file = $("#image").files[0];
    if (!file) return;
    if (file.size > 2097152) throw new Error("اختر صورة أصغر من 2 ميغابايت");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 8192)
      s += String.fromCharCode(...bytes.slice(i, i + 8192));
    const d = await api("/api/search", {
      method: "POST",
      body: JSON.stringify({ mode: "image", image: btoa(s) }),
    });
    await showItems(d.items);
    $("#more").hidden = true;
    notice(d.notice);
    $("#image").value = "";
  }),
);
async function loadSellers() {
  const d = await api("/api/sellers");
  $("#seller-list").replaceChildren();
  for (const s of d.sellers) {
    const c = el("article");
    c.append(
      el("h2", s.name || "اسم غير معروف"),
      el("small", s.id),
      el("p", s.item_count + " أغراض محفوظة"),
      button("عرض أغراضه", async () => {
        filterSeller = s.id;
        $("#q").value = "";
        $("#sellers").hidden = true;
        $("#items").hidden = false;
        await loadItems();
      }),
    );
    $("#seller-list").append(c);
  }
}
async function loadInterests() {
  const d = await api("/api/interests");
  $("#interest-list").replaceChildren();
  for (const n of d.interests) {
    const c = el("article");
    c.append(
      el("h2", n.title || "غرض غير مسمى"),
      el("p", "البائع: " + (n.name || "غير معروف")),
      el("p", "آخر تأكيد: " + date(n.last_confirmed) + " • " + n.status),
      el("small", "رقم تنبيه: " + n.id),
      link(n.inbox_url),
    );
    $("#interest-list").append(c);
  }
  if (!d.interests.length)
    $("#interest-list").append(el("p", "لا توجد تنبيهات اهتمام محفوظة."));
}
async function loadSettings() {
  const d = await api("/api/settings");
  $("#switches").replaceChildren();
  for (const [key, title] of Object.entries({
    replies: "الردود التلقائية",
    alerts: "التنبيهات الخارجية للمسؤول",
    ai: "تحليل وفهرسة AI",
    photos: "حفظ الصور في المخزن الخاص",
  })) {
    const label = el("label", title);
    label.className = "toggle";
    const input = el("input");
    input.type = "checkbox";
    input.checked = !!d[key];
    input.addEventListener(
      "change",
      run(async () => {
        await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ [key]: input.checked }),
        });
        await loadSettings();
      }),
    );
    label.prepend(input);
    $("#switches").append(
      label,
      el(
        "small",
        d.capabilities[key]
          ? "إعداد الخادم يسمح بالتفعيل"
          : "غير متاح في إعداد الخادم؛ تشغيل المفتاح وحده لا يكفي",
      ),
    );
  }
  const ops = await api("/api/operations");
  $("#operations").replaceChildren(el("h2", "سجل الإرسال والمعالجة"));
  for (const o of [...ops.outbox, ...ops.events])
    $("#operations").append(
      el(
        "p",
        (o.kind || "حدث") +
          " • " +
          (o.state || o.status) +
          " • محاولات: " +
          o.attempts +
          (o.error ? " • " + o.error : ""),
      ),
    );
}
$("#process").onclick = run(async () => {
  const d = await api("/api/process", { method: "POST", body: "{}" });
  notice(
    "معالجة: " + d.processed + " • صور: " + d.photos + " • إرسال: " + d.sent,
  );
  await loadSettings();
});

$("#assistant").addEventListener("submit",run(async()=>{
 const d=await api("/api/assistant",{method:"POST",body:JSON.stringify({query:$("#command").value})});
 await showItems(d.items); $("#more").hidden=true;
 notice(d.answer+" — "+(d.engine==="gemma_grounded"?"Gemma مع سجلات D1":"بحث قواعدي؛ AI غير مستخدم أو تعذر"));
}));

// Access authenticates before serving the page; no shared secret is entered.
(async()=>{try{const d=await api("/api/settings");if(d.authentication!=="access")return;
 accessSession=true;$("#login").hidden=true;$("#panel").hidden=false;
 notice("تسجيل دخول خاص موثّق عبر Cloudflare Access");await loadItems();
}catch{/* Local development retains its explicit bearer login; no data shown. */}})();
