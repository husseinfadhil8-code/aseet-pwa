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
  setTimeout(() => box.classList.remove("show"), 4000);
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
    alert("حدث خطأ أثناء تحميل الملف الشخص
