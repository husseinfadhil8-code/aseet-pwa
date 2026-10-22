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
let activeManageRepId = null;

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

  if (!isAdmin() && profile?.status === 'restricted') {
    const permissions = profile.permissions || {};
    if (permissions.can_add_inquiry === false) {
      $("addInquiryFab")?.classList.add("hidden");
    }
  }

  window.switchTab('home');
}

window.switchTab = function(tabName) {
  document.querySelectorAll(".tab-view").forEach(v => v.classList.add("hidden"));
  const target = $(tabName + "View");
  if (target) target.classList.remove("hidden");

  document.querySelectorAll(".bottom-nav .nav-item").forEach(btn => {
    const onclickAttr = btn.getAttribute("onclick") || "";
    btn.classList.toggle("active", onclickAttr.includes(`'${tabName}'`));
  });

  window.scrollTo(0, 0);
};

async function loadProfile() {
  if (!db) return;
  const { data, error } = await db
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  if (error) throw error;
  profile = data;
}

async function startApp(user) {
  currentUser = user;
  try {
    await loadProfile();

    if (profile?.status === 'banned') {
      await db.auth.signOut();
      currentUser = null;
      profile = null;
      alert("عذراً، تم حظر هذا الحساب من قبل الإدارة.");
      $("welcomeView")?.style.setProperty("display", "flex");
      $("authView")?.classList.add("hidden");
      return;
    }

    if (!isAdmin() && profile?.status !== "approved" && profile?.status !== "restricted") {
      await db.auth.signOut();
      currentUser = null;
      profile = null;
      alert("حسابك بانتظار موافقة المدير.");
      $("welcomeView")?.style.setProperty("display", "flex");
      $("authView")?.classList.add("hidden");
      return;
    }

    showApp();
    await refreshData();
  } catch (err) {
    console.error(err);
    alert("خطأ في التحميل: " + (err.message || "حدث خطأ غير متوقع"));
    await db.auth.signOut();
    $("welcomeView")?.style.setProperty("display", "flex");
    $("authView")?.classList.add("hidden");
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
      const repsRes = await db.from("profiles").select("*").eq("role", "rep");
      const salesRes = await db.from("sales").select("*").order("created_at", { ascending: false });

      const allReps = repsRes.data || [];
      reps = allReps.filter(r => r.status === 'approved' || r.status === 'restricted' || r.status === 'banned');
      pendingReps = allReps.filter(r => r.status === 'pending');
      sales = salesRes.data || [];
    }

    render();
  } catch (err) {
    console.error("Refresh Error:", err);
  }
}

function render() {
  if ($("statGoods")) $("statGoods").textContent = goods.filter(g => g.status === 'available').length;
  if ($("statReps")) $("statReps").textContent = reps.filter(r => r.status !== 'banned').length;
  if ($("statCommission")) {
    const total = sales.reduce((acc, s) => acc + (Number(s.total_commission) || 0), 0);
    $("statCommission").textContent = money(total);
  }

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

  if ($("repsList")) {
    let html = reps.map(r => {
      let statusBadge = '<span class="status-pill pill-green">نشط</span>';
      if (r.status === 'banned') statusBadge = '<span class="status-pill pill-red">محظور</span>';
      else if (r.status === 'restricted') statusBadge = '<span class="status-pill pill-orange">مقيّد</span>';

      return `
        <div class="product-card" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center;" onclick="openRepManage('${r.id}', '${esc(r.full_name)}', '${r.status}')">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div class="product-img" style="background: var(--blue-bg); color: var(--blue);">👤</div>
            <div class="product-info">
              <div class="product-title">${esc(r.full_name || 'مندوب')}</div>
              <div class="product-code">رمز المندوب: ${esc(r.rep_code || '—')}</div>
            </div>
          </div>
          <div style="text-align: left; display
