const SUPABASE_URL = "https://auqxdtbvfonzrlilygjg.supabase.co";
const SUPABASE_KEY = "sb_publishable_-tlztuTYhILnmREw5eBf1A_PXnV1qQ2";

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null;
let profile = null;
let goods = [];
let reps = [];
let sales = [];
let inquiries = [];
let pendingReps = [];
let busy = false;

const $ = id => document.getElementById(id);

function money(value) {
  return new Intl.NumberFormat("ar-IQ").format(Number(value) || 0) + " د.ع";
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[c]);
}

function toast(message) {
  const box = $("toast");
  if (!box) return alert(message);
  box.textContent = message;
  box.classList.add("show");
  setTimeout(() => box.classList.remove("show"), 3000);
}

function showDialog(id) {
  const dialog = $(id);
  if (dialog) dialog.showModal();
}

function hideDialog(id) {
  const dialog = $(id);
  if (dialog) dialog.close();
}

function isAdmin() {
  return profile?.role === "admin";
}

function setLoading(button, loading, text) {
  if (!button) return;
  button.disabled = loading;
  if (loading) {
    button.dataset.oldText = button.textContent;
    button.textContent = text || "جارٍ الحفظ...";
  } else if (button.dataset.oldText) {
    button.textContent = button.dataset.oldText;
    delete button.dataset.oldText;
  }
}

function showApp() {
  $("authView")?.classList.add("hidden");
  $("appView")?.classList.remove("hidden");

  if ($("userLabel")) {
    $("userLabel").textContent =
      (profile?.full_name || currentUser?.email || "مستخدم") +
      (isAdmin() ? " · مدير" : " · مندوب");
  }

  document.querySelectorAll(".admin-only").forEach(el => {
    el.classList.toggle("hidden", !isAdmin());
  });

  if ($("goodsSub")) {
    $("goodsSub").textContent = isAdmin()
      ? "إدارة الأغراض المعروضة"
      : "الأغراض المتاحة للبيع";
  }
}

function showLogin() {
  $("appView")?.classList.add("hidden");
  $("authView")?.classList.remove("hidden");
}

async function loadProfile() {
  const { data, error } = await db
    .from("profiles")
    .select("id, full_name, role, rep_code, status")
    .eq("id", currentUser.id)
    .single();

  if (error) throw error;
  profile = data;
}

async function startApp(user) {
  currentUser = user;

  try {
    await loadProfile();

    // فحص حالة الحساب إذا كان مندوباً
    if (!isAdmin() && profile?.status !== "approved") {
      await db.auth.signOut();
      currentUser = null;
      profile = null;
      if (profile?.status === "rejected") {
        alert("للأسف، تم رفض طلب انضمامك كمنسق/مندوب.");
      } else {
        alert("حسابك بانتظار موافقة المدير. يرجى الانتظار لحين تفعيله.");
      }
      showLogin();
      return;
    }

    showApp();
    await refreshData();
  } catch (error) {
    console.error(error);
    alert(
      "سبب الخطأ:\n" +
      (error.message || JSON.stringify(error)) +
      (error.code ? "\nرمز الخطأ: " + error.code : "") +
      (error.details ? "\nالتفاصيل: " + error.details : "") +
      (error.hint ? "\nملاحظة: " + error.hint : "")
    );
    await db.auth.signOut();
    currentUser = null;
    profile = null;
    showLogin();
  }
}

