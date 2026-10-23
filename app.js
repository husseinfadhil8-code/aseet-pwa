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
let teamActivity = [];
let pendingReps = [];
let nameChangeRequests = [];
let selectedRole = 'admin';
let activeManageRepId = null;
let editingGoodsId = null;
let presenceTimer = null;
let repStatusCheckTimer = null;
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

async function checkRepresentativeAccess() {
  if (!currentUser || profile?.role !== "rep" || !db) return;
  try {
    const { data, error } = await db.from("profiles").select("status,role").eq("id", currentUser.id).maybeSingle();
    if (error) {
      console.warn("Could not verify representative access:", error.message);
      return;
    }
    if (!data || data.role !== "rep" || data.status === "removed" || data.status === "banned") {
      if (repStatusCheckTimer) clearInterval(repStatusCheckTimer);
      repStatusCheckTimer = null;
      stopPresenceTracking();
      await db.auth.signOut();
      currentUser = null;
      profile = null;
      $("appView")?.classList.add("hidden");
      $("welcomeView")?.style.setProperty("display", "flex");
      alert(data?.status === "banned" ? "تم حظر حسابك من قبل الإدارة، وتم تسجيل خروجك." : "تم إخراج حسابك من قائمة المندوبين، وتم تسجيل خروجك.");
    }
  } catch (err) {
    console.warn("Representative access check failed:", err);
  }
}

function startRepStatusMonitoring() {
  if (repStatusCheckTimer) clearInterval(repStatusCheckTimer);
  repStatusCheckTimer = null;
  if (profile?.role !== "rep") return;
  repStatusCheckTimer = setInterval(() => {
    if (document.visibilityState === "visible") void checkRepresentativeAccess();
  }, 10000);
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
  document.querySelectorAll(".rep-only").forEach(el => {
    el.classList.toggle("hidden", profile?.role !== "rep");
  });

  if (!isAdmin() && profile?.status === 'restricted') {
    const permissions = profile?.permissions || {};
    if (permissions.can_add_inquiry === false) {
      $("addInquiryFab")?.classList.add("hidden");
    }
  }

  window.switchTab('home');
  if (typeof window.initChatFeature === 'function') void window.initChatFeature();
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
  if (tabName === "myCommissions") void refreshData();
  if (tabName === "teamActivity") void loadTeamActivity();
  if (tabName === "chat" && typeof window.initChatFeature === "function") void window.initChatFeature();
  window.scrollTo(0, 0);
};

function renderAccountView() {
  const name = profile?.full_name || currentUser?.email || "حساب المستخدم";
  if ($("accountName")) $("accountName").textContent = name;
  if ($("accountAvatar")) {
    const avatar = $("accountAvatar");
    if (profile?.avatar_url) avatar.innerHTML = '<img src="' + esc(profile.avatar_url) + '" alt="الصورة الشخصية" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">';
    else avatar.textContent = String(name).trim().charAt(0) || "م";
  }
  if ($("accountEmail")) $("accountEmail").textContent = currentUser?.email || "غير متوفر";
  if ($("accountRole")) $("accountRole").textContent = profile?.role === "admin" ? "مدير وسيط" : (profile?.status === "restricted" ? "مندوب مقيّد" : "مندوب وسيط");

  const usernameSettings = $("usernameSettings");
  if (usernameSettings) {
    if (profile?.role !== "rep") {
      usernameSettings.classList.add("hidden");
      usernameSettings.innerHTML = "";
    } else {
      usernameSettings.classList.remove("hidden");
      if (profile?.username_locked === false) {
        usernameSettings.innerHTML = `
          <div style="font-weight:900;color:var(--navy);margin-bottom:5px;">اختيار اسم المستخدم النهائي</div>
          <div style="font-size:12px;color:var(--text-muted);line-height:1.8;margin-bottom:9px;">اختر اسمك مرة واحدة فقط؛ بعد الحفظ لا يمكن تغييره.</div>
          <input id="claimUsernameInput" class="form-control" type="text" minlength="3" maxlength="24" pattern="[A-Za-z0-9._]{3,24}" autocapitalize="none" spellcheck="false" autocomplete="username" placeholder="مثال: hussein_92" aria-label="اسم المستخدم الجديد">
          <button id="claimUsernameButton" class="btn-navy" style="margin-top:10px;" onclick="saveUsernameOnce()">حفظ اسم المستخدم نهائياً</button>`;
      } else {
        usernameSettings.innerHTML = `<div style="font-weight:800;color:var(--navy);">اسم المستخدم</div><div style="font-size:16px;font-weight:900;color:var(--navy);direction:ltr;text-align:right;margin-top:5px;">@${esc(profile?.username || "غير محدد")}</div><div style="font-size:11px;color:var(--text-muted);margin-top:5px;">اسم المستخدم ثابت ولا يمكن تغييره.</div>`;
      }
    }
  }

  const nameRequestBox = $("nameChangeRequestBox");
  if (nameRequestBox) {
    if (profile?.role !== "rep") {
      nameRequestBox.classList.add("hidden");
      nameRequestBox.innerHTML = "";
    } else {
      nameRequestBox.classList.remove("hidden");
      const pending = profile?.name_change_request_pending;
      nameRequestBox.innerHTML = `
        <div style="font-weight:900;color:var(--navy);margin-bottom:5px;">طلب تغيير الاسم الظاهر</div>
        <div style="font-size:12px;color:var(--text-muted);line-height:1.8;margin-bottom:9px;">لا يمكنك تغيير اسمك بنفسك. أرسل طلباً للمدير، وسيتم التغيير فقط بعد موافقته.</div>
        ${pending ? '<div style="color:#92400e;font-weight:800;font-size:13px;">⏳ لديك طلب قيد المراجعة</div>' : '<input id="requestedFullName" class="form-control" type="text" minlength="2" maxlength="80" placeholder="الاسم الجديد المطلوب"><button type="button" id="requestNameButton" class="btn-navy" style="margin-top:9px;" onclick="requestNameChange()">إرسال طلب للمدير</button>'}
      `;
    }
  }
}

