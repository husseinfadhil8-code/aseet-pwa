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
let editingGoodsId = null;

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

let pushRegistration = null;
let pushSubscription = null;

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
}

function updatePushButton() {
  const button = $("pushNotificationsButton");
  if (!button) return;
  button.textContent = pushSubscription ? "🔔 الإشعارات مفعّلة — إيقافها" : "🔔 تفعيل الإشعارات";
  button.style.background = pushSubscription ? "var(--green)" : "var(--navy)";
}

async function initPushNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    pushRegistration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    pushSubscription = await pushRegistration.pushManager.getSubscription();
    updatePushButton();
  } catch (err) {
    console.warn("Push setup is not ready:", err);
  }
}

async function sendPushEvent(event, payload = {}) {
  try {
    const { data, error } = await db.functions.invoke("push-notifications", {
      body: { event, ...payload }
    });
    if (error) {
      console.warn("Push event was not sent:", error.message || error);
      return { ok: false, error: error.message || String(error) };
    }
    return data || { ok: true };
  } catch (err) {
    console.warn("Push event unavailable:", err);
    return { ok: false, error: err?.message || String(err) };
  }
}

window.testPushNotification = async function() {
  if (!currentUser || !isAdmin()) return alert("اختبار الإشعارات متاح للمدير فقط.");
  const button = $("testPushButton");
  if (button) { button.disabled = true; button.textContent = "جارٍ إرسال الاختبار…"; }
  try {
    const result = await sendPushEvent("test_push");
    if (!result?.ok) {
      alert("تعذّر إرسال إشعار الاختبار: " + (result?.error || "تحقق من سجلات Supabase."));
    } else if (Number(result.sent) > 0) {
      alert("تم إرسال إشعار الاختبار إلى جهازك. اخرج من التطبيق وانتظر وصوله.");
    } else {
      alert("خدمة الإشعارات ردّت، لكنها لم ترسل إشعاراً. السبب: " + (result.reason || "لا يوجد اشتراك محفوظ لحساب المدير."));
    }
  } finally {
    if (button) { button.disabled = false; button.textContent = "🧪 اختبار الإشعار خارج التطبيق"; }
  }
};

window.togglePushNotifications = async function() {
  if (!currentUser || !db) return alert("سجّل الدخول أولاً.");

  // على iPhone/iPad افحص وضع التطبيق أولاً حتى لا تظهر رسالة دعم عامة مضللة في Safari العادي.
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (isIOS && !isStandalone) {
    return alert("إشعارات الويب على الآيفون تحتاج فتح وسيط من أيقونة الشاشة الرئيسية. في Safari اضغط مشاركة ثم «إضافة إلى الشاشة الرئيسية»، وبعدها افتح الأيقونة وفعّل الإشعارات.");
  }

  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return alert("هذا المتصفح أو وضع التشغيل الحالي لا يدعم إشعارات الويب. على الآيفون افتح وسيط من أيقونة الشاشة الرئيسية، وتأكد من تحديث iOS.");
  }

  try {
    // اطلب الإذن مباشرةً من ضغطة المستخدم، قبل أي انتظار غير ضروري (مهم خصوصاً على Safari/iOS).
    const permissionPromise = Notification.permission === "granted"
      ? Promise.resolve("granted")
      : Notification.requestPermission();
    const permission = await permissionPromise;
    if (permission !== "granted") return alert("لم يتم السماح بالإشعارات. فعّلها من إعدادات المتصفح.");

    pushRegistration = pushRegistration || await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    pushSubscription = await pushRegistration.pushManager.getSubscription();

    if (pushSubscription) {
      const { error } = await db.from("push_subscriptions")
        .delete().eq("user_id", currentUser.id).eq("endpoint", pushSubscription.endpoint);
      if (error) throw error;
      await pushSubscription.unsubscribe();
      pushSubscription = null;
      updatePushButton();
      alert("تم إيقاف الإشعارات على هذا الجهاز.");
      return;
    }

    const { data: keyData, error: keyError } = await db.functions.invoke("push-notifications", {
      body: { action: "get_public_key" }
    });
    if (keyError || !keyData?.publicKey) {
      throw new Error("خدمة الإشعارات غير مهيأة بعد في Supabase.");
    }

    pushSubscription = await pushRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
    });

    const subscriptionJson = pushSubscription.toJSON();
    const { error: saveError } = await db.from("push_subscriptions").upsert({
      user_id: currentUser.id,
      endpoint: pushSubscription.endpoint,
      subscription: subscriptionJson,
      updated_at: new Date().toISOString()
    }, { onConflict: "endpoint" });
    if (saveError) {
      await pushSubscription.unsubscribe();
      pushSubscription = null;
      throw saveError;
    }

    updatePushButton();
    alert("تم تفعيل الإشعارات لهذا الجهاز بنجاح.");
  } catch (err) {
    console.error("Enable push failed:", err);
    alert("تعذّر تفعيل الإشعارات: " + (err.message || "تحقق من إعداد Supabase ثم حاول مجدداً."));
  }
};

