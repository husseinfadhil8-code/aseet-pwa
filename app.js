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
let selectedRole = 'admin';

const $ = id => document.getElementById(id);

function money(val) {
  return new Intl.NumberFormat("ar-IQ").format(Number(val) || 0) + " د.ع";
}

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

function showDialog(id) {
  const d = $(id);
  if (d && typeof d.showModal === "function") d.showModal();
}

function hideDialog(id) {
  const d = $(id);
  if (d && typeof d.close === "function") d.close();
}

function isAdmin() {
  return profile?.role === "admin";
}

window.goToAuth = function() {
  $("welcomeView")?.classList.add("hidden");
  $("authView")?.classList.remove("hidden");
};

window.selectRole = function(role) {
  selectedRole = role;
  $("roleAdmin")?.classList.toggle("active", role === 'admin');
  $("roleRep")?.classList.toggle("active", role === 'rep');
};

window.switchAuthMode = function(mode) {
  $("loginForm")?.classList.toggle("hidden", mode !== 'login');
  $("signupForm")?.classList.toggle("hidden", mode === 'login');
};

function showApp() {
  $("welcomeView")?.classList.add("hidden");
  $("authView")?.classList.add("hidden");
  $("appView")?.classList.remove("hidden");

  const name = profile?.full_name || currentUser?.email || "مستخدم";
  if ($("userLabel")) $("userLabel").textContent = name;
  if ($("avatarCircle")) $("avatarCircle").textContent = name.charAt(0).toUpperCase();
  if ($("roleBadge")) $("roleBadge").textContent = isAdmin() ? "المدير" : "مندوب";

  document.querySelectorAll(".admin-only").forEach(el => {
    el.classList.toggle("hidden", !isAdmin());
  });

  switchTab('home');
}

window.switchTab = function(tabName) {
  document.querySelectorAll(".tab-view").forEach(v => v.classList.add("hidden"));
  $(`${tabName}View`)?.classList.remove("hidden");

  document.querySelectorAll(".bottom-nav .nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("onclick")?.includes(tabName));
  });
};

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
      alert("حسابك بانتظار موافقة المدير.");
      goToAuth();
      return;
    }

    showApp();
    await refreshData();
  } catch (err) {
    console.error(err);
    alert("خطأ في التحميل: " + (err.message || "حدث خطأ غير متوقع"));
    await db.auth.signOut();
    goToAuth();
  }
}

async function refreshData() {
  if (!db) return;
  try {
    const goodsRes = await db.from("goods").select("*").order("created_at", { ascending: false });
    const inquiriesRes = await db.from("inquiries").select("*").order("created_at", { ascending: false });

    goods = goodsRes.data || [];
    inquiries = inquiriesRes.data || [];

    if (isAdmin()) {
      const repsRes = await db.from("profiles").select("*").eq("role", "rep").eq("status", "approved");
      const pendingRes = await db.from("profiles").select("*").eq("role", "rep").eq("status", "pending");
      const salesRes = await db.from("sales").select("*").order("created_at", { ascending: false });

      reps = repsRes.data || [];
      pendingReps = pendingRes.data || [];
      sales = salesRes.data || [];
    }

    render();
  } catch (err) {
    console.error("Refresh Error:", err);
  }
}

