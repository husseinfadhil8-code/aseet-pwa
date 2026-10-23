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
let notifications = [];
let pendingReps = [];
let selectedRole = 'admin';
let activeManageRepId = null;
let editingGoodsId = null;
let presenceTimer = null;
let lastPresenceLocation = null;

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

    // A green browser subscription alone does not guarantee it is saved for this signed-in account.
    // Re-sync an existing subscription whenever an approved user opens the app.
    if (pushSubscription && currentUser && db) {
      const { error: syncError } = await db.from("push_subscriptions").upsert({
        user_id: currentUser.id,
        endpoint: pushSubscription.endpoint,
        subscription: pushSubscription.toJSON(),
        updated_at: new Date().toISOString()
      }, { onConflict: "endpoint" });
      if (syncError) {
        console.warn("Existing push subscription could not be synced to this account:", syncError.message);
      }
    }

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
      let detail = error.message || String(error);
      try {
        if (error.context && typeof error.context.clone === "function") {
          const response = error.context.clone();
          const body = await response.text();
          if (body) detail += " — " + body.slice(0, 500);
        }
      } catch (_) {}
      console.warn("Push event was not sent:", detail);
      return { ok: false, error: detail };
    }
    return data || { ok: true };
  } catch (err) {
    console.warn("Push event unavailable:", err);
    return { ok: false, error: err?.message || String(err) };
  }
}

function formatLastSeen(value) {
  if (!value) return "لم يسجّل نشاط بعد";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "وقت النشاط غير معروف";
  if (seconds < 90) return "آخر نشاط: الآن";
  if (seconds < 3600) return "آخر نشاط: قبل " + Math.floor(seconds / 60) + " دقيقة";
  if (seconds < 86400) return "آخر نشاط: قبل " + Math.floor(seconds / 3600) + " ساعة";
  return "آخر نشاط: قبل " + Math.floor(seconds / 86400) + " يوم";
}

function presenceSummary(rep) {
  const fresh = rep.online === true && rep.last_seen_at && (Date.now() - new Date(rep.last_seen_at).getTime() < 150000);
  const state = fresh ? "🟢 نشط الآن تقريباً" : "⚪ غير نشط حالياً";
  const location = rep.last_latitude != null && rep.last_longitude != null &&
    Number.isFinite(Number(rep.last_latitude)) && Number.isFinite(Number(rep.last_longitude))
    ? `<br><a href="https://www.google.com/maps?q=${encodeURIComponent(rep.last_latitude + "," + rep.last_longitude)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="color:var(--blue);font-weight:700;">📍 عرض آخر موقع شاركه</a>`
    : "<br>📍 لم يشارك موقعه";
  return state + "<br>" + formatLastSeen(rep.last_seen_at) + location;
}

async function updatePresence(location = lastPresenceLocation, online = true) {
  if (!currentUser || !db) return;
  const payload = { online, locationShared: Boolean(location) };
  if (location) {
    payload.latitude = location.latitude;
    payload.longitude = location.longitude;
    payload.locationAccuracy = location.accuracy;
  }
  const result = await sendPushEvent("presence_update", payload);
  if (!result?.ok) console.warn("Presence update failed:", result.error);
}

function startPresenceTracking() {
  if (!currentUser || !profile) return;
  if (presenceTimer) clearInterval(presenceTimer);
  lastPresenceLocation = null;

  const sendInitialPresence = () => void updatePresence(null, true);
  sendInitialPresence();

  // Location is requested by the browser and shared only if the user grants permission.
  if (profile.role === "rep" && "geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
      position => {
        lastPresenceLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy
        };
        void updatePresence(lastPresenceLocation, true);
      },
      error => console.info("Location was not shared:", error.message),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 }
    );
  }

  presenceTimer = setInterval(() => {
    if (document.visibilityState === "visible") {
      if (lastPresenceLocation) {
        // Refresh coordinates periodically only after the user has granted location access.
        navigator.geolocation?.getCurrentPosition(position => {
          lastPresenceLocation = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy
          };
          void updatePresence(lastPresenceLocation, true);
        }, () => void updatePresence(null, true), { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 });
      } else {
        void updatePresence(null, true);
      }
    }
  }, 60000);
}