async function refreshData() {
  const goodsQuery = db
    .from("goods")
    .select("id, title, description, area, asking_price, agreed_commission, status, created_by, created_at")
    .order("created_at", { ascending: false });

  const inquiriesQuery = db
    .from("inquiries")
    .select("id, goods_id, rep_id, buyer_name, buyer_phone, status, notes, created_at")
    .order("created_at", { ascending: false });

  const [goodsResult, inquiriesResult] = await Promise.all([
    goodsQuery,
    inquiriesQuery
  ]);

  if (goodsResult.error) throw goodsResult.error;
  if (inquiriesResult.error) throw inquiriesResult.error;

  goods = goodsResult.data || [];
  inquiries = inquiriesResult.data || [];

  if (isAdmin()) {
    const [repsResult, pendingRepsResult, salesResult] = await Promise.all([
      db.from("profiles")
        .select("id, full_name, role, rep_code, status, created_at")
        .eq("role", "rep")
        .eq("status", "approved")
        .order("created_at", { ascending: false }),

      db.from("profiles")
        .select("id, full_name, role, rep_code, status, created_at")
        .eq("role", "rep")
        .eq("status", "pending")
        .order("created_at", { ascending: false }),

      db.from("sales")
        .select("id, goods_id, rep_id, final_price, total_commission, manager_share, rep_share, verified_at, created_at")
        .order("created_at", { ascending: false })
    ]);

    if (repsResult.error) throw repsResult.error;
    if (pendingRepsResult.error) throw pendingRepsResult.error;
    if (salesResult.error) throw salesResult.error;

    reps = repsResult.data || [];
    pendingReps = pendingRepsResult.data || [];
    sales = salesResult.data || [];
  } else {
    reps = [];
    pendingReps = [];
    sales = [];
  }

  render();
}

function render() {
  if ($("goodsCount")) $("goodsCount").textContent = goods.length;
  if ($("repCount")) $("repCount").textContent = isAdmin() ? reps.length : "—";
  if ($("salesCount")) $("salesCount").textContent = isAdmin() ? sales.length : "—";

  if ($("goodsList")) {
    $("goodsList").innerHTML = goods.map(g => {
      const statusNames = {
        available: "متاح",
        reserved: "محجوز",
        sold: "تم البيع",
        archived: "مؤرشف"
      };

      return `
        <article class="item">
          <div class="item-icon">▧</div>
          <div class="item-main">
            <h3>${esc(g.title)}</h3>
            <p>${esc(g.area || "الموقع غير محدد")}</p>
            ${g.description ? `<p>${esc(g.description)}</p>` : ""}
            <p>العمولة: ${money(g.agreed_commission)}</p>
            <span class="pill">${esc(statusNames[g.status] || g.status)}</span>
          </div>
          <div class="price">${money(g.asking_price)}</div>
        </article>
      `;
    }).join("");
  }

  if ($("emptyGoods")) $("emptyGoods").classList.toggle("hidden", goods.length > 0);

  if ($("repsList")) {
    let repsHTML = reps.map(r => `
      <article class="item">
        <div class="item-icon">♙</div>
        <div class="item-main">
          <h3>${esc(r.full_name || "مندوب")}</h3>
          <p>رمز المندوب: ${esc(r.rep_code || "—")}</p>
        </div>
      </article>
    `).join("");

    if (isAdmin() && pendingReps.length > 0) {
      repsHTML = `
        <div style="background: #fff3cd; color: #856404; padding: 10px; border-radius: 8px; margin-bottom: 12px; font-weight: bold;">
          طلبات الانضمام المعلقة (${pendingReps.length})
        </div>
      ` + pendingReps.map(r => `
        <article class="item" style="border: 1px solid #ffeeba; background: #fffdf5;">
          <div class="item-icon">⏳</div>
          <div class="item-main">
            <h3>${esc(r.full_name || "طلب مندوب جديد")}</h3>
            <p>بانتظار موافقتك</p>
          </div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <button onclick="approveRep('${r.id}')" style="background:#28a745; color:#fff; border:none; padding:6px 12px; border-radius:6px; cursor:pointer;">موافقة</button>
            <button onclick="rejectRep('${r.id}')" style="background:#dc3545; color:#fff; border:none; padding:6px 12px; border-radius:6px; cursor:pointer;">رفض</button>
          </div>
        </article>
      `).join("") + repsHTML;
    }

    $("repsList").innerHTML = repsHTML;
  }

  if ($("emptyReps")) $("emptyReps").classList.toggle("hidden", (reps.length + pendingReps.length) > 0);

  if ($("salesList")) {
    $("salesList").innerHTML = sales.map(s => {
      const g = goods.find(x => x.id === s.goods_id);
      const r = reps.find(x => x.id === s.rep_id);

      return `
        <article class="item">
          <div class="item-icon">✓</div>
          <div class="item-main">
            <h3>${esc(g?.title || "غرض")}</h3>
            <p>المندوب: ${esc(r?.full_name || "مندوب")}</p>
            <p>العمولة: ${money(s.total_commission)}</p>
            <p>حصة المدير: ${money(s.manager_share)} · حصة المندوب: ${money(s.rep_share)}</p>
          </div>
          <div class="price">${money(s.final_price)}</div>
        </article>
      `;
    }).join("");
  }

  if ($("emptySales")) $("emptySales").classList.toggle("hidden", sales.length > 0);

  if ($("inquiriesList")) {
    $("inquiriesList").innerHTML = inquiries.map(i => {
      const g = goods.find(x => x.id === i.goods_id);

      return `
        <article class="item">
          <div class="item-icon">☏</div>
          <div class="item-main">
            <h3>${esc(i.buyer_name || "مشتري")}</h3>
            <p>الغرض: ${esc(g?.title || "غرض غير متاح")}</p>
            ${i.buyer_phone ? `<p>رقم التواصل: ${esc(i.buyer_phone)}</p>` : ""}
            ${i.notes ? `<p>${esc(i.notes)}</p>` : ""}
            <p>التاريخ: ${esc(i.created_at ? new Date(i.created_at).toLocaleDateString("ar-IQ") : "—")}</p>
          </div>
        </article>
      `;
    }).join("");
  }

  if ($("emptyInquiries")) $("emptyInquiries").classList.toggle("hidden", inquiries.length > 0);
}