window.requestNameChange = async function() {
  if (!currentUser || profile?.role !== "rep") return alert("هذه الميزة للمندوبين فقط.");
  const input = $("requestedFullName");
  const requestedName = String(input?.value || "").trim();
  if (requestedName.length < 2 || requestedName.length > 80) {
    input?.focus();
    return alert("اكتب الاسم الجديد بشكل صحيح (من حرفين إلى 80 حرفاً).");
  }
  const button = $("requestNameButton");
  if (button) { button.disabled = true; button.textContent = "جارٍ إرسال الطلب…"; }
  try {
    const { error } = await db.rpc("request_my_name_change", { p_requested_name: requestedName });
    if (error) throw error;
    profile.name_change_request_pending = true;
    renderAccountView();
    void refreshData();
    alert("تم إرسال طلب تغيير الاسم إلى المدير. سيبقى اسمك الحالي حتى يوافق المدير.");
  } catch (err) {
    alert("تعذّر إرسال الطلب: " + (err.message || "حاول مرة أخرى."));
    if (button) { button.disabled = false; button.textContent = "إرسال طلب للمدير"; }
  }
};

window.reviewNameChangeRequest = async function(requestId, approve) {
  if (!isAdmin()) return alert("هذه العملية متاحة للمدير فقط.");
  const request = nameChangeRequests.find(r => String(r.id) === String(requestId));
  if (!request) return alert("لم يتم العثور على الطلب. حدّث القائمة.");
  if (!confirm(approve ? `هل توافق على تغيير اسم المندوب إلى «${request.requested_name}»؟` : `هل تريد رفض طلب تغيير الاسم «${request.requested_name}»؟`)) return;
  try {
    const { error } = await db.rpc("review_name_change_request", { p_request_id: requestId, p_approve: Boolean(approve) });
    if (error) throw error;
    await refreshData();
    alert(approve ? "تمت الموافقة وتحديث اسم المندوب." : "تم رفض الطلب.");
  } catch (err) {
    alert("تعذّرت معالجة الطلب: " + (err.message || "حاول مرة أخرى."));
  }
};