function render() {
  // Stats Dashboard
  if ($("statGoods")) $("statGoods").textContent = goods.filter(g => g.status === 'available').length;
  if ($("statReps")) $("statReps").textContent = reps.length;
  if ($("statCommission")) {
    const total = sales.reduce((acc, s) => acc + (Number(s.total_commission) || 0), 0);
    $("statCommission").textContent = money(total);
  }

  // Render Goods
  if ($("goodsList")) {
    $("goodsList").innerHTML = goods.map(g => `
      <div class="product-card">
        <div class="product-img">📦</div>
        <div class="product-info">
          <div class="product-title">${esc(g.title)}</div>
          <div class="product-code">${esc(g.area || 'غير محدد')}</div>
          <div class="product-price">${money(g.asking_price)}</div>
        </div>
        <div style="text-align: left;">
          <span class="status-pill ${g.status === 'available' ? 'pill-green' : 'pill-orange'}">
            ${g.status === 'available' ? 'متوفر' : 'غير متوفر'}
          </span>
          <div class="product-comm" style="margin-top: 6px;">العمولة: ${money(g.agreed_commission)}</div>
        </div>
      </div>
    `).join("");
  }
  if ($("emptyGoods")) $("emptyGoods").classList.toggle("hidden", goods.length > 0);

  // Render Reps
  if ($("repsList")) {
    let html = reps.map(r => `
      <div class="product-card">
        <div class="product-img" style="background: var(--blue-bg); color: var(--blue);">👤</div>
        <div class="product-info">
          <div class="product-title">${esc(r.full_name || 'مندوب')}</div>
          <div class="product-code">رمز المندوب: ${esc(r.rep_code || '—')}</div>
        </div>
        <span class="status-pill pill-green">نشط</span>
      </div>
    `).join("");

    if (pendingReps.length > 0) {
      html = `<div style="font-weight: 700; color: var(--navy); margin-bottom: 8px;">طلبات الانضمام المعلقة</div>` +
        pendingReps.map(r => `
          <div class="product-card" style="border-color: var(--gold);">
            <div class="product-img" style="background: var(--orange-bg); color: var(--orange);">⏳</div>
            <div class="product-info">
              <div class="product-title">${esc(r.full_name)}</div>
              <div class="product-code">طلب انضمام جديد</div>
            </div>
            <div style="display: flex; gap: 4px;">
              <button onclick="approveRep('${r.id}')" style="background: var(--green); color: #fff; border: none; padding: 6px 12px; border-radius: 8px; font-weight: 700; cursor: pointer;">قبول</button>
            </div>
          </div>
        `).join("") + html;
    }

    $("repsList").innerHTML = html;
  }
  if ($("emptyReps")) $("emptyReps").classList.toggle("hidden", (reps.length + pendingReps.length) > 0);

  // Render Inquiries
  if ($("inquiriesList")) {
    $("inquiriesList").innerHTML = inquiries.map(i => {
      const g = goods.find(x => x.id === i.goods_id);
      return `
        <div class="product-card">
          <div class="product-img" style="background: var(--purple-bg); color: var(--purple);">📞</div>
          <div class="product-info">
            <div class="product-title">${esc(i.buyer_name)}</div>
            <div class="product-code">الغرض: ${esc(g?.title || 'غير متاح')}</div>
            <div class="product-code">الهاتف: ${esc(i.buyer_phone || '—')}</div>
          </div>
        </div>
      `;
    }).join("");
  }
  if ($("emptyInquiries")) $("emptyInquiries").classList.toggle("hidden", inquiries.length > 0);

  // Render Sales
  if ($("salesList")) {
    $("salesList").innerHTML = sales.map(s => {
      const g = goods.find(x => x.id === s.goods_id);
      return `
        <div class="product-card">
          <div class="product-img" style="background: var(--green-bg); color: var(--green);">💳</div>
          <div class="product-info">
            <div class="product-title">${esc(g?.title || 'غرض')}</div>
            <div class="product-code">إجمالي العمولة: ${money(s.total_commission)}</div>
          </div>
          <div class="product-price">${money(s.final_price)}</div>
        </div>
      `;
    }).join("");
  }
  if ($("emptySales")) $("emptySales").classList.toggle("hidden", sales.length > 0);
}

window.handleLogin = async function() {
  const email = $("loginEmail")?.value?.trim();
  const password = $("loginPassword")?.value;

  if (!email || !password) return alert("يرجى إدخال البيانات كاملة");

  try {
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (data?.user) await startApp(data.user);
  } catch (err) {
    alert("خطأ في تسجيل الدخول: " + err.message);
  }
};