window.approveRep = async function(repId) {
  if (!confirm("هل أنت مقتنع بالموافقة على هذا المندوب؟")) return;
  try {
    const { error } = await db.from("profiles").update({ status: "approved" }).eq("id", repId);
    if (error) throw error;
    toast("تمت الموافقة على المندوب بنجاح");
    await refreshData();
  } catch (err) {
    console.error(err);
    toast("تعذرت الموافقة على المندوب");
  }
};

window.rejectRep = async function(repId) {
  if (!confirm("هل أنت متأكد من رفض هذا الطلب؟")) return;
  try {
    const { error } = await db.from("profiles").update({ status: "rejected" }).eq("id", repId);
    if (error) throw error;
    toast("تم رفض طلب المندوب");
    await refreshData();
  } catch (err) {
    console.error(err);
    toast("تعذر رفض المندوب");
  }
};

document.querySelectorAll("[data-close]").forEach(button => {
  button.addEventListener("click", () => hideDialog(button.dataset.close));
});

document.querySelectorAll(".tab").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(tab => {
      tab.classList.toggle("active", tab === button);
    });

    document.querySelectorAll(".view").forEach(view => {
      view.classList.add("hidden");
    });

    const targetView = $(button.dataset.view + "View");
    if (targetView) targetView.classList.remove("hidden");
  });
});

if ($("loginForm")) {
  $("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;

    const button = event.submitter;
    const form = new FormData(event.target);

    busy = true;
    setLoading(button, true, "جارٍ تسجيل الدخول...");

    try {
      const { data, error } = await db.auth.signInWithPassword({
        email: String(form.get("email")).trim(),
        password: String(form.get("password"))
      });

      if (error) throw error;

      await startApp(data.user);
    } catch (error) {
      console.error(error);
      toast("تعذّر تسجيل الدخول. تحقق من البريد وكلمة المرور.");
    } finally {
      busy = false;
      setLoading(button, false);
    }
  });
}