function stopPresenceTracking() {
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = null;
  if (currentUser) void updatePresence(null, false);
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

window.announceAppUpdate = async function() {
  if (!currentUser || !isAdmin()) return alert("إعلان تحديثات التطبيق متاح للمدير فقط.");
  const titleInput = $("appUpdateTitle");
  const messageInput = $("appUpdateMessage");
  const title = String(titleInput?.value || "").trim();
  const message = String(messageInput?.value || "").trim();
  if (!title || !message) return alert("اكتب عنوان التحديث ورسالة مختصرة للمندوبين.");
  if (title.length > 90 || message.length > 220) return alert("العنوان بحد أقصى 90 حرفاً والرسالة بحد أقصى 220 حرفاً.");

  const button = $("sendAppUpdateButton");
  if (button) { button.disabled = true; button.textContent = "جارٍ إرسال الإعلان…"; }
  try {
    let inAppSaved = false;
    let inAppError = "";
    try {
      const { data: recipients, error: recipientsError } = await db.from("profiles")
        .select("id")
        .eq("role", "rep")
        .in("status", ["approved", "restricted"]);
      if (recipientsError) throw recipientsError;
      const rows = (recipients || []).map(rep => ({
        recipient_id: rep.id,
        created_by: currentUser.id,
        title,
        body: message,
        category: "app_update",
        metadata: { source: "admin_announcement" }
      }));
      if (rows.length) {
        const { error: insertError } = await db.from("notifications").insert(rows);
        if (insertError) throw insertError;
      }
      inAppSaved = true;
    } catch (saveError) {
      inAppError = saveError?.message || String(saveError);
      console.warn("Update announcement could not be saved to in-app notifications:", inAppError);
    }

    const result = await sendPushEvent("app_update", {
      updateTitle: title,
      updateMessage: message
    });

    if (!result?.ok) {
      alert("تعذّر إرسال الإشعار الخارجي: " + (result?.error || "تحقق من خدمة الإشعارات في Supabase.") +
        (inAppSaved ? "\nتم حفظ الإعلان داخل التطبيق." : "\nتعذّر حفظه داخل التطبيق: " + inAppError));
      if (inAppSaved) {
        if (titleInput) titleInput.value = "";
        if (messageInput) messageInput.value = "";
        hideDialog("appUpdateDialog");
      }
      return;
    }

    if (inAppSaved) {
      alert("تم حفظ إعلان التحديث داخل سجل إشعارات المندوبين، وإرسال طلب الإشعار الخارجي. عدد الأجهزة التي أبلغت الخدمة بإرسالها: " + (Number(result.sent) || 0) + ".");
      if (titleInput) titleInput.value = "";
      if (messageInput) messageInput.value = "";
      hideDialog("appUpdateDialog");
    } else {
      alert("تم التعامل مع الإشعار الخارجي، لكن تعذّر حفظ الإعلان داخل سجل التطبيق. شغّل ملف supabase/notifications.sql في Supabase SQL Editor ثم أعد المحاولة. التفاصيل: " + inAppError);
    }
  } catch (err) {
    alert("تعذّر إرسال إعلان التحديث: " + (err?.message || String(err)));
  } finally {
    if (button) { button.disabled = false; button.textContent = "📣 إرسال للمندوبين"; }
  }
};

window.testRepPushNotification = async function(repId) {
  if (!currentUser || !isAdmin()) return alert("هذا الاختبار متاح للمدير فقط.");
  if (!repId) return alert("لم يتم تحديد المندوب.");
  const button = document.querySelector('[data-test-rep-push="' + repId + '"]');
  if (button) { button.disabled = true; button.textContent = "جارٍ الاختبار…"; }
  try {
    // Reuse the existing rep_status handler; "test" sends a neutral account-update notice.
    const result = await sendPushEvent("rep_status", {
      targetUserId: repId,
      statusAction: "test"
    });
    if (!result?.ok) {
      alert("تعذّر إرسال الاختبار: " + (result?.error || "راجع سجلات Supabase."));
    } else if (Number(result.sent) > 0) {
      alert("خدمة الإشعارات أرسلت الإشعار إلى " + result.sent + " اشتراك. افحص جهاز المندوب.");
    } else {
      alert("الخدمة اشتغلت، لكن ما لكت اشتراك إشعارات محفوظ لهذا المندوب. نحتاج نفحص مزامنة الاشتراك.");
    }
  } catch (err) {
    alert("تعذّر اختبار إشعار المندوب: " + (err?.message || String(err)));
  } finally {
    if (button) { button.disabled = false; button.textContent = "🔔 اختبار إشعار"; }
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
    const isAccount = tabName === "account" && onclickAttr.includes("openAccountView");
    btn.classList.toggle("active", onclickAttr.includes(`'${tabName}'`) || isAccount);
  });

  if (tabName === "account") renderAccountView();
  window.scrollTo(0, 0);
};