window.shareSingleGoodOnWhatsApp = function(goodsId) {
  if (!isAdmin()) return alert("مشاركة الأغراض متاحة للمدير فقط.");
  const good = goods.find(g => String(g.id) === String(goodsId));
  if (!good) return alert("ما لكيت هذا الغرض. حدّث القائمة وحاول مرة ثانية.");
  if (good.status !== "available") return alert("هذا الغرض غير متوفر حالياً.");

  const message = `📣 *غرض من وسيط للبيع*\n\n🛍️ *${good.title}*\n💰 السعر المطلوب: ${money(good.asking_price)}\n📍 المنطقة: ${good.area || "غير محدد"}\n🤝 العمولة: ${money(good.agreed_commission)}\n\nللاستفسار ومشاهدة التفاصيل، افتح منصة وسيط:\nhttps://husseinfadhil8-code.github.io/aseet-pwa/\n\nيا الله يا رزّاق 🤝`;
  window.open("https://wa.me/?text=" + encodeURIComponent(message), "_blank", "noopener,noreferrer");
};

window.shareAvailableGoodsOnWhatsApp = function() {
  if (!isAdmin()) return alert("مشاركة قائمة الأغراض متاحة للمدير فقط.");
  const availableGoods = goods.filter(g => g.status === "available");
  if (!availableGoods.length) return alert("ماكو أغراض متوفرة حالياً لمشاركتها.");

  const lines = availableGoods.slice(0, 15).map((g, index) =>
    `${index + 1}) ${g.title} — ${money(g.asking_price)}\n📍 المنطقة: ${g.area || "غير محدد"}\n🤝 العمولة: ${money(g.agreed_commission)}`
  );
  const more = availableGoods.length > 15 ? `\n\nوغيرها ${availableGoods.length - 15} أغراض داخل التطبيق.` : "";
  const message = `📣 *أغراض جديدة من وسيط*\n\n${lines.join("\n\n")}${more}\n\nافتح منصة وسيط لمشاهدة القائمة والتواصل:\nhttps://husseinfadhil8-code.github.io/aseet-pwa/\n\nيا الله يا رزّاق 🤝`;
  const whatsappUrl = "https://wa.me/?text=" + encodeURIComponent(message);
  window.open(whatsappUrl, "_blank", "noopener,noreferrer");
};

window.selectRole = function(role) {
  selectedRole = role;
  $("roleAdmin")?.classList.toggle("active", role === 'admin');
  $("roleRep")?.classList.toggle("active", role === 'rep');
};

window.switchAuthMode = function(mode) {
  const signup = mode === "signup";
  $("loginForm")?.classList.toggle("hidden", signup);
  $("signupForm")?.classList.toggle("hidden", !signup);
  const title = $("authTitle");
  if (title) title.textContent = signup ? "طلب انضمام مندوب جديد" : "تسجيل الدخول";
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
    const permissions = profile?.permissions || {};
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
  if (!db || !currentUser) return;
  
  try {
    const { data, error } = await db
      .from("profiles")
      .select("*")
      .eq("id", currentUser.id)
      .maybeSingle();

    if (error) {
      console.warn("Profile fetch warning:", error);
    }

    if (data) {
      profile = data;
    } else {
      profile = null;
      console.warn("No profile exists for this authenticated user.");
    }
  } catch (err) {
    console.error("loadProfile err:", err);
    profile = null;
  }
}

