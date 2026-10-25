const INITIAL_RECOVERY = new URLSearchParams(location.hash.slice(1)).get('type') === 'recovery';
function releaseCategory(good){return String(good.description||'').split(/\r?\n/).find(line=>line.trim().startsWith('الصنف:'))?.split(':').slice(1).join(':').trim()||'غير مصنف';}
function populateReleasedFilters(){
  const category=$('goodsCategoryFilter');
  if(category){
    const selected=category.value;
    const fixed=[...($('goodsForm')?.elements.category?.options||[])].map(option=>option.value).filter(Boolean);
    const values=[...new Set([...fixed,...goods.map(releaseCategory),...(selected?[selected]:[])])].sort((a,b)=>a.localeCompare(b,'ar'));
    category.replaceChildren(new Option('كل التصنيفات',''),...values.map(value=>new Option(value,value)));
    category.value=selected;
  }
  const areas=$('goodsAreaOptions');
  if(areas)areas.replaceChildren(...[...new Set(goods.map(g=>g.area||'').filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar')).map(value=>new Option(value,value)));
}

function releaseVisibleGoods(){
  if(marketGoods!==null)return marketGoods;
  const query=String($('goodsSearch')?.value||'').trim().toLocaleLowerCase('ar');
  const max=$('goodsMaxPrice')?.value,status=$('goodsStatusFilter')?.value||'available';
  const category=$('goodsCategoryFilter')?.value,area=$('goodsAreaFilter')?.value;
  return goods.filter(g=>(status==='all'||g.status===status) && (!category||releaseCategory(g)===category)
    && (!area||(g.area||'غير محدد').includes(area)) && (!query||[g.title,g.area,g.description].join(' ').toLocaleLowerCase('ar').includes(query))
    && (!max||Number(g.asking_price)<=Number(max)));
}

const SUPABASE_URL = "https://auqxdtbvfonzrlilygjg.supabase.co";
const SUPABASE_KEY = "sb_publishable_-tlztuTYhILnmREw5eBf1A_PXnV1qQ2";

let db = null;
try {
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
} catch (e) {
  console.error("Supabase Init Error:");
}

let currentUser = null;
let accountGeneration=0;
let profile = null;
let goods = [];
let externalListings = [];
let externalListingClaims = [];
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
let goodsSaving = false;
let publicListingSubmitting = false;
let refreshInFlight=null;
const pendingPayments = new Set();
const confirmedSales = new Set();
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
  return profile?.role === "admin" && profile?.status === "approved";
}

let pushRegistration = null;
let pushSubscription = null;
let pushCheckState='unknown';
let pushCheckPromise=null;
let pushCheckGeneration=0;
let pushToggleBusy=false;


function isNewRepAccount() {
  if (profile?.role !== "rep") return false;
  const createdAt = currentUser?.created_at || profile?.created_at;
  if (!createdAt) return false;
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) return false;
  const ageMs = Date.now() - createdMs;
  // Apply the onboarding gate to recently registered representatives, not established accounts.
  return ageMs >= -5 * 60 * 1000 && ageMs <= 30 * 24 * 60 * 60 * 1000;
}

function notificationEnvironment() {
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const supported = ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window);
  return { isIOS, isStandalone, supported };
}

async function showNotificationGate() {
  const actor=currentUser;
  if (!isNewRepAccount()) return;
  if(pushCheckState==='unknown' || pushCheckState==='checking')await initPushNotifications();
  if(currentUser!==actor || !isNewRepAccount() || !['disabled','unsupported'].includes(pushCheckState))return;
  if(pushSubscription && typeof Notification!=='undefined' && Notification.permission==='granted')return;
  const dialog = $("notificationGateDialog");
  if (dialog && !dialog.dataset.gateLockBound) {
    dialog.addEventListener("cancel", () => {});
    dialog.dataset.gateLockBound = "1";
  }
  if (dialog && !dialog.open) {
    try { dialog.showModal(); } catch (_) { dialog.setAttribute("open", ""); }
  }
  refreshNotificationGate();
}

function refreshNotificationGate() {
  const dialog = $("notificationGateDialog");
  if (!dialog || !isNewRepAccount()) {
    if (dialog?.open) dialog.close();
    return;
  }
  const env = notificationEnvironment();
  const status = $("notificationGateStatus");
  const help = $("notificationGateHelp");
  const enable = $("notificationGateEnable");
  const retry = $("notificationGateRetry");
  const bypass = $("notificationGateContinue");
  const ready = Boolean(pushSubscription) && (typeof Notification === "undefined" || Notification.permission === "granted");

  if (ready) {
    if (dialog.open) dialog.close();
    return;
  }
  if (!dialog.open) return;
  if (enable) enable.classList.remove("hidden");
  if (retry) retry.classList.remove("hidden");
  if (bypass) bypass.classList.remove("hidden");

  if (env.isIOS && !env.isStandalone) {
    if (status) status.textContent = "افتح وسيط من أيقونة الشاشة الرئيسية";
    if (help) help.textContent = "على الآيفون، إشعارات وسيط تحتاج إضافة التطبيق إلى الشاشة الرئيسية. افتح Safari، اضغط زر المشاركة، اختر «إضافة إلى الشاشة الرئيسية»، ثم افتح وسيط من الأيقونة وحاول التفعيل. لا يمكن طلب الإذن من تبويب Safari العادي.";
    if (enable) enable.textContent = "📲 طريقة التفعيل";
    if (bypass) bypass.classList.remove("hidden");
    return;
  }
  if (!env.supported) {
    if (status) status.textContent = "هذا المتصفح لا يدعم إشعارات الويب";
    if (help) help.textContent = "يمكنك فتح وسيط من متصفح أو جهاز يدعم إشعارات الويب. حتى لا يتعطل حسابك، يمكنك المتابعة مؤقتاً بدون إشعارات، لكن قد تفوتك تنبيهات الرسائل.";
    if (enable) enable.classList.add("hidden");
    if (bypass) bypass.classList.remove("hidden");
    return;
  }
  if (Notification.permission === "denied") {
    if (status) status.textContent = "إذن الإشعارات مرفوض من الجهاز";
    if (help) help.textContent = "غيّر إذن الإشعارات إلى «سماح» من إعدادات الموقع أو الجهاز، ثم ارجع إلى وسيط واضغط «تحقّق مرة أخرى». قد لا يظهر طلب الإذن مرة ثانية بعد اختيار «عدم السماح».";
    if (enable) enable.textContent = "⚙️ حاول التفعيل";
    if (bypass) bypass.classList.remove("hidden");
    return;
  }
  if (status) status.textContent = "فعّل إشعارات وسيط للمتابعة";
  if (help) help.textContent = "الإشعارات تساعدك على متابعة الرسائل الخاصة ورسائل المجموعة وتحديثات وسيط حتى عندما يكون التطبيق بالخلفية. اضغط تفعيل واسمح بالإشعارات عندما تظهر نافذة الجهاز.";
  if (enable) enable.textContent = "🔔 تفعيل الإشعارات";
}

window.retryNotificationGate = function() {
  refreshNotificationGate();
};

window.continueWithoutPushForNow = function() {
  const dialog = $("notificationGateDialog");
  if (dialog?.open) dialog.close();
  if (profile?.role === "rep") {
    alert("دخلت وسيط بدون تفعيل الإشعارات مؤقتاً. يمكنك تفعيلها لاحقاً من حسابي ← إعدادات الإشعارات.");
  }
};

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
}

function updatePushButton() {
  const button=$("pushNotificationsButton");if(!button)return;
  const enabled=Boolean(pushSubscription) && typeof Notification!=='undefined' && Notification.permission==='granted';
  if(['enabled','disabled'].includes(pushCheckState))pushCheckState=enabled?'enabled':'disabled';
  button.textContent=pushCheckState==='checking'?'جارٍ التحقق من إشعارات الجهاز…':pushCheckState==='unknown'?'التحقق من حالة إشعارات الجهاز':pushCheckState==='error'?'تعذّر التحقق من حفظ الاشتراك — إعادة المحاولة':enabled?'إشعارات الجهاز مفعّلة — إيقافها':'تفعيل إشعارات الجهاز';
  button.setAttribute('aria-pressed',String(enabled));button.setAttribute('aria-busy',String(pushCheckState==='checking'));
  button.disabled=pushCheckState==='checking'||pushToggleBusy;
  button.onclick=()=>['unknown','error'].includes(pushCheckState)?initPushNotifications():togglePushNotifications();
}
async function initPushNotifications() {
  const actor=currentUser;
  if(pushCheckPromise?.actor===actor)return pushCheckPromise.promise;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)){pushCheckState='unsupported';updatePushButton();return;}
  const generation=++pushCheckGeneration,valid=()=>currentUser===actor && generation===pushCheckGeneration;
  pushCheckState='checking';updatePushButton();
  const operation={actor,promise:null};
  operation.promise=(async()=>{
    try{
      const registration=await navigator.serviceWorker.register('./sw.js',{scope:'./'});
      const subscription=await registration.pushManager.getSubscription();if(!valid())return;
      pushRegistration=registration;pushSubscription=subscription;
      pushCheckState=subscription && Notification.permission==='granted'?'enabled':'disabled';
      if(subscription && actor && db){
        const {error}=await db.from('push_subscriptions').upsert({user_id:actor.id,endpoint:subscription.endpoint,subscription:subscription.toJSON(),updated_at:new Date().toISOString()},{onConflict:'endpoint'});
        if(!valid())return;if(error)pushCheckState='error';
      }
      refreshNotificationGate();
    }catch(_){if(valid())pushCheckState='error';}
    finally{if(valid())updatePushButton();}
  })();
  pushCheckPromise=operation;
  try{await operation.promise;}finally{if(pushCheckPromise===operation)pushCheckPromise=null;}
}

async function sendPushEvent(event, payload = {}) {
  try {
    const { data, error } = await db.functions.invoke("push-notifications", {
      body: { event, ...payload }
    });
    if (error) {
      console.warn("Push event was not sent");
      return { ok: false, error: "خدمة الإشعارات غير متاحة حالياً." };
    }
    return data || { ok: true };
  } catch (err) {
    console.warn("Push event unavailable:");
    return { ok: false, error: "خدمة الإشعارات غير متاحة حالياً." };
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
  if (!result?.ok) console.warn("Presence update failed:");
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
  if (!currentUser || !db) return;
  const actor=currentUser;
  try {
    const {data,error}=await db.from('profiles').select('*').eq('id',actor.id).maybeSingle();
    if(currentUser!==actor)return;
    if(error){if(['42501','PGRST301','PGRST302'].includes(error.code))clearAccountState();return;}
    const active=data && ((data.role==='admin' && data.status==='approved') || (data.role==='rep' && ['approved','restricted'].includes(data.status)));
    if(!active){await handleLogout();alert('حسابك غير مفعّل للاستخدام حالياً. تواصل مع الإدارة.');return;}
    const nextProfile={...profile,...data};
    const authorityChanged=JSON.stringify([profile?.role,profile?.status,profile?.permissions||{}])!==JSON.stringify([nextProfile.role,nextProfile.status,nextProfile.permissions||{}]);
    if(authorityChanged){
      // A permission change starts a fresh client authority epoch, even for the same user ID.
      clearAccountState();currentUser={...actor};profile=nextProfile;
      showApp();startPresenceTracking();startRepStatusMonitoring();await refreshData();
    }else profile=nextProfile;
  } catch (_) { /* Keep connection failures separate from a confirmed ban. */ }
}
function startRepStatusMonitoring() {
  if(repStatusCheckTimer)clearInterval(repStatusCheckTimer);
  repStatusCheckTimer=setInterval(()=>{if(document.visibilityState==='visible')void checkRepresentativeAccess();},10000);
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void checkRepresentativeAccess();});

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
      inAppError = "تحقق من الاتصال وصلاحية الحساب وحاول لاحقاً.";
      console.warn("Update announcement could not be saved to in-app notifications:");
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
      alert("تم التعامل مع الإشعار الخارجي، لكن تعذّر حفظ الإعلان داخل سجل التطبيق. تحقق من الاتصال أو تواصل مع المدير.");
    }
  } catch (err) {
    alert("تعذّر إرسال إعلان التحديث. تحقق من الاتصال وحاول لاحقاً.");
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
    alert("تعذّر اختبار إشعار المندوب. تحقق من الاتصال وحاول لاحقاً.");
  } finally {
    if (button) { button.disabled = false; button.textContent = "🔔 اختبار إشعار"; }
  }
};

