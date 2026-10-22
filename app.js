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
  
  // طلب الأعمدة المضمونة لتجنب أي أخطاء في حال عدم وجود عمود permissions في Supabase
  const { data, error } = await db
    .from("profiles")
    .select("id, full_name, role, rep_code, status")
    .eq("id", currentUser.id)
    .single();

  if (error) throw error;
  
  profile = {
    ...data,
    permissions: data.permissions || { can_add_inquiry: true }
  };
}

async function startApp(user) {
  currentUser = user;
  try {
    await loadProfile();

    // 1. إذا كان الحساب محظوراً: منع الوصول وتوجيهه لشاشة تسجيل الدخول بدون إلغاء جلسة المدير
    if (profile?.status === 'banned') {
      currentUser = null;
      profile = null;
      alert("عذراً، تم حظر هذا الحساب من قبل الإدارة ولا يمكنه استخدام التطبيق.");
      $("appView")?.classList.add("hidden");
      $("welcomeView")?.style.setProperty("display", "flex");
      $("authView")?.classList.add("hidden");
      return;
    }

    // 2. إذا كان الحساب بانتظار موافقة المدير
    if (!isAdmin() && profile?.status !== "approved" && profile?.status !== "restricted") {
      currentUser = null;
      profile = null;
      alert("حسابك بانتظار موافقة المدير.");
      $("appView")?.classList.add("hidden");
      $("welcomeView")?.style.setProperty("display", "flex");
      $("authView")?.classList.add("hidden");
      return;
    }

    // 3. السماح بالدخول
    showApp();
    await refreshData();
  } catch (err) {
    console.error(err);
    alert("خط