async function startApp(user) {
  currentUser = user;
  try {
    await loadProfile();

    if (!profile) {
      alert("ما لكينا ملف حسابك في وسيط. إذا تريد تنضم كمندوب، ارجع واختر «تقديم طلب انضمام»؛ وإذا عندك حساب سابق تواصل مع المدير.");
      await db.auth.signOut();
      currentUser = null;
      return;
    }

    if (profile?.status === 'banned') {
      alert("عذراً، تم حظر هذا الحساب من قبل الإدارة ولا يمكنه استخدام التطبيق.");
      return;
    }

    if (!isAdmin() && profile?.status !== "approved" && profile?.status !== "restricted") {
      alert(profile?.status === "pending"
        ? "طلب انضمامك مسجل بالفعل وبانتظار موافقة المدير. لا تحتاج إلى تقديم طلب جديد."
        : "حسابك غير مفعّل حالياً. تواصل مع المدير.");
      await db.auth.signOut();
      currentUser = null;
      profile = null;
      return;
    }

    showApp();
    void initPushNotifications();
    await refreshData();
  } catch (err) {
    console.error("startApp Error:", err);
    alert("حدث خطأ أثناء الاتصال: " + (err.message || "يرجى المحاولة لاحقاً"));
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
      <div class="product-card" style="display:block;padding:12px;">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;">
          <div class="product-img" style="flex:0 0 48px;width:48px;height:48px;">📦</div>
          <div class="product-info" style="min-width:0;overflow-wrap:anywhere;">
            <div class="product-title">${esc(g.title)}</div>
            <div class="product-code">${esc(g.area || 'غير محدد')}</div>
            <div class="product-price">${money(g.asking_price)}</div>
            <div class="product-comm" style="margin-top:4px;">العمولة: ${money(g.agreed_commission)}</div>
          </div>
          <span class="status-pill ${g.status === 'available' ? 'pill-green' : 'pill-orange'}" style="flex-shrink:0;">
            ${g.status === 'available' ? 'متوفر' : 'غير متوفر'}
          </span>
        </div>
        ${isAdmin() ? `
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--border);width:100%;">
            ${g.status === 'available' ? `<button type="button" onclick="event.stopPropagation(); shareSingleGoodOnWhatsApp('${g.id}')" style="flex:1;min-width:120px;background:#128C7E;color:#fff;border:0;border-radius:8px;padding:9px 10px;font-size:13px;font-weight:700;">🟢 مشاركة هذا الغرض</button>` : ''}
            <button type="button" onclick="event.stopPropagation(); editGoods('${g.id}')" style="flex:1;min-width:100px;background:var(--navy);color:var(--gold);border:0;border-radius:8px;padding:9px 10px;font-size:13px;font-weight:700;">✏️ تعديل الغرض</button>
            <button type="button" onclick="event.stopPropagation(); deleteGoods('${g.id}')" style="flex:1;min-width:100px;background:#FEE2E2;color:#B91C1C;border:0;border-radius:8px;padding:9px 10px;font-size:13px;font-weight:700;">🗑️ حذف الغرض</button>
          </div>` : ''}
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
          <div style="text-align: left; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
            ${statusBadge}
            <button type="button" style="background: var(--navy); color: #fff; border: none; padding: 4px 10px; border-radius: 8px; font-size: 11px; font-weight: 700; cursor: pointer;">إدارة ⚙️</button>
          </div>
        </div>
      `;
    }).join("");

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

window.openRepManage = function(repId, repName, status) {
  activeManageRepId = repId;
  $("manageRepTitle").textContent = `إدارة المندوب: ${repName}`;
  $("manageRepBody").textContent = `الحالة الحالية: ${status === 'banned' ? 'محظور' : status === 'restricted' ? 'مقيّد' : 'نشط'}`;
  $("actionReason").value = "";
  showDialog('repManageDialog');
};

window.executeRepAction = async function(action) {
  if (!activeManageRepId) return;
  const reason = $("actionReason")?.value?.trim() || "بدون سبب مخصص";
  const dateStr = new Date().toISOString();

  let updatePayload = {};
  if (action === 'ban') {
    if (!confirm("هل أنت متأكد من حظر هذا المندوب؟ لن يتمكن من استخدام التطبيق.")) return;
    updatePayload = { status: 'banned', permissions: { banned_reason: reason, banned_at: dateStr } };
  } else if (action === 'unban') {
    updatePayload = { status: 'approved', permissions: { unbanned_reason: reason, unbanned_at: dateStr } };
  } else if (action === 'restrict') {
    if (!confirm("هل تريد تقييد صلاحيات هذا المندوب؟")) return;
    updatePayload = { status: 'restricted', permissions: { can_add_inquiry: false, restricted_reason: reason, restricted_at: dateStr } };
  } else if (action === 'promote') {
    if (!confirm("هل أنت متأكد من ترقية هذا المندوب إلى دور مدير (Admin)؟")) return;
    updatePayload = { role: 'admin', status: 'approved', permissions: { promoted_reason: reason, promoted_at: dateStr } };
  }

  try {
    const { error } = await db.from("profiles").update(updatePayload).eq("id", activeManageRepId);
    if (error) throw error;

    hideDialog('repManageDialog');
    await refreshData();
    if (["ban", "restrict", "unban"].includes(action)) {
      void sendPushEvent("rep_status", { targetUserId: activeManageRepId });
    }
    alert("تم تنفيذ الإجراء بنجاح وتسجيل السبب.");
  } catch (err) {
    alert("تعذّر تنفيذ الإجراء: " + err.message);
  }
};

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
      const { error: profileError } = await db.from("profiles").upsert({
        id: data.user.id,
        full_name: fullName,
        role: "rep",
        rep_code: repCode,
        status: "pending",
        permissions: { can_add_inquiry: true }
      });
      if (profileError) throw profileError;
      void sendPushEvent("new_rep");

      alert("تم إرسال طلب الانضمام بنجاح! بانتظار موافقة المدير.");
      switchAuthMode('login');
    }
  } catch (err) {
    alert("تعذّر إنشاء الحساب: " + err.message);
  }
};

window.prepareAddGoods = function() {
  if (!isAdmin()) return alert("إضافة الأغراض متاحة للمدير فقط.");
  editingGoodsId = null;
  $("goodsForm")?.reset();
  $("goodsDialogTitle").textContent = "إضافة غرض جديد";
  $("saveGoodsButton").textContent = "حفظ";
  showDialog("goodsDialog");
};

window.editGoods = function(goodsId) {
  if (!isAdmin()) return alert("إضافة وتعديل الأغراض متاحان للمدير فقط.");
  const item = goods.find(g => String(g.id) === String(goodsId));
  if (!item) return alert("لم يتم العثور على الغرض. حدّث القائمة وحاول مجدداً.");

  editingGoodsId = item.id;
  const form = $("goodsForm");
  form.elements.title.value = item.title || "";
  form.elements.area.value = item.area || "";
  form.elements.price.value = item.asking_price ?? "";
  form.elements.commission.value = item.agreed_commission ?? "";
  form.elements.notes.value = item.description || "";
  $("goodsDialogTitle").textContent = "تعديل بيانات الغرض";
  $("saveGoodsButton").textContent = "حفظ التعديلات";
  showDialog("goodsDialog");
};

window.deleteGoods = async function(goodsId) {
  if (!isAdmin()) return alert("حذف الأغراض متاح للمدير فقط.");
  const item = goods.find(g => String(g.id) === String(goodsId));
  if (!item) return alert("لم يتم العثور على الغرض.");

  const hasSale = sales.some(s => String(s.goods_id) === String(goodsId));
  const warning = hasSale
    ? "هذا الغرض مرتبط بسجل بيع. قد يمنع نظام قاعدة البيانات حذفه حفاظاً على السجلات.\n\n"
    : "";
  if (!confirm(warning + "هل تريد حذف الغرض «" + (item.title || "بدون اسم") + "» نهائياً؟ لا يمكن التراجع عن الحذف.")) return;

  try {
    const { error } = await db.from("goods").delete().eq("id", goodsId);
    if (error) throw error;
    await refreshData();
    alert("تم حذف الغرض.");
  } catch (err) {
    alert("تعذّر حذف الغرض: " + (err.message || "تحقق من صلاحيات قاعدة البيانات أو ارتباط الغرض بسجل آخر."));
  }
};

window.handleSaveGoods = async function() {
  if (!isAdmin()) return alert("إضافة وتعديل الأغراض متاحان للمدير فقط.");
  const form = $("goodsForm");
  if (!form.reportValidity()) return;
  const formData = new FormData(form);
  const payload = {
    title: String(formData.get("title") || "").trim(),
    area: String(formData.get("area") || "").trim(),
    asking_price: Number(formData.get("price")),
    agreed_commission: Number(formData.get("commission")),
    description: String(formData.get("notes") || "").trim()
  };

  if (!payload.title || !Number.isFinite(payload.asking_price) || payload.asking_price < 0 ||
      !Number.isFinite(payload.agreed_commission) || payload.agreed_commission < 0) {
    return alert("تأكد من اسم الغرض والسعر والعمولة.");
  }

  try {
    let result;
    if (editingGoodsId !== null) {
      result = await db.from("goods").update(payload).eq("id", editingGoodsId);
    } else {
      result = await db.from("goods").insert({
        ...payload,
        status: "available",
        created_by: currentUser.id
      }).select("id").single();
    }
    if (result.error) throw result.error;

    const wasEditing = editingGoodsId !== null;
    if (!wasEditing && result.data?.id) void sendPushEvent("new_goods", { goodsId: result.data.id });
    form.reset();
    editingGoodsId = null;
    $("goodsDialogTitle").textContent = "إضافة غرض جديد";
    $("saveGoodsButton").textContent = "حفظ";
    hideDialog("goodsDialog");
    await refreshData();
    alert(wasEditing ? "تم تحديث الغرض بنجاح" : "تم إضافة الغرض بنجاح");
  } catch (err) {
    alert("تعذّر حفظ الغرض: " + (err.message || "حدث خطأ غير متوقع"));
  }
};

window.prepareInquiryDialog = function() {
  if (!isAdmin() && profile?.permissions?.can_add_inquiry === false) {
    return alert("عذراً، تم تقييد صلاحية إضافة الاستفسارات لحسابك من قبل الإدارة.");
  }

  const select = $("inquiryGoods");
  if (!select) return;
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
  if (!goodsSel || !repSel) return;

  goodsSel.innerHTML = goods.filter(g => g.status === 'available').map(g => `
    <option value="${g.id}">${g.title}</option>
  `).join("");

  repSel.innerHTML = reps.filter(r => r.status !== 'banned').map(r => `
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

    const { data: savedSale, error } = await db.from("sales").insert({
      goods_id: formData.get("goodsId"),
      rep_id: formData.get("repId"),
      final_price: Number(formData.get("price")),
      total_commission: commission,
      manager_share: managerShare,
      rep_share: commission - managerShare,
      verified_by: currentUser.id
    }).select("id").single();

    if (error) throw error;

    await db.from("goods").update({ status: 'sold' }).eq("id", formData.get("goodsId"));
    if (savedSale?.id) void sendPushEvent("sale", { saleId: savedSale.id });

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
    void sendPushEvent("rep_status", { targetUserId: repId });
    alert("تم قبول المندوب بنجاح");
  } catch (err) {
    alert("تعذّر القبول: " + err.message);
  }
};

window.handleLogout = async function() {
  if (db) await db.auth.signOut();
  currentUser = null;
  profile = null;
  $("appView")?.classList.add("hidden");
  $("welcomeView")?.style.setProperty("display", "flex");
};

if (db) {
  db.auth.getSession().then(({ data }) => {
    if (data.session?.user) {
      startApp(data.session.user);
    }
  });
}