window.handleSignup = async function() {
  const fullName = $("signupName")?.value?.trim();
  const email = $("signupEmail")?.value?.trim();
  const password = $("signupPassword")?.value;

  if (!fullName || !email || !password) return alert("يرجى ملء كافة الحقول");

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

      alert("تم إرسال طلب الانضمام بنجاح! بانتظار موافقة المدير.");
      switchAuthMode('login');
    }
  } catch (err) {
    alert("تعذّر إنشاء الحساب: " + err.message);
  }
};

window.handleSaveGoods = async function() {
  const form = $("goodsForm");
  const formData = new FormData(form);

  try {
    const { error } = await db.from("goods").insert({
      title: formData.get("title"),
      area: formData.get("area"),
      asking_price: Number(formData.get("price")),
      agreed_commission: Number(formData.get("commission")),
      description: formData.get("notes"),
      status: "available",
      created_by: currentUser.id
    });

    if (error) throw error;

    form.reset();
    hideDialog("goodsDialog");
    await refreshData();
    alert("تم إضافة الغرض بنجاح");
  } catch (err) {
    alert("خطأ أثناء الإضافة: " + err.message);
  }
};

window.prepareInquiryDialog = function() {
  const select = $("inquiryGoods");
  select.innerHTML = goods.filter(g => g.status === 'available').map(g => `
    <option value="${g.id}">${g.title} - ${money(g.asking_price)}</option>
  `).join("");
  showDialog("inquiryDialog");
};

window.handleSaveInquiry = async function() {
  const form = $("inquiryForm");
  const formData = new FormData(form);

  try {
    const { error } = await db.from("inquiries").insert({
      goods_id: formData.get("goodsId"),
      rep_id: currentUser.id,
      buyer_name: formData.get("buyerName"),
      buyer_phone: formData.get("buyerPhone"),
      notes: formData.get("notes")
    });

    if (error) throw error;

    form.reset();
    hideDialog("inquiryDialog");
    await refreshData();
    alert("تم تسجيل الاستفسار بنجاح");
  } catch (err) {
    alert("تعذّر الحفظ: " + err.message);
  }
};

window.prepareSaleDialog = function() {
  const goodsSel = $("saleGoods");
  const repSel = $("saleRep");

  goodsSel.innerHTML = goods.filter(g => g.status === 'available').map(g => `
    <option value="${g.id}">${g.title}</option>
  `).join("");

  repSel.innerHTML = reps.map(r => `
    <option value="${r.id}">${r.full_name}</option>
  `).join("");

  showDialog("saleDialog");
};

window.handleSaveSale = async function() {
  const form = $("saleForm");
  const formData = new FormData(form);

  try {
    const commission = Number(formData.get("commission"));
    const managerShare = Math.floor(commission / 2);

    const { error } = await db.from("sales").insert({
      goods_id: formData.get("goodsId"),
      rep_id: formData.get("repId"),
      final_price: Number(formData.get("price")),
      total_commission: commission,
      manager_share: managerShare,
      rep_share: commission - managerShare,
      verified_by: currentUser.id
    });

    if (error) throw error;

    await db.from("goods").update({ status: 'sold' }).eq("id", formData.get("goodsId"));

    form.reset();
    hideDialog("saleDialog");
    await refreshData();
    alert("تم تسجيل البيع بنجاح");
  } catch (err) {
    alert("تعذّر تسجيل البيع: " + err.message);
  }
};

window.approveRep = async function(repId) {
  try {
    const { error } = await db.from("profiles").update({ status: 'approved' }).eq("id", repId);
    if (error) throw error;
    await refreshData();
    alert("تم قبول المندوب بنجاح");
  } catch (err) {
    alert("تعذّر القبول: " + err.message);
  }
};

window.handleLogout = async function() {
  if (db) await db.auth.signOut();
  currentUser = null;
  profile = null;
  goToAuth();
};

// Auto Check Auth
if (db) {
  db.auth.getSession().then(({ data }) => {
    if (data.session?.user) startApp(data.session.user);
  });
}