function renderAccountView() {
  const name = profile?.full_name || currentUser?.email || "حساب المستخدم";
  if ($("accountName")) $("accountName").textContent = name;
  if ($("accountAvatar")) $("accountAvatar").textContent = String(name).trim().charAt(0) || "م";
  if ($("accountEmail")) $("accountEmail").textContent = currentUser?.email || "غير متوفر";
  if ($("accountRole")) $("accountRole").textContent = profile?.role === "admin" ? "مدير وسيط" : (profile?.status === "restricted" ? "مندوب مقيّد" : "مندوب وسيط");
}

window.openAccountView = function() {
  if (!currentUser || !profile) return alert("سجّل الدخول حتى تفتح حسابك.");
  window.switchTab("account");
};

window.showSupportDialog = function() { showDialog("supportDialog"); };
window.showNotificationsDialog = function() { showDialog("notificationsDialog"); };

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
    startPresenceTracking();
    await refreshData();
  } catch (err) {
    console.error("startApp Error:", err);
    alert("حدث خطأ أثناء الاتصال: " + (err.message || "يرجى المحاولة لاحقاً"));
  }
}


function notificationDate(value) {
  if (!value) return "الوقت غير متوفر";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "الوقت غير متوفر";
  return date.toLocaleString("ar-IQ", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

function renderNotificationBadge() {
  const badge = $("notificationBadge");
  if (!badge) return;
  const unread = notifications.filter(item => !item.read_at).length;
  badge.textContent = unread > 9 ? "9+" : String(unread);
  badge.classList.toggle("hidden", unread === 0);
  const button = $("notificationsHeaderButton");
  if (button) button.setAttribute("aria-label", unread ? `الإشعارات، ${unread} غير مقروءة` : "الإشعارات");
}

function renderNotificationsList() {
  const list = $("notificationsList");
  const empty = $("notificationsEmpty");
  if (!list) return;
  if (!notifications.length) {
    list.innerHTML = "";
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");
  list.innerHTML = notifications.map(item => {
    const isUnread = !item.read_at;
    const icon = item.category === "new_goods" ? "📦" : item.category === "app_update" ? "🚀" : "🔔";
    return `
      <button type="button" class="notification-card ${isUnread ? "notification-unread" : ""}"
        onclick="openNotificationItem('${esc(item.id)}')" aria-label="${isUnread ? "وضع الإشعار كمقروء: " : ""}${esc(item.title)}">
        <span class="notification-symbol">${icon}</span>
        <span class="notification-copy">
          <span class="notification-title">${esc(item.title)}</span>
          <span class="notification-body">${esc(item.body || "")}</span>
          <span class="notification-time">${esc(notificationDate(item.created_at))}</span>
        </span>
        ${isUnread ? '<span class="notification-unread-dot" aria-label="غير مقروء"></span>' : ""}
      </button>
    `;
  }).join("");
}

async function loadNotifications(options = {}) {
  if (!db || !currentUser) return false;
  const { data, error } = await db.from("notifications")
    .select("id,recipient_id,title,body,category,metadata,created_at,read_at")
    .eq("recipient_id", currentUser.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    console.warn("In-app notifications could not be loaded. Ensure supabase/notifications.sql has been run:", error.message);
    if (!options.quiet) {
      alert("تعذّر تحميل سجل الإشعارات. تأكد من تشغيل ملف supabase/notifications.sql في Supabase SQL Editor.");
    }
    return false;
  }
  notifications = data || [];
  renderNotificationBadge();
  renderNotificationsList();
  return true;
}

window.openNotificationItem = async function(notificationId) {
  const item = notifications.find(notification => String(notification.id) === String(notificationId));
  if (!item) return;
  if (!item.read_at) {
    const { error } = await db.rpc("mark_notification_read", { p_notification_id: notificationId });
    if (error) {
      console.warn("Could not mark notification as read:", error.message);
    } else {
      item.read_at = new Date().toISOString();
      renderNotificationBadge();
      renderNotificationsList();
    }
  }
};

window.showNotificationsDialog = async function() {
  showDialog("notificationsDialog");
  await loadNotifications();
};

async function refreshData() {
  if (!db) return;
  try {
    const goodsRes = await db.from("goods").select("*").order("created_at", { ascending: false });
    const inquiriesRes = await db.from("inquiries").select("*").order("created_at", { ascending: false });

    goods = goodsRes.data || [];
    inquiries = inquiriesRes.data || [];
    await loadNotifications({ quiet: true });

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
              <div class="product-code">${presenceSummary(r)}</div>
            </div>
          </div>
          <div style="text-align: left; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
            ${statusBadge}
            <button type="button" style="background: var(--navy); color: #fff; border: none; padding: 4px 10px; border-radius: 8px; font-size: 11px; font-weight: 700; cursor: pointer;">إدارة ⚙️</button>
            ${r.status === 'approved' ? `<button type="button" data-test-rep-push="${r.id}" onclick="event.stopPropagation(); testRepPushNotification('${r.id}')" style="background: var(--green); color: #fff; border: none; padding: 4px 8px; border-radius: 8px; font-size: 10px; font-weight: 700; cursor: pointer;">🔔 اختبار إشعار</button>` : ''}
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
    const totalCommission = sales.reduce((sum, sale) => sum + (Number(sale.total_commission) || 0), 0);
    const totalManagerShare = sales.reduce((sum, sale) => sum + (Number(sale.manager_share) || 0), 0);
    const totalRepShare = sales.reduce((sum, sale) => sum + (Number(sale.rep_share) || 0), 0);

    $("salesList").innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:12px;">
        <div style="background:#F1F5F9;border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;">
          <div style="font-size:12px;color:var(--text-muted);">إجمالي العمولات المسجلة</div>
          <div style="font-size:16px;font-weight:900;color:var(--navy);">${money(totalCommission)}</div>
        </div>
        <div style="background:#F1F5F9;border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;">
          <div style="font-size:12px;color:var(--text-muted);">حصة الإدارة المسجلة</div>
          <div style="font-size:16px;font-weight:900;color:var(--navy);">${money(totalManagerShare)}</div>
        </div>
        <div style="background:#F1F5F9;border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;grid-column:1/-1;">
          <div style="font-size:12px;color:var(--text-muted);">مجموع حصص المندوبين المسجلة</div>
          <div style="font-size:16px;font-weight:900;color:var(--navy);">${money(totalRepShare)}</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin:0 0 10px;">هذه مبالغ محسوبة من سجلات البيعات، وليست دليلاً على أن المبالغ تم استلامها أو دفعها.</div>
    ` + sales.map(sale => {
      const g = goods.find(item => String(item.id) === String(sale.goods_id));
      const rep = reps.find(item => String(item.id) === String(sale.rep_id));
      const saleDate = sale.created_at && !Number.isNaN(new Date(sale.created_at).getTime())
        ? new Date(sale.created_at).toLocaleDateString("ar-IQ")
        : "التاريخ غير متوفر";
      return `
        <div class="product-card" style="display:block;padding:12px;margin-bottom:10px;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
            <div style="display:flex;align-items:center;gap:10px;min-width:0;">
              <div class="product-img" style="background:var(--green-bg);color:var(--green);flex-shrink:0;">💳</div>
              <div class="product-info" style="min-width:0;">
                <div class="product-title">${esc(g?.title || 'غرض غير متوفر')}</div>
                <div class="product-code">المندوب: ${esc(rep?.full_name || 'مندوب غير معروف')}</div>
                <div class="product-code">تاريخ التسجيل: ${esc(saleDate)}</div>
              </div>
            </div>
            <div style="text-align:left;flex-shrink:0;">
              <div class="product-price">${money(sale.final_price)}</div>
              <div class="product-code">سعر البيع</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border);">
            <div><div class="product-code">إجمالي العمولة</div><strong>${money(sale.total_commission)}</strong></div>
            <div><div class="product-code">حصة الإدارة</div><strong>${money(sale.manager_share)}</strong></div>
            <div style="grid-column:1/-1;"><div class="product-code">حصة المندوب</div><strong>${money(sale.rep_share)}</strong></div>
          </div>
        </div>
      `;
    }).join("");
  }
  if ($("emptySales")) $("emptySales").classList.toggle("hidden", sales.length > 0);
  renderNotificationBadge();
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
    if (["ban", "restrict", "unban", "promote"].includes(action)) {
      void sendPushEvent("rep_status", {
        targetUserId: activeManageRepId,
        statusAction: action
      });
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
    if (data?.user) {
      await startApp(data.user);
      if (currentUser?.id === data.user.id && profile) void sendPushEvent("user_login");
    }
  } catch (err) {
    alert("خطأ في تسجيل الدخول: " + err.message);
  }
};

window.handleSignup = async function() {
  const nameInput = $("signupName");
  const emailInput = $("signupEmail");
  const passwordInput = $("signupPassword");
  const fullName = nameInput?.value?.trim();
  const email = emailInput?.value?.trim().toLowerCase();
  const password = passwordInput?.value || "";
  const button = document.querySelector('#signupForm button[onclick="handleSignup()"]');

  if (!fullName || !email || !password) {
    return alert("يرجى إدخال الاسم والبريد الإلكتروني وكلمة المرور.");
  }
  if (fullName.length < 2) {
    nameInput?.focus();
    return alert("يرجى كتابة الاسم الكامل بشكل صحيح.");
  }
  // Normalize the visible field too, so Safari does not validate stale whitespace.
  if (emailInput) emailInput.value = email;
  if (emailInput && !emailInput.checkValidity()) {
    emailInput.focus();
    return alert("صيغة البريد الإلكتروني غير صحيحة. تأكد من كتابته مثل name@example.com بدون مسافات.");
  }
  if (password.length < 6) {
    passwordInput?.focus();
    return alert("كلمة المرور لازم تكون 6 أحرف أو أكثر.");
  }
  if (!db) return alert("تعذّر الاتصال بالخدمة حالياً. حدّث الصفحة وحاول مرة ثانية.");

  if (button) {
    button.disabled = true;
    button.textContent = "جارٍ إرسال الطلب…";
  }

  try {
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, role: "rep" } }
    });

    if (error) {
      const message = String(error.message || "").toLowerCase();
      if (
        message.includes("already registered") ||
        message.includes("already exists") ||
        message.includes("user exists") ||
        message.includes("email address is already") ||
        message.includes("duplicate")
      ) {
        if ($("loginEmail")) $("loginEmail").value = email;
        switchAuthMode("login");
        alert("هذا البريد الإلكتروني مسجّل من قبل. رجّعناك لتسجيل الدخول؛ لا تعيد طلب الانضمام بنفس البريد. إذا ناسي كلمة المرور، استخدم خيار استعادة كلمة المرور إن كان متاحاً أو تواصل مع المدير.");
        return;
      }
      throw error;
    }

    if (!data?.user) {
      throw new Error("لم تؤكد خدمة تسجيل الدخول إنشاء الحساب. حاول مرة ثانية.");
    }

    // Supabase may hide an existing account during sign-up to prevent email enumeration.
    // An empty identities array is the signal not to overwrite that user's existing profile.
    if (Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      if ($("loginEmail")) $("loginEmail").value = email;
      switchAuthMode("login");
      alert("يبدو أن هذا البريد الإلكتروني مسجّل من قبل. رجّعناك لتسجيل الدخول، ولم نغيّر بيانات أي حساب موجود.");
      return;
    }

    const repCode = "REP-" + Math.floor(1000 + Math.random() * 9000);
    const { error: profileError } = await db.from("profiles").upsert({
      id: data.user.id,
      full_name: fullName,
      role: "rep",
      rep_code: repCode,
      status: "pending",
      permissions: { can_add_inquiry: true }
    }, { onConflict: "id" });

    if (profileError) {
      console.error("Signup profile save failed:", profileError);
      throw new Error("تم إنشاء حساب الدخول لكن تعذّر حفظ طلب المندوب. أرسل للمدير هذه الرسالة: " + profileError.message);
    }

    // Notify administrators after the pending profile is saved without delaying the signup confirmation.
    void sendPushEvent("new_rep").then(pushResult => {
      if (!pushResult?.ok) {
        console.warn("New rep was saved, but admin push notification failed:", pushResult?.error || pushResult);
      }
    });

    alert("تم إرسال طلب الانضمام بنجاح! طلبك بانتظار موافقة المدير.");
    if ($("signupName")) $("signupName").value = "";
    if ($("signupEmail")) $("signupEmail").value = "";
    if ($("signupPassword")) $("signupPassword").value = "";
    switchAuthMode("login");
    if ($("loginEmail")) $("loginEmail").value = email;
  } catch (err) {
    console.error("Signup failed:", err);
    alert("تعذّر إرسال طلب الانضمام: " + (err.message || "خطأ غير معروف"));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "إرسال طلب الانضمام";
    }
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
  if (!form || !form.reportValidity()) return;
  const formData = new FormData(form);
  const goodsId = formData.get("goodsId");
  const repId = formData.get("repId");
  const finalPrice = Number(formData.get("price"));
  const commission = Number(formData.get("commission"));
  const selectedGood = goods.find(item => String(item.id) === String(goodsId));
  const selectedRep = reps.find(item => String(item.id) === String(repId));

  if (!selectedGood || selectedGood.status !== "available") {
    return alert("هذا الغرض غير متوفر حالياً. حدّث القائمة وتأكد من حالة الغرض.");
  }
  if (!selectedRep || !["approved", "restricted"].includes(selectedRep.status)) {
    return alert("اختر مندوباً نشطاً مسجلاً في النظام.");
  }
  if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
    return alert("أدخل سعر بيع صحيحاً أكبر من صفر.");
  }
  if (!Number.isFinite(commission) || commission < 0) {
    return alert("أدخل عمولة صحيحة لا تقل عن صفر.");
  }

  try {
    const managerShare = Math.floor(commission / 2);

    const { data: savedSale, error } = await db.from("sales").insert({
      goods_id: goodsId,
      rep_id: repId,
      final_price: finalPrice,
      total_commission: commission,
      manager_share: managerShare,
      rep_share: commission - managerShare,
      verified_by: currentUser.id
    }).select("id").single();

    if (error) throw error;

    const { error: goodsUpdateError } = await db.from("goods").update({ status: 'sold' }).eq("id", goodsId);
    if (goodsUpdateError) {
      console.error("Sale saved but the good status could not be updated:", goodsUpdateError.message);
      alert("تم تسجيل البيعة، لكن تعذّر تحديث حالة الغرض إلى مباع. راجع الغرض من قائمة الأغراض.");
    }
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
    void sendPushEvent("rep_status", { targetUserId: repId, statusAction: "approve" });
    alert("تم قبول المندوب بنجاح");
  } catch (err) {
    alert("تعذّر القبول: " + err.message);
  }
};

window.handleLogout = async function() {
  stopPresenceTracking();
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