window.togglePushNotifications = async function(forceEnable=false) {
  if(pushToggleBusy)return;
  if(!currentUser || !db)return alert('سجّل الدخول أولاً.');
  const env=notificationEnvironment();
  if(env.isIOS && !env.isStandalone)return alert('على الآيفون افتح وسيط من أيقونة الشاشة الرئيسية لتفعيل الإشعارات.');
  if(!env.supported)return alert('هذا المتصفح لا يدعم إشعارات الويب.');
  const actor=currentUser,valid=()=>currentUser===actor;
  pushToggleBusy=true;updatePushButton();
  try{
    const permission=await (Notification.permission==='granted'?Promise.resolve('granted'):Notification.requestPermission());
    if(!valid())return;if(permission!=='granted')return alert('لم يتم السماح بالإشعارات. يمكنك مراجعة إذن الموقع في إعدادات الجهاز.');
    const registration=pushRegistration||await navigator.serviceWorker.register('./sw.js',{scope:'./'});
    const existing=await registration.pushManager.getSubscription();if(!valid())return;
    pushRegistration=registration;pushSubscription=existing;
    if(existing && !forceEnable){
      const {error}=await db.from('push_subscriptions').delete().eq('user_id',actor.id).eq('endpoint',existing.endpoint);
      if(error)throw error;if(!valid())return;
      if(!await existing.unsubscribe())throw new Error('UNSUBSCRIBE_FAILED');
      if(!valid())return;pushSubscription=null;pushCheckState='disabled';
      alert('تم إيقاف الإشعارات على هذا الجهاز.');
    }else{
      let subscription=existing;
      if(!subscription){
        const {data,error}=await db.functions.invoke('push-notifications',{body:{action:'get_public_key'}});
        if(error||!data?.publicKey)throw new Error('KEY_UNAVAILABLE');if(!valid())return;
        subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(data.publicKey)});
        if(!valid())return;pushSubscription=subscription;
      }
      const {error}=await db.from('push_subscriptions').upsert({user_id:actor.id,endpoint:subscription.endpoint,subscription:subscription.toJSON(),updated_at:new Date().toISOString()},{onConflict:'endpoint'});
      if(!valid())return;if(error){pushCheckState='error';throw error;}
      pushCheckState='enabled';refreshNotificationGate();alert('إشعارات وسيط مفعّلة لهذا الجهاز.');
    }
  }catch(_){if(valid())alert('تعذّر تحديث اشتراك الإشعارات. أعد التحقق من حسابي؛ لم يُطلب تغيير إذن الجهاز تلقائياً.');}
  finally{pushToggleBusy=false;updatePushButton();}
};

window.toggleGoodShareMenu = function(goodsId, button) {
  const card = button?.closest(".waseet-market-card");
  if (!card) return;
  const menu = card.querySelector(".waseet-share-menu");
  if (!menu) return;
  const willOpen = menu.classList.contains("hidden");
  document.querySelectorAll(".waseet-share-menu").forEach(item => item.classList.add("hidden"));
  document.querySelectorAll(".waseet-share-main").forEach(item => item.setAttribute("aria-expanded","false"));
  if (willOpen) {
    menu.classList.remove("hidden");
    button.setAttribute("aria-expanded","true");
  }
};

window.shareSingleGoodOnWhatsApp = function(goodsId) {
  const good = goods.find(g => String(g.id) === String(goodsId));
  if (!good) return alert("ما لكيت هذا الغرض. حدّث القائمة وحاول مرة ثانية.");
  if (good.status !== "available") return alert("هذا الغرض غير متوفر حالياً.");

  const descriptionLines = String(good.description || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith("صور الغرض:"))
    .filter(line => !/^صور(?: المنتج)?:/i.test(line))
    .filter(line => !isPrivateGoodDetail(line));
  const readDetail = label => {
    const line = descriptionLines.find(item => item.startsWith(label));
    return line ? line.slice(label.length).trim() : "";
  };
  const category = readDetail("الصنف:");
  const condition = readDetail("حالة الغرض:");
  const damage = readDetail("يوجد ضرر أو عطل:");
  const extra = readDetail("تفاصيل إضافية:");
  const knownLabels = ["الصنف:", "حالة الغرض:", "يوجد ضرر أو عطل:", "تفاصيل إضافية:", "التفاوض:"];
  const otherDetails = descriptionLines.filter(line => !knownLabels.some(label => line.startsWith(label)));
  const message = [
    "📣 *غرض للبيع من منصة وسيط*",
    "",
    "🛍️ *اسم المنتج:* " + good.title,
    category ? "🏷️ *الصنف:* " + category : "",
    "💰 *السعر:* " + money(good.asking_price),
    "📍 *المنطقة:* " + (good.area || "غير محدد"),
    condition ? "📦 *الحالة:* " + condition : "",
    damage ? "🛠️ *الأضرار أو الأعطال:* " + damage : "",
    readDetail("التفاوض:") ? "🤝 *التفاوض:* " + readDetail("التفاوض:") : (good.negotiable === true ? "🤝 *التفاوض:* قابل للتفاوض" : (good.negotiable === false ? "🔒 *التفاوض:* السعر نهائي" : "")),
    extra ? "📝 *التفاصيل:* " + extra : "",
    ...otherDetails,
    "",
    "🛒 *تريد تبيع أغراضك؟ اضغط هنا:*",
    "https://is.gd/tJ8tXZ",
    "",
    "📞 *للاستفسار:* 07735952605",
  ].filter(Boolean).join("\n");

  // لا نضيف روابط الصور الطويلة إلى الرسالة؛ تبقى الصور داخل التطبيق.
  window.open("https://wa.me/?text=" + encodeURIComponent(message), "_blank", "noopener,noreferrer");
};
window.shareAvailableGoodsOnWhatsApp = function() {
  if (!isAdmin()) return alert("مشاركة قائمة الأغراض متاحة للمدير فقط.");
  const availableGoods = goods.filter(g => g.status === "available");
  if (!availableGoods.length) return alert("ماكو أغراض متوفرة حالياً لمشاركتها.");

  const lines = availableGoods.slice(0, 15).map((g, index) =>
    `${index + 1}) ${g.title} — السعر: ${money(g.asking_price)} د.ع\n📍 المنطقة: ${g.area || "غير محدد"}`
  );
  const more = availableGoods.length > 15 ? `\n\nوغيرها ${availableGoods.length - 15} أغراض داخل التطبيق.` : "";
  const message = `📣 *أغراض جديدة من وسيط*\n\n${lines.join("\n\n")}${more}\n\nافتح منصة وسيط لمشاهدة القائمة والتواصل:\nhttps://husseinfadhil8-code.github.io/aseet-pwa/\n\n📞 للاستفسار المباشر: 07735952605\n\nيا الله يا رزّاق 🤝`;
  const whatsappUrl = "https://wa.me/?text=" + encodeURIComponent(message);
  window.open(whatsappUrl, "_blank", "noopener,noreferrer");
};

window.selectRole = function(role) {
  selectedRole = role;
  $("roleAdmin")?.classList.toggle("active", role === 'admin');
  $("roleRep")?.classList.toggle("active", role === 'rep');
};

window.switchAuthMode = function(mode) {
  $("recoveryForm")?.classList.add("hidden");
  const signup = mode === "signup";
  $("loginForm")?.classList.toggle("hidden", signup);
  $("signupForm")?.classList.toggle("hidden", !signup);
  const title = $("authTitle");
  if (title) title.textContent = signup ? "طلب انضمام مندوب جديد" : "تسجيل الدخول";
};


const WASEET_ONBOARDING_VERSION = "v1";
let onboardingStepIndex = 0;
let onboardingSteps = [];

function getOnboardingSteps() {
  if (isAdmin()) return [
    {icon:"🤝",title:"أهلاً بك في وسيط",description:"هذه جولة سريعة تعرّفك على أهم أجزاء المنصة قبل البدء.",tip:"تقدر تتخطى الجولة بأي وقت، وترجع لها لاحقاً من المساعدة إذا أضفنا هذا الخيار."},
    {icon:"🛍️",title:"تابع الأغراض",description:"من الرئيسية تقدر تراجع أحدث الأغراض المسجلة وتفتح تفاصيل كل غرض.",tip:"تأكد من وضوح الصور والسعر وحالة الغرض قبل نشره للمندوبين."},
    {icon:"👥",title:"إدارة المندوبين",description:"استخدم قسم المندوبين لمراجعة طلبات الانضمام ومتابعة الحسابات وفق صلاحيات الإدارة.",tip:"امنح الصلاحيات بعد التحقق من الحساب، ولا تشارك بيانات الدخول."},
    {icon:"📊",title:"تابع البيع والعمولات",description:"راجع سجلات المبيعات والعمولات من الأقسام المخصصة، وحدّث الحالة بعد التأكد من إتمام البيع.",tip:"خلّ تسجيل البيع والعمولة واضحاً حتى تكون الحسابات دقيقة."}
  ];
  return [
    {icon:"🤝",title:"أهلاً بك في وسيط",description:"هنا تقدر تتصفح أغراض معروضة للبيع وتساعد أصحابها على إيجاد مشترين مقابل عمولة متفق عليها.",tip:"ابدأ بتصفح الأغراض المتاحة، وما تحتاج تحفظ خطوات كثيرة."},
    {icon:"🛍️",title:"تصفّح الأغراض",description:"من تبويب الرئيسية شوف أحدث الأغراض، وافتح أي بطاقة حتى تقرأ السعر والتفاصيل والصور.",tip:"اختَر غرضاً تعرف تفاصيله وتكدر تشرحها للمشتري."},
    {icon:"📲",title:"شارك الإعلان",description:"استخدم خيار المشاركة المتاح في تفاصيل الغرض حتى ترسل الإعلان إلى الأشخاص المهتمين أو تنشر رابطه.",tip:"لا تغيّر السعر أو شروط صاحب الغرض، واتفق على العمولة قبل إتمام البيع."},
    {icon:"💰",title:"تابع عمولاتك",description:"بعد إتمام البيع، تأكد من تسجيل العملية بالطريقة المعتمدة في وسيط، وتابع مستحقاتك من قسم العمولات إذا كان متاحاً لحسابك.",tip:"العمولة تُحسب حسب الاتفاق وتأكيد البيع، مو لمجرد مشاركة الإعلان."}
  ];
}

function renderOnboardingStep() {
  const step = onboardingSteps[onboardingStepIndex];
  if (!step) return;
  const icon = $("tourIcon"), heading = $("tourHeading"), description = $("tourDescription");
  const tip = $("tourTip"), label = $("tourStepLabel"), progress = $("tourProgress");
  if (icon) icon.textContent = step.icon;
  if (heading) heading.textContent = step.title;
  if (description) description.textContent = step.description;
  if (tip) tip.textContent = step.tip;
  if (label) label.textContent = "الخطوة " + (onboardingStepIndex + 1) + " من " + onboardingSteps.length;
  if (progress) progress.innerHTML = onboardingSteps.map((_,i)=>'<span class="'+(i<=onboardingStepIndex?'active':'')+'"></span>').join("");
  const prev = $("tourPrev"), next = $("tourNext");
  if (prev) prev.disabled = onboardingStepIndex === 0;
  if (next) next.textContent = onboardingStepIndex === onboardingSteps.length - 1 ? "ابدأ استخدام وسيط ✓" : "التالي ←";
}

window.changeOnboardingStep = function(direction) {
  const nextIndex = onboardingStepIndex + Number(direction || 0);
  if (nextIndex < 0) return;
  if (nextIndex >= onboardingSteps.length) {
    finishOnboardingTour();
    return;
  }
  onboardingStepIndex = nextIndex;
  renderOnboardingStep();
};

window.finishOnboardingTour = function() {
  try {
    if (currentUser?.id) localStorage.setItem("waseet_onboarding_" + currentUser.id, WASEET_ONBOARDING_VERSION);
  } catch (_) {}
  const dialog = $("onboardingTourDialog");
  if (dialog?.open) dialog.close();
  if ($("goodsList")) $("goodsList").scrollIntoView({behavior:"smooth",block:"start"});
};

function showOnboardingTour() {
  if (!currentUser || !profile || !isNewRepAccount()) return;
  let completed = "";
  try { completed = localStorage.getItem("waseet_onboarding_" + currentUser.id) || ""; } catch (_) {}
  if (completed === WASEET_ONBOARDING_VERSION) return;
  const tour = $("onboardingTourDialog");
  if (!tour) return;
  const notificationDialog = $("notificationGateDialog");
  if (notificationDialog?.open) {
    if (!notificationDialog.dataset.tourAfterClose) {
      notificationDialog.dataset.tourAfterClose = "1";
      notificationDialog.addEventListener("close", () => window.setTimeout(showOnboardingTour, 250), {once:true});
    }
    return;
  }
  onboardingSteps = getOnboardingSteps();
  onboardingStepIndex = 0;
  renderOnboardingStep();
  if (!tour.open) {
    try { tour.showModal(); } catch (_) { tour.setAttribute("open", ""); }
  }
}