// إنشاء حساب مندوب جديد
if ($("signupForm")) {
  $("signupForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;

    const button = event.submitter;
    const form = new FormData(event.target);
    const fullName = String(form.get("fullName") || "").trim();
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");

    if (!fullName || !email || !password) {
      toast("يرجى ملء جميع الحقول المطلوبة");
      return;
    }

    busy = true;
    setLoading(button, true, "جارٍ إرسال الطلب...");

    try {
      const { data, error } = await db.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName, role: 'rep' }
        }
      });

      if (error) throw error;

      if (data.user) {
        const repCode = "REP-" + Math.floor(1000 + Math.random() * 9000);
        await db.from("profiles").upsert({
          id: data.user.id,
          full_name: fullName,
          role: "rep",
          rep_code: repCode,
          status: "pending"
        });

        alert("تم إرسال طلب تسجيلك بنجاح! حسابك الآن بانتظار موافقة المدير.");
        event.target.reset();
      }
    } catch (error) {
      console.error(error);
      toast("تعذّر إنشاء الحساب: " + (error.message || "تأكد من البيانات"));
    } finally {
      busy = false;
      setLoading(button, false);
    }
  });
}

if ($("logoutBtn")) {
  $("logoutBtn").addEventListener("click", async () => {
    const { error } = await db.auth.signOut();

    if (error) {
      toast("تعذّر تسجيل الخروج");
      return;
    }

    currentUser = null;
    profile = null;
    goods = [];
    reps = [];
    sales = [];
    inquiries = [];
    pendingReps = [];
    showLogin();
  });
}

if ($("addGoodsBtn")) {
  $("addGoodsBtn").addEventListener("click", () => {
    if (!isAdmin()) return;
    showDialog("goodsDialog");
  });
}

if ($("goodsForm")) {
  $("goodsForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!isAdmin() || busy) return;

    const button = event.submitter;
    const form = new FormData(event.target);

    const title = String(form.get("title") || "").trim();
    const description = String(form.get("notes") || "").trim();
    const area = String(form.get("area") || "").trim();
    const askingPrice = Number(form.get("price"));
    const commission = Number(form.get("commission"));

    if (!title || askingPrice < 0 || commission < 0) {
      toast("تحقق من معلومات الغرض والسعر");
      return;
    }

    busy = true;
    setLoading(button, true);

    try {
      const { error } = await db.from("goods").insert({
        title,
        description,
        area,
        asking_price: askingPrice,
        agreed_commission: commission,
        status: "available",
        created_by: currentUser.id
      });

      if (error) throw error;

      event.target.reset();
      hideDialog("goodsDialog");
      await refreshData();
      toast("تمت إضافة الغرض بنجاح");
    } catch (error) {
      console.error(error);
      toast("لم تتم إضافة الغرض. تحقق من الاتصال والصلاحيات.");
    } finally {
      busy = false;
      setLoading(button, false);
    }
  });
}

function populateGoodsOptions(selectId) {
  const select = $(selectId);
  if (!select) return false;
  const available = goods.filter(g => g.status === "available");

  select.innerHTML = available.map(g => `
    <option value="${esc(g.id)}">${esc(g.title)} — ${money(g.asking_price)}</option>
  `).join("");

  return available.length > 0;
}

if ($("addInquiryBtn")) {
  $("addInquiryBtn").addEventListener("click", () => {
    if (!populateGoodsOptions("inquiryGoods")) {
      toast("ماكو أغراض متاحة حتى تسجّل استفسار");
      return;
    }

    showDialog("inquiryDialog");
  });
}

if ($("inquiryForm")) {
  $("inquiryForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;

    const button = event.submitter;
    const form = new FormData(event.target);

    busy = true;
    setLoading(button, true);

    try {
      const { error } = await db.from("inquiries").insert({
        goods_id: form.get("goodsId"),
        rep_id: currentUser.id,
        buyer_name: String(form.get("buyerName") || "").trim(),
        buyer_phone: String(form.get("buyerPhone") || "").trim(),
        notes: String(form.get("notes") || "").trim()
      });

      if (error) throw error;

      event.target.reset();
      hideDialog("inquiryDialog");
      await refreshData();
      toast("تم حفظ استفسار المشتري");
    } catch (error) {
      console.error(error);
      toast("تعذّر حفظ الاستفسار. تحقق من الاتصال والصلاحيات.");
    } finally {
      busy = false;
      setLoading(button, false);
    }
  });
}

