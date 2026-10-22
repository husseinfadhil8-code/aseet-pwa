const SUPABASE_URL = "https://auqxdtbvfonzrlilygjg.supabase.co";
const SUPABASE_KEY = "sb_publishable_-tlztuTYhILnmREw5eBf1A_PXnV1qQ2";

let db = null;
try {
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
} catch (e) {
  console.error("Supabase Init Error:", e);
}

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
  if (dialog && typeof dialog.showModal === "function") dialog.showModal();
}

function hideDialog(id) {
  const dialog = $(id);
  if (dialog && typeof dialog.close === "function") dialog.close();
}

function isAdmin() {
  return profile?.role === "admin";
}

function setLoading(button, loading, text) {
  if (!button) return;
  button.disabled = loading;
  if (loading) {
    button.dataset.oldText = button.textContent;
    button.textContent = text || "جارٍ التنفيذ...";
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
  if (!db) return;
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

    if (!isAdmin() && profile?.status !== "approved") {
      await db.auth.signOut();
      currentUser = null;
      profile = null;
      if (profile?.status === "rejected") {
        alert("للأسف، تم رفض طلب انضمامك.");
      } else {
        alert("حسابك بانتظار موافقة المدير.");
      }
      showLogin();
      return;
    }

    showApp();
    await refreshData();
  } catch (error) {
    console.error(error);
    alert("خطأ في تحميل الملف الشخصي: " + (error.message || JSON.stringify(error)));
    await db.auth.signOut();
    currentUser = null;
    profile = null;
    showLogin();
  }
}

async function refreshData() {
  if (!db) return;
  try {
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
  } catch (err) {
    console.error("Refresh Data Error:", err);
  }
}

function render() {
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

window.handleLogin = async function() {
  if (busy || !db) return;

  const email = $("loginEmail")?.value?.trim();
  const password = $("loginPassword")?.value;
  const button = $("loginBtn");

  if (!email || !password) {
    alert("يرجى إدخال البريد الإلكتروني وكلمة المرور");
    return;
  }

  busy = true;
  setLoading(button, true, "جارٍ تسجيل الدخول...");

  try {
    const { data, error } = await db.auth.signInWithPassword({ email, password });

    if (error) {
      alert("خطأ في تسجيل الدخول: " + error.message);
      return;
    }

    if (data?.user) {
      await startApp(data.user);
    }
  } catch (err) {
    console.error(err);
    alert("حدث خطأ أثناء الاتصال: " + (err.message || JSON.stringify(err)));
  } finally {
    busy = false;
    setLoading(button, false);
  }
};

window.handleSignup = async function() {
  if (busy || !db) return;

  const fullName = $("signupName")?.value?.trim();
  const email = $("signupEmail")?.value?.trim();
  const password = $("signupPassword")?.value;
  const button = $("signupBtn");

  if (!fullName || !email || !password) {
    alert("يرجى ملء جميع الحقول المطلوبة");
    return;
  }

  busy = true;
  setLoading(button, true, "جارٍ إرسال الطلب...");

  try {
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, role: 'rep' } }
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

      alert("تم إرسال طلب تسجيلك بنجاح! حسابك بانتظار موافقة المدير.");
      $("signupForm")?.reset();
    }
  } catch (error) {
    console.error(error);
    alert("تعذّر إنشاء الحساب: " + (error.message || JSON.stringify(error)));
  } finally {
    busy = false;
    setLoading(button, false);
  }
};

window.handleSaveGoods = async function() {
  if (!isAdmin() || busy || !db) return;

  const form = $("goodsForm");
  const formData = new FormData(form);
  const button = $("saveGoodsBtn");

  const title = String(formData.get("title") || "").trim();
  const description = String(formData.get("notes") || "").trim();
  const area = String(formData.get("area") || "").trim();
  const askingPrice = Number(formData.get("price"));
  const commission = Number(formData.get("commission"));

  if (!title || askingPrice < 0 || commission < 0) {
    alert("تحقق من اسم الغرض والسعر والعمولة");
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

    form.reset();
    hideDialog("goodsDialog");
    await refreshData();
    toast("تمت إضافة الغرض بنجاح");
  } catch (error) {
    console.error(error);
    alert("لم تتم إضافة الغرض: " + (error.message || JSON.stringify(error)));
  } finally {
    busy = false;
    setLoading(button, false);
  }
};