function showApp() {
  $("welcomeView")?.classList.add("hidden");
  $("authView")?.classList.add("hidden");
  $("appView")?.classList.remove("hidden");

  const name = profile?.full_name || currentUser?.email || "مستخدم";
  if ($("userLabel")) $("userLabel").textContent = name;
  if ($("avatarCircle")) $("avatarCircle").textContent = name.charAt(0).toUpperCase();
  updateBottomAccountAvatar();
  if ($("roleBadge")) $("roleBadge").textContent = isAdmin() ? "المدير" : "مندوب";

  document.querySelectorAll(".admin-only").forEach(el => {
    el.classList.toggle("hidden", !isAdmin());
  });
  document.querySelectorAll(".rep-only").forEach(el => {
    el.classList.toggle("hidden", profile?.role !== "rep");
  });

  $('inquiriesAddButton')?.classList.toggle('hidden',!isAdmin() && profile?.permissions?.can_add_inquiry===false);
  if (!isAdmin() && profile?.status === 'restricted') {
    const permissions = profile?.permissions || {};
    if (permissions.can_add_inquiry === false) {
      $("addInquiryFab")?.classList.add("hidden");
    }
  }

  window.switchTab('home');
  window.finishWaseetStartup?.();
  if (typeof window.initChatFeature === 'function') void window.initChatFeature();
}

window.switchTab = function(tabName) {
  const target = $(tabName + "View");
  if(!target || (target.classList.contains('admin-only') && !isAdmin()) || (target.classList.contains('rep-only') && profile?.role!=='rep'))return false;
  document.querySelectorAll(".tab-view").forEach(v => v.classList.add("hidden"));
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
  return true;
};

function updateBottomAccountAvatar(){
  const node=$("bottomAccountAvatar");
  if(node)node.innerHTML=waseetAvatar({...profile,id:currentUser?.id},25);
}
function renderAccountView() {
  updateBottomAccountAvatar();
  const name = profile?.full_name || currentUser?.email || "حساب المستخدم";
  if ($("accountName")) $("accountName").textContent = name;
  if ($("accountAvatar")) $("accountAvatar").innerHTML=waseetAvatar({...profile,id:currentUser?.id},64);
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
    alert("تعذّر إرسال الطلب. تحقق من الاتصال وحاول مجدداً.");
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
    window.setTimeout(showOnboardingTour, 500);
    alert(approve ? "تمت الموافقة وتحديث اسم المندوب." : "تم رفض الطلب.");
  } catch (err) {
    alert("تعذّرت معالجة الطلب. تحقق من الاتصال والصلاحية وحاول مجدداً.");
  }
};

let profilePhotoSaving=false;
window.uploadProfilePhoto = async function() {
  const input=$("profilePhotoInput"),file=input?.files?.[0];
  if(!file || !currentUser || !db || profilePhotoSaving)return;
  if(!file.type.startsWith('image/') || file.size>8*1024*1024){input.value='';return alert('اختر صورة بحجم أقل من 8 ميغابايت.');}
  const actor=currentUser;
  const status=$("profilePhotoStatus");
  profilePhotoSaving=true;input.disabled=true;
  if(status)status.textContent='جارٍ تجهيز الصورة وحفظها…';
  try{
    const image=await new Promise((resolve,reject)=>{
      const url=URL.createObjectURL(file),image=new Image();
      image.onload=()=>{URL.revokeObjectURL(url);resolve(image);};
      image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('IMAGE_DECODE'));};image.src=url;
    });
    if(currentUser!==actor)return;
    const side=Math.min(image.naturalWidth,image.naturalHeight),size=Math.min(512,side);
    const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
    const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,size,size);
    context.drawImage(image,(image.naturalWidth-side)/2,(image.naturalHeight-side)*.35,side,side,0,0,size,size);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.88));
    if(!blob)throw new Error('IMAGE_ENCODE');
    if(currentUser!==actor)return;
    const path=actor.id+'/avatar.jpg';
    const {error}=await db.storage.from('profile-avatars').upload(path,blob,{contentType:'image/jpeg',upsert:true,cacheControl:'3600'});
    if(error)throw error;
    if(currentUser!==actor)return;
    const {data}=db.storage.from('profile-avatars').getPublicUrl(path);
    const avatarUrl=data.publicUrl+'?v='+Date.now();
    const {error:saveError}=await db.rpc('set_my_avatar_url',{p_avatar_url:avatarUrl});
    if(saveError)throw saveError;
    if(currentUser!==actor)return;
    profile={...profile,avatar_url:avatarUrl};
    if(typeof chatPeople!=='undefined')chatPeople=chatPeople.map(person=>person.id===actor.id?{...person,avatar_url:avatarUrl}:person);
    renderAccountView();syncWaseetAvatar({...profile,id:actor.id});
    if(status)status.textContent='تم تحديث صورتك في الحساب والدردشة.';
  }catch(_){if(currentUser===actor && status)status.textContent='تعذّر حفظ الصورة. بقيت صورتك السابقة؛ اختر صورة صالحة وحاول مجدداً.';}
  finally{profilePhotoSaving=false;input.disabled=false;input.value='';}
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
    alert("تعذّر حفظ اسم المستخدم. قد يكون مستخدماً؛ تحقق منه ومن الاتصال وحاول مجدداً.");
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
  const actor=currentUser;
  
  try {
    const { data, error } = await db
      .from("profiles")
      .select("*")
      .eq("id", actor.id)
      .maybeSingle();
    if(currentUser!==actor)return;

    if (error) {
      console.warn("Profile fetch warning:");
    }

    if (data) {
      profile = data;
    } else {
      profile = null;
      console.warn("No profile exists for this authenticated user.");
    }
  } catch (err) {
    console.error("loadProfile err:");
    if(currentUser===actor)profile = null;
  }
}