window.uploadProfilePhoto = async function() {
  const input = $("profilePhotoInput");
  const file = input?.files?.[0];
  if (!file || !currentUser || !db) return;
  if (!file.type.startsWith("image/")) { input.value = ""; return alert("اختر ملف صورة فقط."); }
  if (file.size > 8 * 1024 * 1024) { input.value = ""; return alert("حجم الصورة يجب أن يكون أقل من 8 ميغابايت."); }
  try {
    const image = await new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(objectUrl); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("تعذّر قراءة الصورة.")); };
      img.src = objectUrl;
    });
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 512 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) throw new Error("تعذّر تجهيز الصورة.");
    const path = currentUser.id + "/avatar.jpg";
    const { error: uploadError } = await db.storage.from("profile-avatars").upload(path, blob, { contentType: "image/jpeg", upsert: true, cacheControl: "3600" });
    if (uploadError) throw uploadError;
    const { data: publicData } = db.storage.from("profile-avatars").getPublicUrl(path);
    const avatarUrl = publicData.publicUrl + "?v=" + Date.now();
    const { error: saveError } = await db.rpc("set_my_avatar_url", { p_avatar_url: avatarUrl });
    if (saveError) throw saveError;
    await loadProfile();
    renderAccountView();
    alert("تم تحديث صورتك الشخصية.");
  } catch (err) {
    console.error("Profile photo upload failed:", err);
    alert("تعذّر رفع الصورة. تأكد من تشغيل ملف supabase/profile_and_name_requests.sql في Supabase SQL Editor. " + (err.message || ""));
  } finally {
    if (input) input.value = "";
  }
};