function updateCommissionSplit() {
  const saleForm = $("saleForm");
  if (!saleForm) return;
  const commission = Number(saleForm.elements.commission?.value) || 0;

  if ($("commissionSplit")) {
    $("commissionSplit").textContent =
      `حصة المدير: ${money(Math.floor(commission / 2))} | ` +
      `حصة المندوب: ${money(commission - Math.floor(commission / 2))}`;
  }
}

if ($("saleGoods")) {
  $("saleGoods").addEventListener("change", () => {
    const selected = goods.find(g => g.id === $("saleGoods").value);

    if (selected && $("saleForm")) {
      $("saleForm").elements.commission.value = selected.agreed_commission;
      updateCommissionSplit();
    }
  });
}

if ($("saleForm") && $("saleForm").elements.commission) {
  $("saleForm").elements.commission.addEventListener("input", updateCommissionSplit);
}

if ($("addSaleBtn")) {
  $("addSaleBtn").addEventListener("click", () => {
    if (!isAdmin()) return;

    if (!populateGoodsOptions("saleGoods")) {
      toast("ماكو أغراض متاحة للبيع");
      return;
    }

    if ($("saleRep")) {
      $("saleRep").innerHTML = reps.map(r => `
        <option value="${esc(r.id)}">${esc(r.full_name || "مندوب")}</option>
      `).join("");
    }

    const selected = goods.find(g => g.id === $("saleGoods").value);
    if ($("saleForm")) {
      $("saleForm").elements.commission.value = selected?.agreed_commission || 0;
    }
    updateCommissionSplit();

    if (!reps.length) {
      toast("أضف حساب مندوب أولاً أو وافق على طلبات المندوبين");
      return;
    }

    showDialog("saleDialog");
  });
}

if ($("saleForm")) {
  $("saleForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!isAdmin() || busy) return;

    const button = event.submitter;
    const form = new FormData(event.target);
    const goodsId = String(form.get("goodsId") || "");
    const repId = String(form.get("repId") || "");
    const finalPrice = Number(form.get("price"));
    const commission = Number(form.get("commission"));

    const selectedGoods = goods.find(g => g.id === goodsId);

    if (!selectedGoods || selectedGoods.status !== "available" ||
        !reps.some(r => r.id === repId) ||
        finalPrice < 0 || commission < 0) {
      toast("تحقق من الغرض والمندوب والأسعار");
      return;
    }

    busy = true;
    setLoading(button, true);

    try {
      const managerShare = Math.floor(commission / 2);
      const repShare = commission - managerShare;

      const { error: saleError } = await db.from("sales").insert({
        goods_id: goodsId,
        rep_id: repId,
        final_price: finalPrice,
        total_commission: commission,
        manager_share: managerShare,
        rep_share: repShare,
        verified_by: currentUser.id,
        verified_at: new Date().toISOString()
      });

      if (saleError) throw saleError;

      const { error: goodsError } = await db
        .from("goods")
        .update({ status: "sold" })
        .eq("id", goodsId);

      if (goodsError) {
        console.error("تم تسجيل البيع لكن تعذر تحديث حالة الغرض:", goodsError);
        toast("تسجل البيع، لكن تعذّر تحديث حالة الغرض");
      } else {
        toast("تم تسجيل البيع وتحديث حالة الغرض");
      }

      event.target.reset();
      hideDialog("saleDialog");
      await refreshData();
    } catch (error) {
      console.error(error);
      toast("تعذّر تسجيل البيع. تحقق من البيانات والصلاحيات.");
    } finally {
      busy = false;
      setLoading(button, false);
    }
  });
}

async function init() {
  const { data, error } = await db.auth.getSession();

  if (error) {
    console.error(error);
    showLogin();
    return;
  }

  if (data.session?.user) {
    await startApp(data.session.user);
  } else {
    showLogin();
  }
}

db.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT") {
    currentUser = null;
    profile = null;
    showLogin();
  }
});

init();