async function startApp(user) {
  const generation=++accountGeneration;
  currentUser = user;
  try {
    await loadProfile();
    if(generation!==accountGeneration || currentUser!==user)return;

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
      $("welcomeView")?.classList.remove("hidden");
  $("authView")?.classList.add("hidden");
  $("welcomeView")?.style.setProperty("display", "flex");
      return;
    }

    if (!(isAdmin() || (profile?.role === "rep" && ["approved","restricted"].includes(profile.status)))) {
      alert(profile?.status === "pending"
        ? "طلب انضمامك مسجل بالفعل وبانتظار موافقة المدير. لا تحتاج إلى تقديم طلب جديد."
        : "حسابك غير مفعّل حالياً. تواصل مع المدير.");
      await db.auth.signOut();
      currentUser = null;
      profile = null;
      return;
    }

    showApp();
    // Check the existing browser subscription before considering any prompt. A saved grant must not flash a false gate.
    void initPushNotifications().finally(() => {
      if (currentUser === user && profile?.role === "rep" && !pushSubscription) showNotificationGate();
    });
    startPresenceTracking();
    startRepStatusMonitoring();
    await refreshData();
  } catch (err) {
    if(generation!==accountGeneration || currentUser!==user)return;
    console.error("startApp Error:");
    alert("تعذّر تحميل الحساب. تحقق من الاتصال وحاول لاحقاً.");
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
  list.innerHTML = [...notifications].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)).map(item => {
    const isUnread = !item.read_at;
    const senderId=item.created_by||item.metadata?.sender_id;
    const sender=senderId?(typeof chatPerson==='function'?chatPerson(senderId):null)||reps.find(person=>person.id===senderId):null;
    const icon=sender?waseetAvatar(sender,34):waseetIcon(item.category==='new_goods'?'box':'bell');
    return `
      <button type="button" class="notification-card ${isUnread ? "notification-unread" : ""}"
        data-notification-id="${esc(item.id)}" aria-label="${isUnread ? "وضع الإشعار كمقروء: " : ""}${esc(item.title)}">
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
  const actor=currentUser;
  const { data, error } = await db.from("notifications")
    .select("id,recipient_id,title,body,category,metadata,created_at,read_at")
    .eq("recipient_id", currentUser.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if(currentUser!==actor)return false;
  if (error) {
    console.warn("In-app notifications could not be loaded. Ensure supabase/notifications.sql has been run:");
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
      console.warn("Could not mark notification as read:");
    } else {
      item.read_at = new Date().toISOString();
      renderNotificationBadge();
      renderNotificationsList();
    }
  }
};

function positionNotificationsPopover() {
  const panel=$("notificationsDialog"), bell=$("notificationsHeaderButton");
  if(!panel || !bell)return;
  const rect=bell.getBoundingClientRect();
  const container=$('appView')?.getBoundingClientRect()||{left:0,right:innerWidth};
  const header=bell.closest('.header'),style=header?getComputedStyle(header):null;
  const start=container.left+Math.max(12,parseFloat(style?.paddingLeft)||0);
  const end=container.right-Math.max(12,parseFloat(style?.paddingRight)||0);
  const width=Math.min(345,end-start);
  const left=Math.max(start,Math.min(end-width,rect.right-width));
  const viewport=window.visualViewport;
  const top=Math.max(viewport?.offsetTop||0,Math.min((viewport?.offsetTop||0)+(viewport?.height||innerHeight)-160,rect.bottom+10));
  panel.style.setProperty('--waseet-popover-width',width+'px');
  panel.style.setProperty("--waseet-popover-left",left+"px");
  panel.style.setProperty("--waseet-popover-top",top+"px");
}

function closeNotificationsPopover(){
  const panel=$("notificationsDialog"), bell=$("notificationsHeaderButton");
  if(panel?.open)panel.close();
  bell?.setAttribute("aria-expanded","false");
}
window.showNotificationsDialog = async function(){
  const panel=$("notificationsDialog"), bell=$("notificationsHeaderButton");
  if(!panel)return;
  if(panel.open){closeNotificationsPopover();return;}
  positionNotificationsPopover();
  // show(), not showModal(): no full-screen overlay/backdrop.
  if(typeof panel.show==="function")panel.show();
  else panel.setAttribute("open","");
  bell?.setAttribute("aria-expanded","true");
  await loadNotifications();
};
document.addEventListener("pointerdown", event=>{
  const panel=$("notificationsDialog");
  if(panel?.open && !panel.contains(event.target) && !$("notificationsHeaderButton")?.contains(event.target)){
    closeNotificationsPopover();
  }
});
document.addEventListener("keydown", event=>{
  if(event.key==="Escape")closeNotificationsPopover();
});
window.addEventListener("resize",()=>{
  if($("notificationsDialog")?.open)positionNotificationsPopover();
});
window.visualViewport?.addEventListener("resize",()=>{if($("notificationsDialog")?.open)positionNotificationsPopover();});
document.addEventListener("visibilitychange",()=>{
  if(document.hidden)closeNotificationsPopover();
});
$("notificationsDialog")?.addEventListener("close",()=>{
  $("notificationsHeaderButton")?.setAttribute("aria-expanded","false");
});
async function loadTeamActivity() {
  const list = $("teamActivityList");
  const empty = $("teamActivityEmpty");
  if (!db || !currentUser || !list) return;
  list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">جارٍ تحميل نشاط الفريق…</div>';
  const actor=currentUser;
  const { data, error } = await db.from("notifications")
    .select("id,title,body,category,created_at,metadata,created_by")
    .eq("recipient_id", currentUser.id)
    .eq("category", "sale")
    .order("created_at", { ascending: false })
    .limit(100);
  if(currentUser!==actor)return;
  if (error) {
    console.warn("Team activity could not be loaded:");
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
  // Older activity triggers saved names as "غير معروف" despite having rep/actor UUIDs.
  // Resolve only display names available to this signed-in user under existing RLS.
  const nameIds = [...new Set(teamActivity.flatMap(item =>
    [item.metadata?.rep_id, item.created_by].filter(id => typeof id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))))];
  const activityNames = new Map();
  if (nameIds.length) {
    const { data: people, error: peopleError } = await db.from("profiles")
      .select("id,full_name,role").in("id",nameIds);
    if (currentUser !== actor) return;
    if (!peopleError) (people || []).forEach(person => {
      if (person.full_name?.trim()) activityNames.set(String(person.id),person);
    });
  }
  list.innerHTML = teamActivity.map(item => {
    const isPayout = /تحويل|مستحقات|عمولة/i.test(String(item.title || "") + " " + String(item.body || ""));
    const repName = String(item.metadata?.rep_name || activityNames.get(String(item.metadata?.rep_id))?.full_name || '').trim();
    const actorName = String(item.metadata?.actor_name || activityNames.get(String(item.created_by))?.full_name || '').trim();
    const isAdminAction = isPayout || /بيع جديد|تسجيل عملية بيع/i.test(String(item.title||''));
    let body = String(item.body || '');
    // Only improve historical placeholder text; never substitute an invented personal name.
    if (repName) body = body.replace(/(المندوب\s+)غير معروف/g, '$1' + repName);
    if (actorName) {
      body = body.replace(/(نفّذ العملية المستخدم|نفذ العملية المستخدم|سجّل العملية المستخدم|سجل العملية المستخدم)\s+غير معروف/g, 'نفّذ العملية ' + actorName);
    } else if (isAdminAction) {
      body = body.replace(/(نفّذ العملية المستخدم|نفذ العملية المستخدم|سجّل العملية المستخدم|سجل العملية المستخدم)\s+غير معروف/g, 'نفّذت العملية الإدارة');
    }
    return '<article class="notification-card" style="cursor:default;">' +
      '<span class="notification-symbol">' + (isPayout ? '💰' : '🛍️') + '</span>' +
      '<span class="notification-copy"><span class="notification-title">' + esc(item.title) + '</span>' +
      '<span class="notification-body">' + esc(body) + '</span>' +
      '<span class="notification-time">' + esc(notificationDate(item.created_at)) + '</span></span></article>';
  }).join("");
}
window.refreshTeamActivity = function() { void loadTeamActivity(); };


async function loadExternalListings() {
  const list = $("externalListingsList"), empty = $("externalListingsEmpty");
  // طلبات أصحاب الأغراض خاصة بالمدير حصراً، ولا تظهر للمندوبين.
  if (!db || !currentUser || !isAdmin()) {
    externalListings = [];
    externalListingClaims = [];
    if (list) list.innerHTML = "";
    if (empty) empty.classList.add("hidden");
    return;
  }
  const actor=currentUser;
  const { data, error } = await db.from("external_listings")
    .select("id,title,description,asking_price,area,source_name,status,created_at,submitter_name,submitter_contact,image_url,image_urls,negotiable")
    .not("submitter_contact", "is", null)
    .order("created_at", { ascending: false }).limit(100);
  if(currentUser!==actor || !isAdmin())return;
  if (error) {
    console.warn("Owner item requests unavailable. Apply supabase/external-listings.sql first:");
    externalListings = [];
    renderExternalListings("unavailable");
    return;
  }
  externalListings = data || [];
  externalListingClaims = [];
  renderExternalListings();
}

function renderExternalListings(loadError = "") {
  if(!isAdmin()){externalListings=[];$("externalListingsList")?.replaceChildren();return;}
  const list = $("externalListingsList"), empty = $("externalListingsEmpty");
  if (!list) return;
  if (loadError) {
    list.innerHTML = '<div style="padding:12px;border-radius:10px;background:#fff7ed;color:#9a3412;line-height:1.8;font-size:12px;">تعذّر تحميل الطلبات. تحقق من الاتصال وحاول مجدداً.</div>';
    if (empty) empty.classList.add("hidden"); return;
  }
  if (!externalListings.length) { list.innerHTML = ""; if (empty) empty.classList.remove("hidden"); return; }
  if (empty) empty.classList.add("hidden");
  list.innerHTML = externalListings.map(item => {
    
    const price = item.asking_price == null ? "السعر غير محدد" : money(item.asking_price);
    const description = item.description ? '<div style="font-size:12px;line-height:1.8;color:var(--text-muted);margin-top:5px;white-space:pre-wrap;">' + esc(item.description) + '</div>' : "";
    const statusLabel = '<div style="display:inline-block;background:' + (item.status === "removed" ? "#e2e8f0;color:#475569" : "#fef3c7;color:#92400e") + ';padding:3px 8px;border-radius:20px;font-size:11px;font-weight:800;margin-top:5px;">' + (item.status === "removed" ? "تم إغلاق الطلب" : "طلب جديد — للمدير فقط") + '</div>';
    const submitter = isAdmin() && item.submitter_contact ? '<div style="font-size:12px;line-height:1.8;margin-top:6px;color:var(--navy);font-weight:800;">صاحب الغرض: ' + esc(item.submitter_name || "صاحب الإعلان") + ' · ' + esc(item.submitter_contact) + '</div>' : "";
    const imageUrls = Array.isArray(item.image_urls) && item.image_urls.length ? item.image_urls : (item.image_url ? [item.image_url] : []);
    const photos = imageUrls.length ? '<div style="display:flex;gap:7px;overflow-x:auto;margin:0 0 10px;">' + imageUrls.map(getSafeImageUrl).filter(Boolean).map(url => '<img src="' + esc(url) + '" alt="صورة الغرض" loading="lazy" style="width:115px;height:100px;object-fit:cover;border-radius:11px;flex:0 0 115px;background:#eef2f7;">').join("") + '</div>' : "";
    const negotiationLabel = item.negotiable === true ? '<div style="font-size:11px;color:#166534;font-weight:800;margin-top:5px;">السعر قابل للتفاوض</div>' : item.negotiable === false ? '<div style="font-size:11px;color:#475569;font-weight:800;margin-top:5px;">السعر نهائي</div>' : "";
    const claimButton = "";
    const adminButtons = isAdmin() ? `
      ${item.status !== "removed" ? `<button type="button" data-external-review="${esc(item.id)}" style="background:#fee2e2;color:#b91c1c;border:0;border-radius:8px;padding:9px 10px;font-weight:700;">إغلاق الطلب</button>` : ""}
      <button type="button" data-external-delete="${esc(item.id)}" style="background:#b91c1c;color:#fff;border:0;border-radius:8px;padding:9px 10px;font-weight:700;">🗑️ حذف الطلب نهائياً</button>
    ` : "";
    const originalLink = "";
    return '<article class="product-card" style="display:block;padding:13px;margin-bottom:10px;">' + photos + '<div style="display:flex;align-items:flex-start;gap:10px;"><div style="flex:1;min-width:0;"><div class="product-title">' + esc(item.title) + '</div><div class="product-code">' + esc(item.area || "المنطقة غير محددة") + '</div><div class="product-price" style="margin-top:5px;">' + esc(price) + '</div>' + negotiationLabel + statusLabel + description + submitter + '</div></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--border);">' + adminButtons + '</div></article>';
  }).join("");
}

window.claimExternalListing = async function(listingId) {
  if (!currentUser || profile?.role !== "rep") return alert("استلام الإعلانات متاح للمندوبين فقط.");
  if (["banned", "removed", "restricted"].includes(profile?.status)) return alert("حسابك غير مؤهل لاستلام إعلانات حالياً. تواصل مع الإدارة.");
  if (externalListingClaims.some(c => String(c.listing_id) === String(listingId))) return alert("تم استلام هذا الإعلان مسبقاً من حسابك.");
  const button = document.querySelector('[data-claim-listing="' + CSS.escape(String(listingId)) + '"]');
  if (button) { button.disabled = true; button.textContent = "جارٍ الاستلام…"; }
  const { error } = await db.from("external_listing_claims").insert({ listing_id: listingId, rep_id: currentUser.id });
  if (error) {
    if (button) { button.disabled = false; button.textContent = "استلام الإعلان داخلياً"; }
    if (error.code === "23505") return alert("هذا الإعلان استلمه مندوب آخر بالفعل.");
    return alert("تعذّر استلام الإعلان. تحقق من الاتصال وصلاحية حسابك وحاول مجدداً.");
  }
  await loadExternalListings(); alert("تم تسجيل استلام الإعلان داخلياً.");
};

window.reviewExternalListing = async function(listingId, status) {
  if (!isAdmin()) return alert("مراجعة الإعلانات متاحة للمدير فقط.");
  if (!["active", "removed"].includes(status)) return;
  if (!confirm(status === "active" ? "تأكيد الموافقة على الإعلان ونشره؟" : "تأكيد رفض/إخفاء الإعلان؟")) return;
  const { error } = await db.from("external_listings").update({ status, updated_at: new Date().toISOString() }).eq("id", listingId);
  if (error) return alert("تعذرت مراجعة الإعلان. تحقق من الاتصال وصلاحية حسابك وحاول مجدداً.");
  await loadExternalListings();
};

window.deleteExternalListing = async function(listingId) {
  if (!isAdmin()) return alert("حذف الطلبات متاح للمدير فقط.");
  const item = externalListings.find(row => String(row.id) === String(listingId));
  if (!item) return alert("لم يتم العثور على الطلب. حدّث القائمة وحاول مرة أخرى.");
  if (!confirm("حذف الطلب نهائياً؟ لا يمكن التراجع عن الحذف.")) return;
  try {
    const { error } = await db.from("external_listings").delete().eq("id", listingId);
    if (error) throw error;
    externalListings = externalListings.filter(row => String(row.id) !== String(listingId));
    renderExternalListings();
    alert("تم حذف الطلب نهائياً.");
  } catch (error) {
    alert("تعذّر حذف الطلب. تحقق من صلاحيتك والاتصال وحاول مجدداً.");
  }
};

window.showExternalListingDialog = function() {
  $("publicListingForm")?.reset();
  showDialog("publicListingDialog");
};

window.togglePublicListingDamage = function() {
  const damaged = $("publicListingDamage")?.value === "yes";
  const group = $("publicListingDamageDetailsGroup");
  const input = $("publicListingDamageDetails");
  if (group) group.classList.toggle("hidden", !damaged);
  if (input) { input.required = damaged; if (!damaged) input.value = ""; }
};

window.previewPublicListingImages = function() {
  const input = $("publicListingImages");
  const preview = $("publicListingImagePreview");
  const count = $("publicListingImageCount");
  if (!input || !preview) return;
  const files = Array.from(input.files || []);
  if (files.length > 5) {
    alert("تقدر تختار 5 صور كحد أقصى. اختار الصور المطلوبة مرة ثانية.");
    input.value = "";
    preview.innerHTML = "";
    if (count) count.textContent = "تقدر تضيف من صورة إلى 5 صور، حسب حاجتك. كل صورة بحد أقصى 8 ميغابايت.";
    return;
  }
  preview.innerHTML = "";
  files.forEach((file, index) => {
    if (!file.type.startsWith("image/")) return;
    const tile = document.createElement("div");
    tile.style.cssText = "position:relative;aspect-ratio:1;border-radius:10px;overflow:hidden;background:#f1f5f9;border:1px solid #e2e8f0;";
    const img = document.createElement("img");
    img.alt = "معاينة الصورة " + (index + 1);
    img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
    img.src = URL.createObjectURL(file);
    const tag = document.createElement("span");
    tag.textContent = index === 0 ? "الغلاف" : String(index + 1);
    tag.style.cssText = "position:absolute;right:5px;bottom:5px;background:rgba(15,31,61,.88);color:#fff;padding:3px 6px;border-radius:6px;font-size:10px;";
    tile.append(img,tag); preview.appendChild(tile);
  });
  if (count) count.textContent = files.length ? "تم اختيار " + files.length + " من 5 صور. الصورة الأولى هي صورة الغلاف." : "تقدر تضيف من صورة إلى 5 صور، حسب حاجتك. كل صورة بحد أقصى 8 ميغابايت.";
};

window.submitPublicListing = async function() {
  if (publicListingSubmitting) return;
  if (!db) return alert("الخدمة غير جاهزة حالياً. حاول لاحقاً.");
  const form = $("publicListingForm"); if (!form) return;
  const value = name => String(form.elements[name]?.value || "").trim();
  const title=value("title"), description=value("description"), area=value("area"), name=value("submitterName"), contact=value("submitterContact"), priceRaw=value("price");
  const category=value("category"), condition=value("condition"), damage=value("damage"), damageDetails=value("damageDetails");
  const negotiable = value("negotiable") === "yes";
  const imageFiles = Array.from($("publicListingImages")?.files || []);
  if (title.length < 2 || name.length < 2 || contact.replace(/[^0-9]/g, "").length < 7 || area.length < 2) return alert("اكتب اسم الغرض واسمك ورقم هاتف صحيح والمنطقة.");
  if (!category || !condition || !damage) return alert("حدد صنف الغرض وحالته وهل يوجد ضرر.");
  if (damage === "yes" && damageDetails.length < 3) return alert("وضح الضرر أو العطل الموجود بالغرض.");
  if (!priceRaw || !Number.isSafeInteger(Number(priceRaw)) || Number(priceRaw) <= 0) return alert("اكتب السعر بالدينار عدداً صحيحاً موجباً ضمن الحد المسموح.");
  if (!imageFiles.length || imageFiles.length > 5) return alert("أضف صورة واحدة على الأقل، وبحد أقصى 5 صور.");
  if (imageFiles.some(file => !file.type.startsWith("image/") || file.size > 8 * 1024 * 1024)) return alert("اختر صوراً فقط، وحجم كل صورة أقل من 8 ميغابايت.");
  publicListingSubmitting=true;
  let preparingImage=false;
  const button=$("submitPublicListingButton"); if (button) { button.disabled=true; button.textContent="جارٍ رفع الصور وإرسال الغرض…"; }
  try {
    const imageUrls = [];
    for (let i = 0; i < imageFiles.length; i++) {
      preparingImage=true;
      const original=imageFiles[i];
      const file=/^image\/(jpeg|png|webp)$/.test(original.type)?await compressListingImage(original):original;
      preparingImage=false;
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const path = "public/" + crypto.randomUUID() + "-" + i + "." + ext;
      const { error: uploadError } = await db.storage.from("listing-images").upload(path, file, { contentType: file.type, upsert: false, cacheControl: "3600" });
      if (uploadError) throw uploadError;
      imageUrls.push(db.storage.from("listing-images").getPublicUrl(path).data.publicUrl);
    }
    const details = [
      "الصنف: " + category,
      "حالة الغرض: " + condition,
      "يوجد ضرر أو عطل: " + (damage === "yes" ? "نعم - " + damageDetails : "لا"),
      description ? "تفاصيل إضافية: " + description : ""
    ].filter(Boolean).join("\n");
    const payload = { title, description:details||null, area, asking_price:Math.round(Number(priceRaw)), negotiable, image_url:imageUrls[0], image_urls:imageUrls, source_url:null, source_name:"غرض من الجمهور", submitter_name:name, submitter_contact:contact, created_by:null, status:"pending" };
    const {error}=await db.from("external_listings").insert(payload);
    if (error) throw error;
    hideDialog("publicListingDialog"); form.reset();
    if ($("publicListingImagePreview")) $("publicListingImagePreview").innerHTML = "";
    if ($("publicListingImageCount")) $("publicListingImageCount").textContent = "تقدر تضيف من صورة إلى 5 صور، حسب حاجتك. كل صورة بحد أقصى 8 ميغابايت.";
    togglePublicListingDamage();
    alert("تم استلام طلبك بنجاح، وسيظهر للمدير فقط لمراجعته والتواصل وياك.");
    try { await loadExternalListings(); }
    catch (_) { console.warn("Public listing refresh failed after successful submission"); }
  } catch (err) {
    console.warn("Public item submission failed");
    alert(preparingImage?"تعذّرت قراءة الصورة. أعد اختيار صورة JPEG أو PNG أو WebP؛ بيانات النموذج محفوظة.":"تعذّر إرسال الطلب. تحقق من اتصالك؛ بيانات النموذج محفوظة. لا توجد إعادة إرسال تلقائية.");
  } finally {
    publicListingSubmitting=false;
    if (button) { button.disabled=false; button.textContent="إرسال الطلب للمدير"; }
  }
};

function dataStatus(message){const node=$('dataStatus');if(node){node.textContent=message;node.classList.toggle('hidden',!message);}}
async function fetchAccountData(){
  if(!db || !currentUser || !profile)return;
  const actor=currentUser,role=profile.role,status=profile.status;
  const valid=()=>currentUser===actor && profile?.role===role && profile?.status===status;
  dataStatus('جارٍ تحديث الأغراض والسجلات…');
  try{
    const [_,inquiryResult]=await Promise.all([
      loadMarketGoods({reset:true,clearCache:true}),
      readReportRows('inquiries',{valid})]);
    if(!valid())return;
    if(inquiryResult.error)throw new Error('Read failed');
    let nextSales=[],nextReps=[],nextPending=[],nextNames=[],requestPending=false;
    if(isAdmin()){
      const [repResult,saleResult,nameResult]=await Promise.all([
        db.from('profiles').select('*').eq('role','rep'),
        readReportRows('sales',{valid}),db.rpc('get_name_change_requests')]);
      if(!valid())return;
      if(repResult.error || saleResult.error)throw new Error('Read failed');
      const all=repResult.data||[];nextReps=all.filter(r=>['approved','restricted','banned'].includes(r.status));
      nextPending=all.filter(r=>r.status==='pending');nextSales=saleResult.data||[];nextNames=nameResult.data||[];
    }else if(role==='rep'){
      const [saleResult,nameResult]=await Promise.all([
        readReportRows('sales',{repId:actor.id,valid}),db.rpc('has_pending_name_change_request')]);
      if(!valid())return;if(saleResult.error)throw new Error('Read failed');
      nextSales=saleResult.data||[];requestPending=nameResult.data===true;
    }
    const linkedWarning=await loadLinkedGoods([...nextSales,...(inquiryResult.data||[])],valid);
    if(!valid())return;
    inquiries=inquiryResult.data||[];sales=nextSales;reps=nextReps;
    pendingReps=nextPending;nameChangeRequests=nextNames;
    if(role==='rep')profile.name_change_request_pending=requestPending;
    render();
    await Promise.all([loadExternalListings(),loadNotifications({quiet:true})]);
    if(valid())dataStatus(linkedWarning?'تعذّر تحميل بعض تفاصيل الأغراض المرتبطة بالسجلات. حدّث القائمة للمحاولة مجدداً.':'');
  }catch(error){if(valid())dataStatus(error?.code==='REPORT_PAGE_LIMIT'?'تجاوز السجل حد التحميل الآمن؛ بقيت السجلات والأرقام السابقة دون استبدالها بنتيجة جزئية.':'تعذّر تحديث البيانات. بقي العرض السابق محفوظاً؛ اضغط هنا للمحاولة مجدداً.');}
}
function refreshData(){
  const actor=currentUser;
  if(refreshInFlight?.actor===actor && refreshInFlight?.role===profile?.role && refreshInFlight?.status===profile?.status)return refreshInFlight.promise;
  const operation={actor,role:profile?.role,status:profile?.status,promise:null};
  operation.promise=fetchAccountData().finally(()=>{if(refreshInFlight===operation)refreshInFlight=null;});
  refreshInFlight=operation;return operation.promise;
}

function getSafeImageUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch (_) {
    return null;
  }
}

function getGoodImageUrls(good) {
  const urls = [];
  const add = value => {
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    if (typeof value !== "string") return;
    const text = value.trim();
    if (!text) return;
    // Supports a JSON-encoded array as well as a normal URL or a pipe-separated list.
    if (text.startsWith("[") && text.endsWith("]")) {
      try { add(JSON.parse(text)); return; } catch (_) {}
    }
    text.split("|").forEach(part => {
      const candidate = part.trim().replace(/^["']|["']$/g, "").replace(/[),;]+$/g, "");
      const safeUrl = getSafeImageUrl(candidate);
      if (safeUrl) urls.push(safeUrl);
    });
  };
  add(good?.image_urls);
  add(good?.image_url);
  const lines = String(good?.description || "").split(/\r?\n/).map(line => line.trim());
  for (const line of lines) {
    const match = line.match(/^(?:صور الغرض|صور المنتج|صور):\s*(.*)$/i);
    if (match) add(match[1]);
  }
  return [...new Set(urls)].slice(0, 5);
}

function isPrivateGoodDetail(line){
  return /عمولة|commission|owner[_\s-]*(?:name|phone|contact)|(?:اسم|هاتف|رقم|بيانات)\s*(?:صاحب|المالك|مالك)|^\s*(?:صاحب الغرض|المالك)\s*[:：]/i.test(line);
}
function getGoodDetailLines(good) {
  return String(good?.description || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).filter(line => !/^صور(?: الغرض| المنتج)?:/.test(line));
}

window.shareSingleGoodOnFacebook = function(goodsId) {
  const good = goods.find(g => String(g.id) === String(goodsId));
  if (!good) return alert("ما لكيت هذا الغرض. حدّث القائمة وحاول مرة ثانية.");
  if (good.status !== "available") return alert("هذا الغرض غير متوفر حالياً.");
  const details = String(good.description || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).filter(line=>!isPrivateGoodDetail(line));
  const readDetail = label => {
    const line = details.find(item => item.startsWith(label));
    return line ? line.slice(label.length).trim() : "";
  };
  const message = [
    "📣 إعلان للبيع | وسيط",
    "🛍️ اسم المنتج: " + good.title,
    readDetail("الصنف:") ? "🏷️ الصنف: " + readDetail("الصنف:") : "",
    "💰 السعر: " + money(good.asking_price),
    "📍 المكان: " + (good.area || "غير محدد"),
    readDetail("حالة الغرض:") ? "📦 حالة المنتج: " + readDetail("حالة الغرض:") : "",
    readDetail("يوجد ضرر أو عطل:") ? "🛠️ الأضرار: " + readDetail("يوجد ضرر أو عطل:") : "",
    readDetail("التفاوض:") ? "🤝 التفاوض: " + readDetail("التفاوض:") : "",
    readDetail("تفاصيل إضافية:") ? "📝 تفاصيل إضافية: " + readDetail("تفاصيل إضافية:") : "",
    "شاهد الصور وتواصل عبر تطبيق وسيط: https://husseinfadhil8-code.github.io/aseet-pwa/"
  ].filter(Boolean).join("\n");
  const url = "https://www.facebook.com/sharer/sharer.php?u=" +
    encodeURIComponent("https://husseinfadhil8-code.github.io/aseet-pwa/") +
    "&quote=" + encodeURIComponent(message);
  window.open(url, "_blank", "noopener,noreferrer");
};

window.openGoodDetails = function(goodsId) {
  const good = goods.find(g => String(g.id) === String(goodsId));
  if (!good) return alert("ما لكيت هذا المنتج. حدّث القائمة وحاول مرة ثانية.");
  const dialog = $("goodDetailsDialog");
  const content = $("goodDetailsContent");
  if (!dialog || !content) return;
  const images = getGoodImageUrls(good);
  const details = getGoodDetailLines(good).filter(line => !/عمولة|commission/i.test(line) && (isAdmin() || !isPrivateGoodDetail(line)));
  const imageGallery = images.length
    ? `<div class="waseet-details-gallery">${images.map((url,index) => `<img src="${esc(url)}" alt="صورة ${esc(good.title)} رقم ${index+1}" loading="${index===0 ? "eager" : "lazy"}">`).join("")}</div>`
    : '<div class="waseet-details-no-image">📦<p>لم تُحفظ صورة لهذا المنتج</p></div>';
  content.innerHTML = `
    <h2 class="waseet-details-title">${esc(good.title)}</h2>
    <div class="waseet-details-price">💰 ${money(good.asking_price)}</div>
    <div class="waseet-details-area">📍 المنطقة: ${esc(good.area || "غير محدد")}</div>
    ${imageGallery}
    ${details.length ? `<section class="waseet-details-description"><h3>تفاصيل المنتج</h3>${details.map(line => `<p>${esc(line)}</p>`).join("")}</section>` : '<p class="waseet-details-muted">لم يضف المدير تفاصيل إضافية لهذا المنتج.</p>'}
    <div class="waseet-details-actions">
      <button type="button" data-good-action="share">🟢 مشاركة على واتساب</button>
      ${isAdmin() ? `<button type="button" data-good-action="edit">✏️ تعديل المنتج</button>` : ""}
    </div>`;
  content.querySelectorAll(".waseet-details-gallery img").forEach((image, index) => {
    image.addEventListener("click", () => {
      const url = getSafeImageUrl(images[index]);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    });
    image.addEventListener("error", () => { image.style.display = "none"; });
  });
  content.querySelector('[data-good-action="share"]').addEventListener("click", () => {
    window.shareSingleGoodOnWhatsApp(good.id);
  });
  content.querySelector('[data-good-action="edit"]')?.addEventListener("click", () => {
    hideDialog("goodDetailsDialog");
    window.editGoods(good.id);
  });
  showDialog("goodDetailsDialog");
};

function render() {
  populateReleasedFilters();
  if($('statGoods'))$('statGoods').textContent=marketTotal??(marketGoods?.length??goods.filter(g=>g.status==='available').length);
  if($('statGoodsLabel'))$('statGoodsLabel').textContent=marketTotal!==null?'نتائج البحث':marketGoods!==null?'الأغراض المعروضة':'الأغراض المتوفرة';
  if ($("statReps")) $("statReps").textContent = reps.filter(r => r.status !== 'banned').length;
  if ($("statCommission")) {
    const total = sales.reduce((acc, s) => acc + (Number(s.total_commission) || 0), 0);
    $("statCommission").textContent = money(total);
  }

  if ($("goodsList")) {
    const availableGoods = releaseVisibleGoods();
    if($('goodsResultCount'))$('goodsResultCount').textContent=availableGoods.length+' غرض معروض'+(marketTotal===null?'':' من '+marketTotal+' نتيجة');
    $("goodsList").innerHTML = availableGoods.map((g,index) => {
      const images = getGoodImageUrls(g);
      const statusLabel = {available:"متاح",reserved:"محجوز",sold:"مباع",archived:"مؤرشف"}[g.status] || "غير متاح";
      const detailLines = getGoodDetailLines(g).filter(line => !isPrivateGoodDetail(line));
      return `
        <article class="product-card waseet-market-card" role="button" tabindex="0" aria-label="عرض تفاصيل ${esc(g.title)}" data-card-index="${index}">
          <div class="waseet-product-hero waseet-swipe-gallery" onclick="event.stopPropagation()" onkeydown="event.stopPropagation()">
            ${images.length ? `<div class="waseet-swipe-track" tabindex="0" role="region" aria-label="صور الغرض، اسحب للتقليب">${images.map((url,photoIndex) => `<div class="waseet-swipe-slide"><img src="${esc(url)}" alt="صورة ${photoIndex+1} لـ ${esc(g.title)}" loading="${index<2 && photoIndex===0?'eager':'lazy'}" decoding="async" onerror="this.style.display='none';"></div>`).join("")}</div>` : `<div class="waseet-image-fallback">📦<span>لا توجد صورة للمنتج</span></div>`}
            ${images.length > 1 ? `<span class="waseet-photo-count">اسحب للتقليب · 1/${images.length}</span><div class="waseet-gallery-dots">${images.map((_,index)=>`<span class="${index===0?'active':''}"></span>`).join("")}</div>` : ""}
          </div>
          <div class="waseet-product-body">
            <div class="waseet-product-title-row"><div class="product-title">${esc(g.title)}</div><span class="status-pill ${{available:"pill-green",reserved:"pill-orange",sold:"pill-blue",archived:"pill-gray"}[g.status]||"pill-gray"}">${esc(statusLabel)}</span></div>
            <div class="product-code">📍 ${esc(g.area || "غير محدد")}</div>
            <div class="waseet-market-price">${money(g.asking_price)}</div>
            ${detailLines.length ? `<div class="waseet-product-summary">${esc(detailLines.find(line => !/^(الصنف|حالة الغرض|يوجد ضرر أو عطل|التفاوض|تفاصيل إضافية):/.test(line)) || detailLines[0])}</div>` : ""}
            <button type="button" class="waseet-details-button" data-card-action="details">عرض الصور والتفاصيل ←</button>
            <div class="waseet-product-actions">
              <button type="button" class="waseet-share-main" data-card-action="share" aria-expanded="false">↗ مشاركة</button>
              ${isAdmin() && g.status === "available" ? `<button type="button" data-card-action="sale" style="background:var(--green);color:#fff;">✓ تم البيع</button>` : ""}
            </div>
            <div class="waseet-share-menu hidden" onclick="event.stopPropagation()">
              <button type="button" data-card-action="whatsapp">🟢 واتساب</button>
              <button type="button" data-card-action="facebook">🔵 فيسبوك</button>
            </div>
            ${isAdmin() ? `<div class="waseet-product-actions admin-product-actions"><button type="button" data-card-action="edit" style="background:var(--navy);color:var(--gold);">✏️ تعديل</button><button type="button" data-card-action="delete" style="background:#FEE2E2;color:#B91C1C;">🗑️ حذف</button></div>` : ""}
          </div>
        </article>
      `;
    }).join("");
    $("goodsList").querySelectorAll('[data-card-index]').forEach(card=>{
      const good=availableGoods[Number(card.dataset.cardIndex)];
      card.addEventListener('click',event=>{if(!event.target.closest('button,.waseet-swipe-gallery,.waseet-share-menu'))openGoodDetails(good.id);});
      card.addEventListener('keydown',event=>{if(event.target===card && ['Enter',' '].includes(event.key)){event.preventDefault();openGoodDetails(good.id);}});
      const actions={details:()=>openGoodDetails(good.id),share:button=>toggleGoodShareMenu(good.id,button),
        sale:()=>prepareSaleDialog(good.id),whatsapp:()=>shareSingleGoodOnWhatsApp(good.id),
        facebook:()=>shareSingleGoodOnFacebook(good.id),edit:()=>editGoods(good.id),delete:()=>deleteGoods(good.id)};
      card.querySelectorAll('[data-card-action]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();actions[button.dataset.cardAction]?.(button);}));
    });
  }

/* Update carousel counter and dots while swiping product photos */
document.querySelectorAll(".waseet-swipe-gallery").forEach(gallery => {
  const track = gallery.querySelector(".waseet-swipe-track");
  if (!track) return;
  const slides = [...track.children];
  const badge = gallery.querySelector(".waseet-photo-count");
  const dots = [...gallery.querySelectorAll(".waseet-gallery-dots span")];
  const update = () => {
    const index = Math.max(0, Math.min(slides.length - 1, Math.round(track.scrollLeft / Math.max(1, track.clientWidth))));
    if (badge) badge.textContent = `اسحب للتقليب · ${index + 1}/${slides.length}`;
    dots.forEach((dot,i) => dot.classList.toggle("active",i===index));
  };
  track.addEventListener("scroll", update, {passive:true});
});

  updateGoodsEmptyState();

  if ($("repsList")) {
    let html = reps.map((r, index) => {
      let statusBadge = '<span class="status-pill pill-green">نشط</span>';
      if (r.status === 'banned') statusBadge = '<span class="status-pill pill-red">محظور</span>';
      else if (r.status === 'restricted') statusBadge = '<span class="status-pill pill-orange">مقيّد</span>';

      const repSales = sales.filter(sale => String(sale.rep_id) === String(r.id));
      const repEarned = repSales.reduce((sum, sale) => sum + (Number(sale.rep_share) || 0), 0);
      const repPaid = repSales.filter(sale => Boolean(sale.commission_paid_at))
        .reduce((sum, sale) => sum + (Number(sale.rep_share) || 0), 0);
      const repDue = Math.max(0, repEarned - repPaid);

      return `
        <div class="product-card" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center;" data-manage-rep-index="${index}">
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
            ${r.status === 'approved' ? `<button type="button" data-test-rep-push="${esc(r.id)}" style="background: var(--green); color: #fff; border: none; padding: 4px 8px; border-radius: 8px; font-size: 10px; font-weight: 700; cursor: pointer;">🔔 اختبار إشعار</button>` : ''}
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
              <button data-rep-approve="${esc(r.id)}" style="background: var(--green); color: #fff; border: none; padding: 6px 12px; border-radius: 8px; font-weight: 700; cursor: pointer;">قبول</button>
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
            <div style="display:flex;gap:8px;"><button type="button" class="btn-navy" style="flex:1;background:var(--green);color:#fff;" data-name-review="${esc(req.id)}" data-name-approve="true">موافقة</button><button type="button" class="btn-navy" style="flex:1;background:#b91c1c;color:#fff;" data-name-review="${esc(req.id)}" data-name-approve="false">رفض</button></div>
          </div>`).join("") + `</section>` + html;
    }
    $("repsList").innerHTML = html;
    $("repsList").querySelectorAll("[data-manage-rep-index]").forEach(card => {
      const rep = reps[Number(card.dataset.manageRepIndex)];
      card.addEventListener("click", () => {
        window.openRepManage(rep.id, rep.full_name, rep.status);
      });
      card.querySelector("[data-test-rep-push]")?.addEventListener("click", event => {
        event.stopPropagation();
        window.testRepPushNotification(rep.id);
      });
    });
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
            ${paid ? `<div style="grid-column:1/-1;background:#ECFDF5;padding:9px;border-radius:9px;"><div class="product-code">تاريخ تحويل العمولة</div><strong>${esc(paidDate)}</strong></div>` : `<div style="grid-column:1/-1;"><button type="button" class="btn-navy" style="background:var(--green);color:#fff;" data-sale-paid="${esc(sale.id)}">✓ تأكيد تحويل عمولة المندوب</button></div>`}
          ${isAdmin() ? `<div style="grid-column:1/-1;"><button type="button" class="btn-navy" style="background:#b91c1c;color:#fff;" data-sale-delete="${esc(sale.id)}">🗑️ حذف سجل البيع والعمولة</button></div>` : ""}
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
    alert("تعذّر تنفيذ الإجراء. تحقق من الاتصال وصلاحية حسابك وحاول مجدداً.");
  }
};

let loginBusy=false;
function authFeedback(error){
  if(!navigator.onLine || error?.name==='AuthRetryableFetchError')return 'الاتصال غير متاح. تحقق من الشبكة وحاول مجدداً.';
  const messages={invalid_credentials:'تأكد من البريد الإلكتروني وكلمة المرور.',email_not_confirmed:'يرجى تأكيد البريد الإلكتروني من رسالة التفعيل أولاً.',over_request_rate_limit:'طلبات كثيرة خلال وقت قصير. انتظر قليلاً وحاول مجدداً.',over_email_send_rate_limit:'انتظر قليلاً قبل طلب رسالة بريد جديدة.',weak_password:'اختر كلمة مرور أقوى ثم حاول مجدداً.'};
  return messages[error?.code]||'تعذّر إكمال الطلب. تحقق من البيانات والاتصال وحاول مجدداً.';
}
window.handleLogin = async function() {
  if(loginBusy)return;
  const email = $("loginEmail")?.value?.trim();
  const password = $("loginPassword")?.value;

  if (!email || !password) return alert("يرجى إدخال البيانات كاملة");
  if(!navigator.onLine)return alert('أنت دون اتصال. اتصل بالإنترنت لتسجيل الدخول.');
  const button=document.querySelector('#loginForm button[onclick="handleLogin()"]');
  loginBusy=true;if(button){button.disabled=true;button.setAttribute('aria-busy','true');}
  try {
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (data?.user) {
      await startApp(data.user);
      if (currentUser?.id === data.user.id && profile) void sendPushEvent("user_login");
    }
  } catch (err) {
    alert(authFeedback(err));
  } finally {loginBusy=false;if(button){button.disabled=false;button.setAttribute('aria-busy','false');}}
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
  if(button?.disabled)return;

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
      throw new Error("تعذّر التحقق من اسم المستخدم. تحقق من الاتصال أو تواصل مع المدير.");
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
      console.error("Signup profile save failed:");
      if (profileError.code === "23505" || /duplicate|unique/i.test(profileError.message || "")) {
        throw new Error("اسم المستخدم اختاره شخص آخر للتو. لا تكرر التسجيل بالبريد نفسه؛ تواصل مع المدير إذا أُنشئ حساب الدخول لكن لم يظهر طلب المندوب.");
      }
      throw new Error("تم إنشاء حساب الدخول لكن تعذّر حفظ طلب المندوب. تواصل مع المدير ولا تكرر التسجيل بالبريد نفسه.");
    }

    // Notify administrators after the pending profile is saved without delaying the signup confirmation.
    void sendPushEvent("new_rep").then(pushResult => {
      if (!pushResult?.ok) {
        console.warn("New rep was saved, but admin push notification failed:");
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
    console.error("Signup failed:");
    alert(authFeedback(err));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "إرسال طلب الانضمام";
    }
  }
};
window.toggleGoodsDamage = function() {
  const yes = $("goodsDamage")?.value === "yes";
  $("goodsDamageDetailsWrap")?.classList.toggle("hidden", !yes);
  if ($("goodsDamageDetails")) $("goodsDamageDetails").required = yes;
};
let retainedGoodsImages=[];
let newGoodsImages=[];
let goodsImageItems=[];
let goodsPreviewUrls=[];
function releaseGoodsPreviews(){goodsPreviewUrls.forEach(url=>URL.revokeObjectURL(url));goodsPreviewUrls=[];}
function setGoodsSaving(value){goodsSaving=value;if($('goodsImageInput'))$('goodsImageInput').disabled=value;$('goodsImagePreview')?.querySelectorAll('button').forEach(button=>button.disabled=value);}
function syncGoodsImageItems(){
  retainedGoodsImages=goodsImageItems.filter(item=>item.saved).map(item=>item.url);
  newGoodsImages=goodsImageItems.filter(item=>!item.saved).map(item=>item.file);
}
function renderGoodsImageEditor(){
  const preview=$("goodsImagePreview");if(!preview)return;
  releaseGoodsPreviews();preview.replaceChildren();syncGoodsImageItems();
  goodsImageItems.forEach((item,index)=>{
    const url=item.saved?item.url:URL.createObjectURL(item.file);if(!item.saved)goodsPreviewUrls.push(url);
    const node=document.createElement('div');node.className='image-editor-item';
    const img=document.createElement('img');img.src=url;img.alt='صورة الغرض '+(index+1);node.append(img);
    const tools=document.createElement('div');tools.className='image-tools';
    [['حذف',()=>goodsImageItems.splice(index,1)],['تقديم',()=>{if(index>0)[goodsImageItems[index-1],goodsImageItems[index]]=[goodsImageItems[index],goodsImageItems[index-1]];}],['تأخير',()=>{if(index<goodsImageItems.length-1)[goodsImageItems[index+1],goodsImageItems[index]]=[goodsImageItems[index],goodsImageItems[index+1]];}]].forEach(([label,action])=>{
      const button=document.createElement('button');button.type='button';button.disabled=goodsSaving;button.textContent=label;button.setAttribute('aria-label',label+' الصورة '+(index+1));
      button.addEventListener('click',()=>{action();renderGoodsImageEditor();});tools.append(button);
    });node.append(tools);preview.append(node);
  });
  if($("goodsImageCount"))$("goodsImageCount").textContent=goodsImageItems.length+' / 5 صور · أول صورة هي الغلاف';
}
window.previewGoodsImages=function(){
  if(goodsSaving)return;
  const input=$("goodsImageInput");const files=Array.from(input?.files||[]);
  if(goodsImageItems.length+files.length>5 || files.some(file=>!/^image\/(jpeg|png|webp|gif)$/.test(file.type)||file.size>8*1024*1024)){
    input.value='';return alert('اختر حتى 5 صور JPEG أو PNG أو WebP أو GIF، أقل من 8 ميغابايت للصورة.');
  }
  goodsImageItems.push(...files.map(file=>({file,saved:false})));input.value='';renderGoodsImageEditor();
};
async function compressListingImage(file){
  if(file.type==='image/gif')return file;
  const url=URL.createObjectURL(file);
  try {
    const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('تعذّرت قراءة الصورة. جرّب JPEG أو PNG.'));img.src=url;});
    const scale=Math.min(1,1800/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
    const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.86));
    if(!blob || (scale===1 && blob.size>=file.size))return file;
    return new File([blob],file.name.replace(/\.[^.]+$/,'')+'.jpg',{type:'image/jpeg'});
  } finally{URL.revokeObjectURL(url);}
}

window.prepareAddGoods = function() {
  if(goodsSaving)return alert("انتظر اكتمال حفظ الغرض الحالي.");
  if (!isAdmin()) return alert("إضافة الأغراض متاحة للمدير فقط.");
  editingGoodsId = null;
  retainedGoodsImages=[];newGoodsImages=[];goodsImageItems=[];releaseGoodsPreviews();
  $("goodsForm")?.reset();
  if ($("goodsImagePreview")) $("goodsImagePreview").innerHTML = "";
  if ($("goodsImageCount")) $("goodsImageCount").textContent = "اختر من صورة إلى 5 صور، كل صورة أقل من 8 ميغابايت.";
  toggleGoodsDamage();
  $("goodsDialogTitle").textContent = "إضافة غرض جديد";
  $("saveGoodsButton").textContent = "حفظ";
  showDialog("goodsDialog");
};

window.editGoods = function(goodsId) {
  if(goodsSaving)return alert("انتظر اكتمال حفظ الغرض الحالي.");
  if (!isAdmin()) return alert("إضافة وتعديل الأغراض متاحان للمدير فقط.");
  const item = goods.find(g => String(g.id) === String(goodsId));
  if (!item) return alert("لم يتم العثور على الغرض. حدّث القائمة وحاول مجدداً.");

  editingGoodsId = item.id;
  retainedGoodsImages=getGoodImageUrls(item);newGoodsImages=[];goodsImageItems=retainedGoodsImages.map(url=>({url,saved:true}));releaseGoodsPreviews();
  if($("goodsImageInput")) $("goodsImageInput").value="";
  const form = $("goodsForm");
  form.elements.title.value = item.title || "";
  form.elements.area.value = item.area || "";
  form.elements.price.value = item.asking_price ?? "";
  form.elements.commission.value = item.agreed_commission ?? "";
  const detailLines = String(item.description || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const readDetail = label => { const line = detailLines.find(value => value.startsWith(label)); return line ? line.slice(label.length).trim() : ""; };
  form.elements.category.value = readDetail("الصنف:") || "";
  form.elements.condition.value = readDetail("حالة الغرض:") || "";
  const damage = readDetail("يوجد ضرر أو عطل:");
  form.elements.damage.value = damage.startsWith("نعم") ? "yes" : "no";
  form.elements.damageDetails.value = damage.replace(/^نعم\s*[-–—:]?\s*/, "");
  form.elements.negotiable.value = readDetail("التفاوض:") === "قابل للتفاوض" ? "yes" : "no";
  form.elements.notes.value = readDetail("تفاصيل إضافية:") || (detailLines.some(value => value.startsWith("الصنف:")) ? "" : getGoodDetailLines(item).join("\n"));
  renderGoodsImageEditor();
  toggleGoodsDamage();
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
    alert("تعذّر حذف الغرض. قد يرتبط بسجل آخر؛ تحقق من صلاحيتك والاتصال.");
  }
};

window.handleSaveGoods = async function() {
  if (goodsSaving) return;
  if (!isAdmin()) return alert("إضافة وتعديل الأغراض متاحان للمدير فقط.");
  const actor=currentUser,targetGoodsId=editingGoodsId,images=goodsImageItems.map(item=>({...item}));
  if(!actor || !db)return;
  const form = $("goodsForm");
  if (!form.reportValidity()) return;
  const formData = new FormData(form);
  const title = String(formData.get("title") || "").trim();
  const category = String(formData.get("category") || "").trim();
  const condition = String(formData.get("condition") || "").trim();
  const damage = String(formData.get("damage") || "no");
  const damageDetails = String(formData.get("damageDetails") || "").trim();
  const negotiable = String(formData.get("negotiable") || "no") === "yes";
  const notes = String(formData.get("notes") || "").trim();
  const imageFiles = [...newGoodsImages];
  if (!category || !condition || !damage) return alert("حدد صنف الغرض وحالته وهل يوجد ضرر.");
  if (damage === "yes" && damageDetails.length < 3) return alert("وضح الضرر أو العطل الموجود بالغرض.");
  if (imageFiles.length + retainedGoodsImages.length > 5) return alert("تقدر ترفع بحد أقصى 5 صور.");
  if (imageFiles.some(file => !/^image\/(jpeg|png|webp|gif)$/.test(file.type) || file.size > 8 * 1024 * 1024)) return alert("اختر صوراً فقط، وحجم كل صورة أقل من 8 ميغابايت.");
  const payload = {
    title,
    area: String(formData.get("area") || "").trim(),
    asking_price: Number(formData.get("price")),
    agreed_commission: Number(formData.get("commission")),
    description: [
      "الصنف: " + category,
      "حالة الغرض: " + condition,
      "يوجد ضرر أو عطل: " + (damage === "yes" ? "نعم - " + damageDetails : "لا"),
      "التفاوض: " + (negotiable ? "قابل للتفاوض" : "السعر نهائي"),
      notes ? "تفاصيل إضافية: " + notes : ""
    ].filter(Boolean).join("\n")
  };

  if (!payload.title || !Number.isFinite(payload.asking_price) || payload.asking_price < 0 ||
      !Number.isFinite(payload.agreed_commission) || payload.agreed_commission < 0) {
    return alert("تأكد من اسم الغرض والسعر والعمولة.");
  }

  setGoodsSaving(true);
  const saveButton=$("saveGoodsButton");
  if(saveButton){saveButton.disabled=true;saveButton.textContent="جارٍ الحفظ…";}
  try {
    const imageUrls=[];
    for(let i=0;i<images.length;i++){
      const item=images[i];if(item.saved){imageUrls.push(item.url);continue;}
      const file=await compressListingImage(item.file);
      const ext=(file.name.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'')||'jpg';
      const path='goods/'+actor.id+'/'+crypto.randomUUID()+'-'+i+'.'+ext;
      if(currentUser!==actor || !isAdmin())return;
      const {error}=await db.storage.from('listing-images').upload(path,file,{contentType:file.type,upsert:false,cacheControl:'3600'});
      if(error)throw error;
      imageUrls.push(db.storage.from('listing-images').getPublicUrl(path).data.publicUrl);
    }
    if(currentUser!==actor || !isAdmin())return;
    payload.description += imageUrls.length ? "\nصور الغرض: " + imageUrls.join(" | ") : "";
    let result;
    if (targetGoodsId !== null) {
      result = await db.from("goods").update(payload).eq("id", targetGoodsId);
    } else {
      result = await db.from("goods").insert({
        ...payload,
        status: "available",
        created_by: actor.id
      }).select("id").single();
    }
    if(currentUser!==actor)return;
    if (result.error) throw result.error;

    releaseGoodsPreviews();goodsImageItems=[];retainedGoodsImages=[];newGoodsImages=[];
    const wasEditing = targetGoodsId !== null;
    if (!wasEditing && result.data?.id) void sendPushEvent("new_goods", { goodsId: result.data.id });
    form.reset();
    editingGoodsId = null;
    $("goodsDialogTitle").textContent = "إضافة غرض جديد";
    $("saveGoodsButton").textContent = "حفظ";
    hideDialog("goodsDialog");
    await refreshData();
    alert(wasEditing ? "تم تحديث الغرض بنجاح" : "تم إضافة الغرض بنجاح");
  } catch (err) {
    if(currentUser!==actor)return;
    alert("تعذّر حفظ الغرض. تحقق من البيانات والاتصال وحاول مجدداً.");
  } finally {
    setGoodsSaving(false);
    if(saveButton){saveButton.disabled=false;saveButton.textContent=editingGoodsId ? "حفظ التعديلات" : "حفظ";}
  }
};

window.prepareInquiryDialog = function() {
  if (!isAdmin() && profile?.permissions?.can_add_inquiry === false) {
    return alert("عذراً، تم تقييد صلاحية إضافة الاستفسارات لحسابك من قبل الإدارة.");
  }

  const select = $("inquiryGoods");
  if (!select) return;
  select.replaceChildren(...(marketGoods??goods).filter(g=>g.status==='available').map(g=>new Option(g.title+' - '+money(g.asking_price),g.id)));
  if(!select.options.length)return alert('ابحث عن غرض متاح في الرئيسية أولاً.');
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
    alert("تعذّر الحفظ. تحقق من البيانات والاتصال وحاول مجدداً.");
  }
};

window.prepareSaleDialog = function(preselectedGoodsId = null) {
  if(!isAdmin())return alert("تسجيل البيع متاح للمدير النشط فقط.");
  const goodsSel = $("saleGoods");
  const repSel = $("saleRep");
  if (!goodsSel || !repSel) return;

  goodsSel.replaceChildren(...(marketGoods??goods).filter(g=>g.status==='available').map(g=>new Option(g.title,g.id)));
  if(!goodsSel.options.length)return alert('ابحث عن الغرض المتاح في الرئيسية ثم اختر تسجيل البيع.');
  if (preselectedGoodsId && goods.some(g => String(g.id) === String(preselectedGoodsId) && g.status === "available")) {
    goodsSel.value = String(preselectedGoodsId);
  }

  repSel.innerHTML = reps.filter(r => r.status !== 'banned').map(r => `
    <option value="${r.id}">${esc(r.full_name)} (@${esc(r.username || 'بدون اسم مستخدم')})</option>
  `).join("");

  showDialog("saleDialog");
};

window.deleteSaleRecord = async function(saleId) {
  if (!isAdmin()) return alert("حذف سجلات المبيعات والعمولات متاح للمدير فقط.");
  const sale = sales.find(row => String(row.id) === String(saleId));
  if (!sale) return alert("لم يتم العثور على سجل البيع. حدّث القائمة وحاول مرة أخرى.");
  if (!confirm("حذف سجل البيع والعمولة المرتبطة به نهائياً؟ لا يمكن التراجع عن هذا الإجراء.")) return;
  try {
    const { error } = await db.from("sales").delete().eq("id", saleId);
    if (error) throw error;
    sales = sales.filter(row => String(row.id) !== String(saleId));
    location.reload();
  } catch (error) {
    alert("تعذّر حذف سجل البيع. تحقق من صلاحيتك والاتصال وحاول مجدداً.");
  }
};

window.handleSaveSale = async function() {
  if(!currentUser || !db || !isAdmin())return alert('تسجيل البيع متاح للمدير النشط فقط.');
  const actor=currentUser,form=$('saleForm');
  if(!form || form.dataset.saving==='true' || !form.reportValidity())return;
  const input=new FormData(form),goodsId=input.get('goodsId'),repId=input.get('repId');
  const price=Number(input.get('price')),commission=Number(input.get('totalCommission')),share=Number(input.get('repCommission'));
  const good=goods.find(g=>String(g.id)===String(goodsId)),rep=reps.find(r=>String(r.id)===String(repId));
  if(!good || good.status!=='available' || confirmedSales.has(goodsId) || sales.some(s=>String(s.goods_id)===String(goodsId)))return alert('هذا الغرض غير متاح للبيع أو مسجل كمبيع.');
  if(!rep || !['approved','restricted'].includes(rep.status))return alert('اختر مندوباً نشطاً.');
  if(![price,commission,share].every(Number.isSafeInteger) || price<=0 || commission<0 || share<0 || share>commission)return alert('تحقق من السعر والعمولة وحصة المندوب.');
  const button=form.querySelector('button[onclick="handleSaveSale()"]');
  form.dataset.saving='true';if(button)button.disabled=true;
  let saved=false;
  try {
    const prior=await db.from('sales').select('id').eq('goods_id',goodsId).limit(1);
    if(currentUser!==actor || !isAdmin())return;
    if(prior.error)throw prior.error;
    if(!Array.isArray(prior.data))throw new Error('تعذّر التحقق من سجل البيع.');
    if(prior.data.length){confirmedSales.add(goodsId);good.status='sold';render();return alert('هذا الغرض مسجل كمبيع بالفعل. حدّث سجل المبيعات.');}
    const result=await db.from('sales').insert({goods_id:goodsId,rep_id:repId,final_price:price,
      total_commission:commission,manager_share:commission-share,rep_share:share,verified_by:actor.id}).select('id').single();
    if(result.error)throw result.error;
    if(!result.data?.id)throw new Error('لم تؤكد الخدمة نتيجة البيع؛ تحقق من السجل قبل إعادة المحاولة.');
    saved=true;confirmedSales.add(goodsId);
    if(currentUser!==actor)return;
    good.status='sold';
    const updated=await db.from('goods').update({status:'sold'}).eq('id',goodsId);
    if(currentUser!==actor)return;
    if(updated.error){render();return alert('سُجل البيع بالفعل، لكن تعذّر تحديث حالة الغرض. راجع السجل؛ لا تُسجل البيعة مرة ثانية.');}
    void sendPushEvent('sale',{saleId:result.data.id});
    form.reset();hideDialog('saleDialog');await refreshData();
    if(currentUser===actor)alert('تم تسجيل البيع بنجاح.');
  } catch(error) {
    if(currentUser!==actor)return;
    if(saved)alert('سُجل البيع؛ تعذّر إكمال تحديث العرض. راجع السجل دون إعادة البيع.');
    else {
      // An interrupted response cannot establish whether the insert committed.
      if(!error?.code){confirmedSales.add(goodsId);alert('تعذّر تأكيد النتيجة. تحقق من سجل المبيعات قبل إعادة المحاولة؛ لن نعيد الطلب تلقائياً.');}
      else alert('تعذّر تسجيل البيع. تحقق من البيانات والصلاحيات ثم حاول مجدداً.');
    }
  } finally {delete form.dataset.saving;if(button)button.disabled=false;}
};
window.markSaleCommissionPaid = async function(saleId) {
  if (!isAdmin()) return alert("تأكيد تحويل العمولات متاح للمدير فقط.");
  if(pendingPayments.has(saleId) || !currentUser || !db)return;
  const actor=currentUser;
  const sale = sales.find(item => String(item.id) === String(saleId));
  if (!sale) return alert("لم يتم العثور على سجل البيع. حدّث القائمة وحاول مجدداً.");
  if (sale.commission_paid_at) return alert("هذه العمولة مسجّلة كمحوّلة مسبقاً.");
  const rep = reps.find(item => String(item.id) === String(sale.rep_id));
  const repName = rep?.full_name || "المندوب";
  const amount = Number(sale.rep_share) || 0;
  if (!confirm(`تأكيد تحويل عمولة ${repName} بمبلغ ${money(amount)}؟\nسيُسجّل تاريخ التحويل ولن يمكن تأكيدها مرة ثانية.`)) return;

  pendingPayments.add(saleId);
  try {
    const { error } = await db.rpc("mark_sale_commission_paid", { p_sale_id: saleId });
    if (error) throw error;
    if(currentUser!==actor)return;
    sale.commission_paid_at=new Date().toISOString();
    render();
    // Notify the representative after the payout has been recorded successfully.
    void sendPushEvent("commission_paid", { saleId }).then(result => {
      if (!result?.ok) console.warn("Commission was marked paid, but push notification failed:");
    });
    await refreshData();
    alert("تم تسجيل تحويل العمولة بنجاح.");
  } catch (err) {
    if(currentUser!==actor)return;
    const message = err?.message || "خطأ غير معروف";
    if (/already|paid|previously|not found/i.test(message)) {
      await refreshData();
      return alert("لم يتم تسجيل التحويل: هذه العمولة محوّلة مسبقاً أو أن سجل البيع غير موجود.");
    }
    alert("تعذّر تسجيل تحويل العمولة. حدّث السجل للتحقق من حالته قبل المحاولة مجدداً.");
  }  finally {pendingPayments.delete(saleId);}
};
window.approveRep = async function(repId) {
  try {
    const { error } = await db.from("profiles").update({ status: 'approved' }).eq("id", repId);
    if (error) throw error;
    await refreshData();
    void sendPushEvent("rep_status", { targetUserId: repId, statusAction: "approve" });
    alert("تم قبول المندوب بنجاح");
  } catch (err) {
    alert("تعذّر القبول. تحقق من الاتصال وصلاحية حسابك وحاول مجدداً.");
  }
};

function clearAccountState() {
  ++accountGeneration;refreshInFlight=null;dataStatus('');resetMarketSession();
  if(repStatusCheckTimer)clearInterval(repStatusCheckTimer);repStatusCheckTimer=null;
  if(presenceTimer)clearInterval(presenceTimer);presenceTimer=null;
  if(typeof chatPollTimer!=='undefined'){clearInterval(chatPollTimer);chatPollTimer=null;}
  if(typeof resetChatPages==='function')resetChatPages();
  releaseGoodsPreviews();goodsImageItems=[];retainedGoodsImages=[];newGoodsImages=[];editingGoodsId=null;
  pendingPayments.clear();confirmedSales.clear();
  currentUser=null;profile=null;goods=[];sales=[];reps=[];inquiries=[];notifications=[];
  ++pushCheckGeneration;pushCheckPromise=null;pushCheckState='unknown';
  window.resetInterfaceSession?.();updateBottomAccountAvatar();
  document.querySelectorAll('input[type=password]').forEach(field=>{field.value='';});
  if($('accountName'))$('accountName').textContent='حسابي';
  if($('accountEmail'))$('accountEmail').textContent='—';
  if($('accountRole'))$('accountRole').textContent='حساب المستخدم';
  ['accountAvatar','usernameSettings','nameChangeRequestBox','myCommissionSummary'].forEach(id=>$(id)?.replaceChildren());
  document.querySelectorAll('#appView input,#appView textarea,dialog input,dialog textarea').forEach(field=>{if(!['checkbox','radio','button','submit'].includes(field.type))field.value='';});
  externalListings=[];externalListingClaims=[];pendingReps=[];nameChangeRequests=[];teamActivity=[];
  if(typeof chatPeople!=='undefined'){chatPeople=[];chatConversations=[];activeChatId=null;chatGroupId=null;chatBusy=false;chatInitActor=null;}
  ['goodsList','salesList','mySalesList','repsList','inquiriesList','externalListingsList','chatMessages','chatConversationList','goodsImagePreview','notificationsList'].forEach(id=>$(id)?.replaceChildren());
  document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
  $('appView')?.classList.add('hidden');$('authView')?.classList.add('hidden');
  $('welcomeView')?.classList.remove('hidden');$('welcomeView')?.style.removeProperty('display');
}
window.handleLogout=async function(){
  clearAccountState();
  try{if(db)await db.auth.signOut();}catch(_){alert('تم إخفاء بيانات الحساب. تحقق من الاتصال لإكمال تسجيل الخروج.');}
};

let authRecoveryBusy=false;
function recoveryMessage(message){const node=$('recoveryMessage');if(node){node.textContent=message;node.classList.toggle('hidden',!message);}}
function showPasswordRecovery(){
  clearAccountState();$('welcomeView')?.classList.add('hidden');$('authView')?.classList.remove('hidden');
  $('loginForm')?.classList.add('hidden');$('signupForm')?.classList.add('hidden');$('recoveryForm')?.classList.remove('hidden');
  $('authTitle').textContent='كلمة مرور جديدة';
}
window.handlePasswordReset=async function(){
  if(authRecoveryBusy || !db)return;
  const field=$('loginEmail'),email=field?.value.trim();
  if(!email || !field.checkValidity())return recoveryMessage('اكتب بريدك الإلكتروني الصحيح أولاً.');
  const button=$('passwordResetButton');authRecoveryBusy=true;if(button)button.disabled=true;
  try{
    const {error}=await db.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});
    if(error)throw error;
    recoveryMessage('إذا كان البريد مسجّلاً فستصلك رسالة لاستعادة كلمة المرور.');
  }catch(_){recoveryMessage('تعذّر إرسال الطلب. تحقق من الاتصال وحاول لاحقاً.');}
  finally{authRecoveryBusy=false;if(button)button.disabled=false;}
};
window.handlePasswordUpdate=async function(){
  if(authRecoveryBusy || !db)return;
  const password=$('recoveryPassword')?.value||'';
  if(password.length<8)return recoveryMessage('اختر كلمة مرور من 8 أحرف أو أكثر.');
  const button=$('passwordUpdateButton');authRecoveryBusy=true;if(button)button.disabled=true;
  try{
    const {error}=await db.auth.updateUser({password});if(error)throw error;
    await db.auth.signOut();clearAccountState();switchAuthMode('login');
    $('welcomeView')?.classList.add('hidden');$('authView')?.classList.remove('hidden');
    $('recoveryPassword').value='';recoveryMessage('تم تحديث كلمة المرور. سجّل الدخول بكلمتك الجديدة.');
  }catch(_){recoveryMessage('تعذّر تحديث كلمة المرور. قد يكون الرابط منتهياً؛ اطلب رابطاً جديداً.');}
  finally{authRecoveryBusy=false;if(button)button.disabled=false;}
};

if (db) {
  db.auth.onAuthStateChange?.((event,session)=>{
    if(event==='SIGNED_OUT' || (currentUser && session?.user && currentUser.id!==session.user.id))clearAccountState();
    if(event==='PASSWORD_RECOVERY')setTimeout(showPasswordRecovery,0);
  });
  const initialGeneration=accountGeneration;
  db.auth.getSession().then(async ({ data }) => {
    if(accountGeneration!==initialGeneration)return;
    if(INITIAL_RECOVERY){showPasswordRecovery();return;}
    if (data.session?.user) {
      await startApp(data.session.user);
      if (new URLSearchParams(window.location.search).get("sell") === "1") {
        window.showExternalListingDialog();
      }
    } else if (new URLSearchParams(window.location.search).get("sell") === "1") {
      window.showExternalListingDialog();
    }
  }).catch(()=>recoveryMessage("تعذّر استعادة الجلسة. تحقق من الاتصال.")).finally(()=>window.finishWaseetStartup?.());
}

// Stored IDs are read as data. No database value is interpolated into inline JavaScript.
document.addEventListener('click',event=>{
  const actions=[['notificationId','[data-notification-id]',id=>openNotificationItem(id)],['externalReview','[data-external-review]',id=>reviewExternalListing(id,'removed')],['externalDelete','[data-external-delete]',id=>deleteExternalListing(id)],['repApprove','[data-rep-approve]',id=>approveRep(id)],['nameReview','[data-name-review]',(id,node)=>reviewNameChangeRequest(id,node.dataset.nameApprove==='true')],['salePaid','[data-sale-paid]',id=>markSaleCommissionPaid(id)],['saleDelete','[data-sale-delete]',id=>deleteSaleRecord(id)]];
  for(const [key,selector,action] of actions){const node=event.target.closest(selector);if(node){event.preventDefault();event.stopPropagation();void action(node.dataset[key],node);return;}}
});