window.saveUsernameOnce = async function() {
  if (!currentUser || profile?.role !== "rep") return alert("هذه الميزة للمندوب المسجّل فقط.");
  if (profile?.username_locked !== false) return alert("اسم المستخدم محفوظ نهائياً ولا يمكن تغييره.");
  const input = $("claimUsernameInput");
  const username = String(input?.value || "").trim().toLowerCase();
  if (!/^[a-z0-9._]{3,24}$/.test(username)) {
    input?.focus();
    return alert("اسم المستخدم يجب أن يكون من 3 إلى 24 حرفاً إنجليزياً صغيراً أو رقماً أو نقطة أو شرطة سفلية، بدون مسافات.");
  }
  const button = $("claimUsernameButton");
  if (button) { button.disabled = true; button.textContent = "جارٍ حفظ الاسم…"; }
  try {
    const { error } = await db.rpc("set_my_username_once", { p_username: username });
    if (error) {
      if (error.code === "23505" || /duplicate|unique/i.test(error.message || "")) {
        throw new Error("اسم المستخدم مستخدم مسبقاً. اختر اسماً آخر.");
      }
      throw error;
    }
    await loadProfile();
    renderAccountView();
    alert("تم حفظ اسم المستخدم نهائياً. لن تتمكن من تغييره لاحقاً.");
  } catch (err) {
    alert("تعذّر حفظ اسم المستخدم: " + (err.message || "حاول مرة أخرى."));
    if (button) { button.disabled = false; button.textContent = "حفظ اسم المستخدم نهائياً"; }
  }
};

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

    if (profile?.status === 'banned' || profile?.status === 'removed') {
      alert(profile.status === 'removed' ? "تم إخراج حسابك من قائمة المندوبين بواسطة الإدارة. تم تسجيل خروجك." : "عذراً، تم حظر هذا الحساب من قبل الإدارة ولا يمكنه استخدام التطبيق.");
      await db.auth.signOut();
      currentUser = null;
      profile = null;
      $("appView")?.classList.add("hidden");
      $("welcomeView")?.style.setProperty("display", "flex");
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
    startRepStatusMonitoring();
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
async function loadTeamActivity() {
  const list = $("teamActivityList");
  const empty = $("teamActivityEmpty");
  if (!db || !currentUser || !list) return;
  list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">جارٍ تحميل نشاط الفريق…</div>';
  const { data, error } = await db.from("notifications")
    .select("id,title,body,category,created_at")
    .eq("recipient_id", currentUser.id)
    .eq("category", "sale")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    console.warn("Team activity could not be loaded:", error.message);
    list.innerHTML = '<div style="padding:14px;color:#b91c1c;">تعذّر تحميل نشاط الفريق. تأكد من تطبيق تحديث قاعدة البيانات الخاص بنشاط الفريق.</div>';
    if (empty) empty.classList.add("hidden");
    return;
  }
  teamActivity = data || [];
  if (!teamActivity.length) {
    list.innerHTML = "";
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");
  list.innerHTML = teamActivity.map(item => {
    const isPayout = /تحويل|مستحقات|عمولة/i.test(String(item.title || "") + " " + String(item.body || ""));
    return '<article class="notification-card" style="cursor:default;">' +
      '<span class="notification-symbol">' + (isPayout ? '💰' : '🛍️') + '</span>' +
      '<span class="notification-copy"><span class="notification-title">' + esc(item.title) + '</span>' +
      '<span class="notification-body">' + esc(item.body || "") + '</span>' +
      '<span class="notification-time">' + esc(notificationDate(item.created_at)) + '</span></span></article>';
  }).join("");
}
window.refreshTeamActivity = function() { void loadTeamActivity(); };


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
      const requestsRes = await db.rpc("get_name_change_requests");
      nameChangeRequests = requestsRes.data || [];
      if (requestsRes.error) console.warn("Name-change requests could not be loaded:", requestsRes.error.message);

      const allReps = repsRes.data || [];
      reps = allReps.filter(r => r.status === 'approved' || r.status === 'restricted' || r.status === 'banned');
      pendingReps = allReps.filter(r => r.status === 'pending');
      sales = salesRes.data || [];
    } else if (profile?.role === "rep") {
      const ownRequestRes = await db.rpc("has_pending_name_change_request");
      profile.name_change_request_pending = ownRequestRes.data === true;
      if (ownRequestRes.error) console.warn("Could not check pending name request:", ownRequestRes.error.message);
      // Each representative only requests their own sales; RLS must enforce the same rule in Supabase.
      const mySalesRes = await db.from("sales").select("*").eq("rep_id", currentUser.id).order("created_at", { ascending: false });
      sales = mySalesRes.data || [];
      if (mySalesRes.error) console.warn("Representative sales could not be loaded:", mySalesRes.error.message);
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
    const availableGoods = goods.filter(g => g.status === "available");
    $("goodsList").innerHTML = availableGoods.map(g => `
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
            ${g.status === 'available' ? 'متوفر' : g.status === 'sold' ? 'مبيوع' : 'غير متوفر'}
          </span>
        </div>
        ${isAdmin() ? `
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--border);width:100%;">
            ${g.status === 'available' ? `<button type="button" onclick="event.stopPropagation(); shareSingleGoodOnWhatsApp('${g.id}')" style="flex:1;min-width:120px;background:#128C7E;color:#fff;border:0;border-radius:8px;padding:9px 10px;font-size:13px;font-weight:700;">🟢 مشاركة هذا الغرض</button><button type="button" onclick="event.stopPropagation(); prepareSaleDialog('${g.id}')" style="flex:1;min-width:120px;background:var(--green);color:#fff;border:0;border-radius:8px;padding:9px 10px;font-size:13px;font-weight:700;">✓ تم بيع الغرض</button>` : ''}
            <button type="button" onclick="event.stopPropagation(); editGoods('${g.id}')" style="flex:1;min-width:100px;background:var(--navy);color:var(--gold);border:0;border-radius:8px;padding:9px 10px;font-size:13px;font-weight:700;">✏️ تعديل الغرض</button>
            <button type="button" onclick="event.stopPropagation(); deleteGoods('${g.id}')" style="flex:1;min-width:100px;background:#FEE2E2;color:#B91C1C;border:0;border-radius:8px;padding:9px 10px;font-size:13px;font-weight:700;">🗑️ حذف الغرض</button>
          </div>` : ''}
      </div>
    `).join("");
  }
  if ($("emptyGoods")) $("emptyGoods").classList.toggle("hidden", goods.some(g => g.status === "available"));

  if ($("repsList")) {
    let html = reps.map(r => {
      let statusBadge = '<span class="status-pill pill-green">نشط</span>';
      if (r.status === 'banned') statusBadge = '<span class="status-pill pill-red">محظور</span>';
      else if (r.status === 'restricted') statusBadge = '<span class="status-pill pill-orange">مقيّد</span>';

      const repSales = sales.filter(sale => String(sale.rep_id) === String(r.id));
      const repEarned = repSales.reduce((sum, sale) => sum + (Number(sale.rep_share) || 0), 0);
      const repPaid = repSales.filter(sale => Boolean(sale.commission_paid_at))
        .reduce((sum, sale) => sum + (Number(sale.rep_share) || 0), 0);
      const repDue = Math.max(0, repEarned - repPaid);

      return `
        <div class="product-card" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center;" onclick="openRepManage('${r.id}', '${esc(r.full_name)}', '${r.status}')">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div class="product-img" style="background: var(--blue-bg); color: var(--blue);">👤</div>
            <div class="product-info">
              <div class="product-title">${esc(r.full_name || 'مندوب')}</div>
              <div class="product-code">اسم المستخدم: @${esc(r.username || 'غير محدد')}</div>
              <div class="product-code">رمز المندوب: ${esc(r.rep_code || '—')}</div>
              <div style="font-size:12px;line-height:1.8;margin-top:5px;padding:7px;background:#F8FAFC;border-radius:8px;">
                <div>إجمالي عمولاته: <strong>${money(repEarned)}</strong></div>
                <div>المستحق غير المحوّل: <strong style="color:#92400E;">${money(repDue)}</strong></div>
                <div>المحوّل له: <strong style="color:#047857;">${money(repPaid)}</strong></div>
              </div>
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
              <div class="product-code">اسم المستخدم: @${esc(r.username || 'غير محدد')}</div>
              <div class="product-code">طلب انضمام جديد</div>
            </div>
            <div style="display: flex; gap: 4px;">
              <button onclick="approveRep('${r.id}')" style="background: var(--green); color: #fff; border: none; padding: 6px 12px; border-radius: 8px; font-weight: 700; cursor: pointer;">قبول</button>
            </div>
          </div>
        `).join("") + html;
    }

    if (nameChangeRequests.length) {
      html = `<section style="margin-bottom:14px;"><div style="font-weight:900;color:var(--navy);margin:10px 0;">طلبات تغيير أسماء المندوبين</div>` +
        nameChangeRequests.map(req => `
          <div class="product-card" style="border-color:var(--gold);display:block;">
            <div style="font-weight:900;">${esc(req.current_name || "مندوب")} (@${esc(req.username || "—")})</div>
            <div style="font-size:13px;margin:7px 0;">الاسم المطلوب: <strong>${esc(req.requested_name)}</strong></div>
            <div style="display:flex;gap:8px;"><button type="button" class="btn-navy" style="flex:1;background:var(--green);color:#fff;" onclick="reviewNameChangeRequest('${req.id}',true)">موافقة</button><button type="button" class="btn-navy" style="flex:1;background:#b91c1c;color:#fff;" onclick="reviewNameChangeRequest('${req.id}',false)">رفض</button></div>
          </div>`).join("") + `</section>` + html;
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
    const paidRepCommission = sales.filter(sale => sale.commission_paid_at)
      .reduce((sum, sale) => sum + (Number(sale.rep_share) || 0), 0);
    const dueRepCommission = sales.filter(sale => !sale.commission_paid_at)
      .reduce((sum, sale) => sum + (Number(sale.rep_share) || 0), 0);

    $("salesList").innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:12px;">
        <div style="background:#F1F5F9;border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;">
          <div style="font-size:12px;color:var(--text-muted);">إجمالي العمولات</div>
          <div style="font-size:16px;font-weight:900;color:var(--navy);">${money(totalCommission)}</div>
        </div>
        <div style="background:#FFF7D6;border:1px solid #F1D56A;border-radius:10px;padding:10px;text-align:center;">
          <div style="font-size:12px;color:var(--text-muted);">مستحقات غير محوّلة</div>
          <div style="font-size:16px;font-weight:900;color:#92400E;">${money(dueRepCommission)}</div>
        </div>
        <div style="background:#D1FAE5;border:1px solid #A7F3D0;border-radius:10px;padding:10px;text-align:center;">
          <div style="font-size:12px;color:var(--text-muted);">عمولات تم تحويلها</div>
          <div style="font-size:16px;font-weight:900;color:#047857;">${money(paidRepCommission)}</div>
        </div>
        <div style="background:#F1F5F9;border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;">
          <div style="font-size:12px;color:var(--text-muted);">حصة الإدارة المسجلة سابقاً</div>
          <div style="font-size:16px;font-weight:900;color:var(--navy);">${money(totalManagerShare)}</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin:0 0 10px;">تُعد العمولة مستحقة حتى يؤكد المدير التحويل. البيعات القديمة التي لم يسجّل لها تاريخ تحويل ستظهر كمستحقات غير محوّلة.</div>
    ` + sales.map(sale => {
      const g = goods.find(item => String(item.id) === String(sale.goods_id));
      const rep = reps.find(item => String(item.id) === String(sale.rep_id));
      const saleDate = sale.created_at && !Number.isNaN(new Date(sale.created_at).getTime())
        ? new Date(sale.created_at).toLocaleDateString("ar-IQ")
        : "التاريخ غير متوفر";
      const paid = Boolean(sale.commission_paid_at);
      const paidDate = paid && !Number.isNaN(new Date(sale.commission_paid_at).getTime())
        ? new Date(sale.commission_paid_at).toLocaleString("ar-IQ")
        : "";
      return `
        <div class="product-card" style="display:block;padding:12px;margin-bottom:10px;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
            <div style="display:flex;align-items:center;gap:10px;min-width:0;">
              <div class="product-img" style="background:var(--green-bg);color:var(--green);flex-shrink:0;">💳</div>
              <div class="product-info" style="min-width:0;">
                <div class="product-title">${esc(g?.title || 'غرض غير متوفر')}</div>
                <div class="product-code">المندوب: ${esc(rep?.full_name || 'مندوب غير معروف')} (@${esc(rep?.username || 'بدون اسم مستخدم')})</div>
                <div class="product-code">تاريخ البيع: ${esc(saleDate)}</div>
              </div>
            </div>
            <div style="text-align:left;flex-shrink:0;">
              <div class="product-price">${money(sale.final_price)}</div>
              <div class="product-code">سعر البيع</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border);">
            <div><div class="product-code">إجمالي العمولة</div><strong>${money(sale.total_commission)}</strong></div>
            <div><div class="product-code">حصة المندوب المستحقة</div><strong>${money(sale.rep_share)}</strong></div>
            <div><div class="product-code">حصة الإدارة</div><strong>${money(sale.manager_share)}</strong></div>
            <div><div class="product-code">حالة مستحقات المندوب</div><span class="status-pill ${paid ? 'pill-green' : 'pill-orange'}">${paid ? 'تم إرسال المستحقات' : 'بانتظار التحويل'}</span></div>
            ${paid ? `<div style="grid-column:1/-1;background:#ECFDF5;padding:9px;border-radius:9px;"><div class="product-code">تاريخ تحويل العمولة</div><strong>${esc(paidDate)}</strong></div>` : `<div style="grid-column:1/-1;"><button type="button" class="btn-navy" style="background:var(--green);color:#fff;" onclick="markSaleCommissionPaid('${esc(sale.id)}')">✓ تأكيد تحويل عمولة المندوب</button></div>`}
          </div>
        </div>
      `;
    }).join("");
  }
  if ($("emptySales")) $("emptySales").classList.toggle("hidden", sales.length > 0);

  if ($("myCommissionSummary")) {
    const myTotal = sales.reduce((sum, sale) => sum + (Number(sale.rep_share) || 0), 0);
    const myPaid = sales.filter(sale => Boolean(sale.commission_paid_at))
      .reduce((sum, sale) => sum + (Number(sale.rep_share) || 0), 0);
    const myDue = Math.max(0, myTotal - myPaid);
    $("myCommissionSummary").innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-bottom:14px;">
        <div style="background:#F1F5F9;border:1px solid var(--border);border-radius:13px;padding:13px;text-align:center;">
          <div style="font-size:12px;color:var(--text-muted);">إجمالي عمولاتي</div>
          <div style="font-size:17px;font-weight:900;color:var(--navy);margin-top:5px;">${money(myTotal)}</div>
        </div>
        <div style="background:#FFF7D6;border:1px solid #F1D56A;border-radius:13px;padding:13px;text-align:center;">
          <div style="font-size:12px;color:#92400E;">مستحقاتي غير المستلمة</div>
          <div style="font-size:17px;font-weight:900;color:#92400E;margin-top:5px;">${money(myDue)}</div>
        </div>
        <div style="grid-column:1/-1;background:#D1FAE5;border:1px solid #A7F3D0;border-radius:13px;padding:13px;text-align:center;">
          <div style="font-size:12px;color:#047857;">العمولات المستلمة</div>
          <div style="font-size:19px;font-weight:900;color:#047857;margin-top:5px;">${money(myPaid)}</div>
        </div>
      </div>
    `;
    const list = $("mySalesList");
    if (list) {
      list.innerHTML = sales.map(sale => {
        const good = goods.find(item => String(item.id) === String(sale.goods_id));
        const paid = Boolean(sale.commission_paid_at);
        const saleDate = sale.created_at && !Number.isNaN(new Date(sale.created_at).getTime())
          ? new Date(sale.created_at).toLocaleString("ar-IQ") : "التاريخ غير متوفر";
        const paidDate = paid && !Number.isNaN(new Date(sale.commission_paid_at).getTime())
          ? new Date(sale.commission_paid_at).toLocaleString("ar-IQ") : "";
        return `
          <div class="product-card" style="display:block;padding:13px;margin-bottom:10px;">
            <div style="display:flex;align-items:flex-start;gap:10px;">
              <div class="product-img" style="background:var(--green-bg);color:var(--green);flex-shrink:0;">💳</div>
              <div style="flex:1;min-width:0;">
                <div class="product-title">${esc(good?.title || "غرض غير متوفر")}</div>
                <div class="product-code">اسم المستخدم: @${esc(profile?.username || currentUser?.id?.slice(0, 8) || '—')}</div>
                <div class="product-code">تاريخ البيع: ${esc(saleDate)}</div>
                <div class="product-price" style="margin-top:6px;">سعر البيع: ${money(sale.final_price)}</div>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border);">
              <div><div class="product-code">إجمالي عمولة البيع</div><strong>${money(sale.total_commission)}</strong></div>
              <div><div class="product-code">عمولتي المستحقة</div><strong style="font-size:16px;">${money(sale.rep_share)}</strong></div>
              <div><div class="product-code">حالة المستحقات</div><span class="status-pill ${paid ? "pill-green" : "pill-orange"}">${paid ? "تم إرسال المستحقات" : "بانتظار التحويل"}</span></div>
              ${paid ? `<div style="grid-column:1/-1;background:#ECFDF5;padding:9px;border-radius:9px;"><div class="product-code">تاريخ استلام العمولة المسجل</div><strong>${esc(paidDate)}</strong></div>` : ""}
            </div>
          </div>
        `;
      }).join("");
    }
    if ($("emptyMySales")) $("emptyMySales").classList.toggle("hidden", sales.length > 0);
    if (!sales.length && list) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:22px;background:#fff;border-radius:13px;">ما عندك مبيعات مسجلة لحد الآن.</div>';
    }
  }
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
  } else if (action === 'remove') {
    if (!confirm("تأكيد إخراج هذا المندوب من القائمة؟ سيُسجّل خروجه عند التحقق التالي، وسيختفي من قائمة المندوبين. تبقى سجلات مبيعاته محفوظة.")) return;
    updatePayload = { status: 'removed' };
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
    alert(action === 'remove' ? "تم إخراج المندوب من القائمة. سيتحقق التطبيق من حالة الحساب ويسجّل خروجه خلال ثوانٍ، وتبقى سجلاته محفوظة." : "تم تنفيذ الإجراء بنجاح وتسجيل السبب.");
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
  const usernameInput = $("signupUsername");
  const emailInput = $("signupEmail");
  const passwordInput = $("signupPassword");
  const fullName = nameInput?.value?.trim();
  const username = String(usernameInput?.value || "").trim().toLowerCase();
  const email = emailInput?.value?.trim().toLowerCase();
  const password = passwordInput?.value || "";
  const button = document.querySelector('#signupForm button[onclick="handleSignup()"]');

  if (!fullName || !username || !email || !password) {
    return alert("يرجى إدخال الاسم الكامل واسم المستخدم والبريد الإلكتروني وكلمة المرور.");
  }
  if (!/^[a-z0-9._]{3,24}$/.test(username)) {
    usernameInput?.focus();
    return alert("اسم المستخدم يجب أن يكون من 3 إلى 24 حرفاً إنجليزياً صغيراً أو رقماً أو نقطة أو شرطة سفلية، بدون مسافات.");
  }
  if (usernameInput) usernameInput.value = username;
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
    // Check username before creating the auth account; the unique index is the final safeguard.
    const { data: usernameAvailable, error: usernameCheckError } = await db.rpc("is_username_available", {
      p_username: username
    });
    if (usernameCheckError) {
      throw new Error("تعذّر التحقق من اسم المستخدم. شغّل ملف supabase/unique_usernames.sql في Supabase SQL Editor ثم حاول مجدداً.");
    }
    if (usernameAvailable !== true) {
      usernameInput?.focus();
      throw new Error("اسم المستخدم مستخدم مسبقاً. اختَر اسماً آخر.");
    }

    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, username, role: "rep" } }
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
      username,
      username_locked: true,
      role: "rep",
      rep_code: repCode,
      status: "pending",
      permissions: { can_add_inquiry: true }
    }, { onConflict: "id" });

    if (profileError) {
      console.error("Signup profile save failed:", profileError);
      if (profileError.code === "23505" || /duplicate|unique/i.test(profileError.message || "")) {
        throw new Error("اسم المستخدم اختاره شخص آخر للتو. لا تكرر التسجيل بالبريد نفسه؛ تواصل مع المدير إذا أُنشئ حساب الدخول لكن لم يظهر طلب المندوب.");
      }
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
    if ($("signupUsername")) $("signupUsername").value = "";
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

window.prepareSaleDialog = function(preselectedGoodsId = null) {
  const goodsSel = $("saleGoods");
  const repSel = $("saleRep");
  if (!goodsSel || !repSel) return;

  goodsSel.innerHTML = goods.filter(g => g.status === 'available').map(g => `
    <option value="${g.id}">${g.title}</option>
  `).join("");
  if (preselectedGoodsId && goods.some(g => String(g.id) === String(preselectedGoodsId) && g.status === "available")) {
    goodsSel.value = String(preselectedGoodsId);
  }

  repSel.innerHTML = reps.filter(r => r.status !== 'banned').map(r => `
    <option value="${r.id}">${esc(r.full_name)} (@${esc(r.username || 'بدون اسم مستخدم')})</option>
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
  const totalCommission = Number(formData.get("totalCommission"));
  const repCommission = Number(formData.get("repCommission"));
  const managerCommission = totalCommission - repCommission;
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
  if (!Number.isFinite(totalCommission) || totalCommission < 0) {
    return alert("أدخل إجمالي عمولة صحيحاً لا يقل عن صفر.");
  }
  if (!Number.isFinite(repCommission) || repCommission < 0 || repCommission > totalCommission) {
    return alert("حصة المندوب يجب أن تكون بين صفر وإجمالي العمولة.");
  }

  try {
    // Save total commission and split it between the representative and the manager.
    const { data: savedSale, error } = await db.from("sales").insert({
      goods_id: goodsId,
      rep_id: repId,
      final_price: finalPrice,
      total_commission: totalCommission,
      manager_share: managerCommission,
      rep_share: repCommission,
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

window.markSaleCommissionPaid = async function(saleId) {
  if (!isAdmin()) return alert("تأكيد تحويل العمولات متاح للمدير فقط.");
  const sale = sales.find(item => String(item.id) === String(saleId));
  if (!sale) return alert("لم يتم العثور على سجل البيع. حدّث القائمة وحاول مجدداً.");
  if (sale.commission_paid_at) return alert("هذه العمولة مسجّلة كمحوّلة مسبقاً.");
  const rep = reps.find(item => String(item.id) === String(sale.rep_id));
  const repName = rep?.full_name || "المندوب";
  const amount = Number(sale.rep_share) || 0;
  if (!confirm(`تأكيد تحويل عمولة ${repName} بمبلغ ${money(amount)}؟\nسيُسجّل تاريخ التحويل ولن يمكن تأكيدها مرة ثانية.`)) return;

  try {
    const { error } = await db.rpc("mark_sale_commission_paid", { p_sale_id: saleId });
    if (error) throw error;
    // Notify the representative after the payout has been recorded successfully.
    void sendPushEvent("commission_paid", { saleId }).then(result => {
      if (!result?.ok) console.warn("Commission was marked paid, but push notification failed:", result?.error || result);
    });
    await refreshData();
    alert("تم تسجيل تحويل العمولة بنجاح.");
  } catch (err) {
    const message = err?.message || "خطأ غير معروف";
    if (/already|paid|previously|not found/i.test(message)) {
      await refreshData();
      return alert("لم يتم تسجيل التحويل: هذه العمولة محوّلة مسبقاً أو أن سجل البيع غير موجود.");
    }
    alert("تعذّر تسجيل تحويل العمولة: " + message + "\nتأكد من تشغيل ملف supabase/commission_payouts.sql في Supabase SQL Editor.");
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
  if (repStatusCheckTimer) clearInterval(repStatusCheckTimer);
  repStatusCheckTimer = null;
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