window.handleSaveInquiry = async function() {
  if (busy || !db) return;

  const form = $("inquiryForm");
  const formData = new FormData(form);

  busy = true;

  try {
    const { error } = await db.from("inquiries").insert({
      goods_id: formData.get("goodsId"),
      rep_id: currentUser.id,
      buyer_name: String(formData.get("buyerName") || "").trim(),
      buyer_phone: String(formData.get("buyerPhone") || "").trim(),
      notes: String(formData.get("notes") || "").trim()
    });

    if (error) throw error;

    form.reset();
    hideDialog("inquiryDialog");
    await refreshData();
    toast("تم حفظ استفسار المشتري");
  } catch (error) {
    console.error(error);
    alert("تعذّر حفظ الاستفسار: " + (error.message || JSON.stringify(error)));
  } finally {
    busy = false;
  }
};

window.handleSaveSale = async function() {
  if (!isAdmin() || busy || !db) return;

  const form = $("saleForm");
  const formData = new FormData(form);
  const goodsId = String(formData.get("goodsId") || "");
  const repId = String(formData.get("repId") || "");
  const finalPrice = Number(formData.get("price"));
  const commission = Number(formData.get("commission"));

  busy = true;

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

    await db.from("goods").update({ status: "sold" }).eq("id", goodsId);

    form.reset();
    hideDialog("saleDialog");
    await refreshData();
    toast("تم تسجيل البيع بنجاح");
  } catch (error) {
    console.error(error);
    alert("تعذّر تسجيل البيع: " + (error.message || JSON.stringify(error)));
  } finally {
    busy = false;
  }
};

window.approveRep = async function(repId) {
  if (!db) return;
  if (!confirm("هل أنت متأكد من الموافقة على هذا المندوب؟")) return;
  try {
    const { error } = await db.from("profiles").update({ status: "approved" }).eq("id", repId);
    if (error) throw error;
    toast("تمت الموافقة على المندوب بنجاح");
    await refreshData();
  } catch (err) {
    console.error(err);
    alert("تعذرت الموافقة: " + (err.message || JSON.stringify(err)));
  }
};

window.rejectRep = async function(repId) {
  if (!db) return;
  if (!confirm("هل أنت متأكد من رفض هذا الطلب؟")) return;
  try {
    const { error } = await db.from("profiles").update({ status: "rejected" }).eq("id", repId);
    if (error) throw error;
    toast("تم رفض طلب المندوب");
    await refreshData();
  } catch (err) {
    console.error(err);
    alert("تعذر الرفض: " + (err.message || JSON.stringify(err)));
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

if ($("logoutBtn")) {
  $("logoutBtn").addEventListener("click", async () => {
    if (db) await db.auth.signOut();
    currentUser = null;
    profile = null;
    showLogin();
  });
}

if ($("addGoodsBtn")) {
  $("addGoodsBtn").addEventListener("click", () => {
    if (!isAdmin()) return;
    showDialog("goodsDialog");
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
      toast("لا توجد أغراض متاحة للبيع");
      return;
    }
    showDialog("inquiryDialog");
  });
}

if ($("addSaleBtn")) {
  $("addSaleBtn").addEventListener("click", () => {
    if (!isAdmin()) return;
    if (!populateGoodsOptions("saleGoods")) {
      toast("لا توجد أغراض متاحة للبيع");
      return;
    }
    if ($("saleRep")) {
      $("saleRep").innerHTML = reps.map(r => `
        <option value="${esc(r.id)}">${esc(r.full_name || "مندوب")}</option>
      `).join("");
    }
    if (!reps.length) {
      toast("وافق على طلبات المندوبين أولاً");
      return;
    }
    showDialog("saleDialog");
  });
}

async function init() {
  if (!db) return;
  try {
    const { data } = await db.auth.getSession();
    if (data.session?.user) {
      await startApp(data.session.user);
    } else {
      showLogin();
    }
  } catch (e) {
    console.error("Init Error:", e);
    showLogin();
  }
}

if (db) {
  db.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      currentUser = null;
      profile = null;
      showLogin();
    }
  });
}

init();
