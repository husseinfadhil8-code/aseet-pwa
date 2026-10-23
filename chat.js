/* Waseet chat: private conversations and the representatives' group. */
let chatGroupId = null;
let chatPeople = [];
let chatConversations = [];
let activeChatId = null;
let chatPollTimer = null;
let chatBusy = false;

function chatEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[ch]);
}
function chatTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ar-IQ", {hour:"2-digit",minute:"2-digit"});
}
function chatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("ar-IQ", {day:"numeric",month:"short"});
}
function chatPerson(id) {
  return chatPeople.find(p => String(p.id) === String(id)) || null;
}
function chatPersonName(id) {
  return chatPerson(id)?.full_name || "مستخدم";
}
function chatAvatar(person, size = 36) {
  const name = String(person?.full_name || "مستخدم").trim();
  const fallback = person?.role === "admin" ? "👑" : (name.charAt(0) || "م");
  const base = `width:${size}px;height:${size}px;flex:0 0 ${size}px;border-radius:50%;object-fit:cover;display:block;`;
  return person?.avatar_url
    ? `<img src="${chatEscape(person.avatar_url)}" alt="صورة ${chatEscape(name)}" loading="lazy" style="${base}background:#e8edf4">`
    : `<span aria-label="الصورة الشخصية" style="${base}display:flex;align-items:center;justify-content:center;background:#e8edf4;color:#173452;font-weight:900;font-size:${Math.max(12,Math.round(size*.42))}px">${chatEscape(fallback)}</span>`;
}
function chatNotice(message) {
  const node = $("chatStatus");
  if (node) node.textContent = message || "";
}
window.initChatFeature = async function() {
  if (!currentUser || !db || chatBusy) return;
  if (!chatPollTimer) {
    chatPollTimer = setInterval(() => {
      if (document.visibilityState === "visible" && !$("chatView")?.classList.contains("hidden")) {
        void refreshChat();
      }
    }, 6000);
  }
  chatBusy = true;
  try {
    const [{data: groupId, error: groupError}, {data: people, error: peopleError}] = await Promise.all([
      db.rpc("ensure_chat_ready"),
      db.rpc("get_chat_people")
    ]);
    if (groupError) throw groupError;
    if (peopleError) throw peopleError;
    chatGroupId = groupId;
    chatPeople = people || [];
    await loadChatConversations();
  } catch (err) {
    console.warn("Chat setup failed:", err);
    chatNotice("الدردشة تحتاج تفعيل قاعدة البيانات. شغّل ملف supabase/chat.sql في Supabase أولاً.");
  } finally {
    chatBusy = false;
  }
};

window.loadChatConversations = async function() {
  if (!currentUser || !db) return;
  const list = $("chatConversationList");
  if (!list) return;
  try {
    const {data: memberships, error: memberError} = await db.from("chat_members")
      .select("conversation_id,last_read_at").eq("user_id", currentUser.id);
    if (memberError) throw memberError;
    const ids = (memberships || []).map(m => m.conversation_id);
    if (!ids.length) {
      list.innerHTML = '<div class="chat-empty">ماكو محادثات لحد الآن.</div>';
      return;
    }
    const [{data: conversations, error: conversationError}, {data: messages, error: messagesError}] = await Promise.all([
      db.from("chat_conversations").select("id,kind,title,created_at").in("id", ids).order("created_at",{ascending:false}),
      db.from("chat_messages").select("id,conversation_id,sender_id,body,created_at").in("conversation_id",ids).order("created_at",{ascending:false}).limit(250)
    ]);
    if (conversationError) throw conversationError;
    if (messagesError) throw messagesError;

    const {data: allMembers, error: allMembersError} = await db.from("chat_members")
      .select("conversation_id,user_id,last_read_at").in("conversation_id",ids);
    if (allMembersError) throw allMembersError;

    chatConversations = (conversations || []).map(c => {
      const mine = (memberships || []).find(m => m.conversation_id === c.id);
      const members = (allMembers || []).filter(m => m.conversation_id === c.id);
      const other = members.find(m => m.user_id !== currentUser.id);
      const last = (messages || []).find(m => m.conversation_id === c.id);
      const unread = (messages || []).filter(m => m.conversation_id === c.id &&
        m.sender_id !== currentUser.id && new Date(m.created_at).getTime() > new Date(mine?.last_read_at || 0).getTime()).length;
      return {...c, otherUserId: other?.user_id, displayTitle: c.kind === "group" ? (c.title || "مجموعة المندوبين") : chatPersonName(other?.user_id),
        lastMessage: last, unread};
    }).sort((a,b) => new Date(b.lastMessage?.created_at || b.created_at) - new Date(a.lastMessage?.created_at || a.created_at));

    if (activeChatId && !chatConversations.some(c => c.id === activeChatId)) activeChatId = null;
    renderChatConversationList();
    if (activeChatId) await loadChatMessages(activeChatId, true);
  } catch (err) {
    console.error("Load chats failed:", err);
    list.innerHTML = '<div class="chat-empty">تعذّر تحميل المحادثات. تأكد من تشغيل ملف قاعدة بيانات الدردشة في Supabase.</div>';
  }
};

function renderChatConversationList() {
  const list = $("chatConversationList");
  if (!list) return;
  if (!chatConversations.length) {
    list.innerHTML = '<div class="chat-empty">جارٍ تجهيز مجموعة المندوبين…</div>';
    return;
  }
  list.innerHTML = chatConversations.map(c => {
    const isGroup = c.kind === "group";
    const preview = c.lastMessage ? (c.lastMessage.sender_id === currentUser.id ? "أنت: " : "") + c.lastMessage.body : (isGroup ? "ابدأ الحديث مع الفريق" : "ابدأ المحادثة");
    return `<button type="button" class="chat-thread ${c.id === activeChatId ? "chat-thread-active" : ""}" onclick="openChatConversation('${c.id}')">
      <div class="chat-thread-avatar">${isGroup ? "👥" : chatEscape((c.displayTitle || "م").trim().charAt(0))}</div>
      <div class="chat-thread-copy"><div class="chat-thread-title">${chatEscape(c.displayTitle)}</div>
      <div class="chat-thread-preview">${chatEscape(preview)}</div></div>
      <div class="chat-thread-meta"><span>${chatEscape(chatTime(c.lastMessage?.created_at || c.created_at))}</span>${c.unread ? `<b class="chat-unread">${c.unread > 99 ? "99+" : c.unread}</b>` : ""}</div>
    </button>`;
  }).join("");
}

window.showChatPeople = async function() {
  if (!currentUser) return;
  const panel = $("chatPeoplePanel");
  if (!panel) return;
  if (!chatPeople.length) {
    const {data,error} = await db.rpc("get_chat_people");
    if (error) return alert("تعذّر تحميل قائمة المستخدمين: " + error.message);
    chatPeople = data || [];
  }
  const options = chatPeople.filter(p => p.id !== currentUser.id);
  panel.classList.toggle("hidden");
  if (panel.classList.contains("hidden")) return;
  panel.innerHTML = '<div class="chat-panel-heading">ملفات المندوبين والمراسلة الخاصة</div>' + (options.length ? options.map(p => `
    <button type="button" class="chat-person" onclick="openChatPersonProfile('${p.id}')">
      <span class="chat-person-avatar" style="overflow:hidden;border-radius:50%;padding:0">${chatAvatar(p,37)}</span>
      <span style="flex:1;min-width:0;text-align:right"><b>${chatEscape(p.full_name || "مستخدم")}</b><small>${p.role === "admin" ? "الإدارة" : "مندوب"} · @${chatEscape(p.username || "بدون اسم مستخدم")}</small></span>
      <span class="chat-person-arrow">عرض الملف ‹</span>
    </button>`).join("") : '<div class="chat-empty">ماكو مستخدمين متاحين.</div>');
};

window.openChatPersonProfile = function(personId) {
  const person = chatPeople.find(p => String(p.id) === String(personId));
  if (!person) return alert("ما لكيت ملف هذا المستخدم. حدّث قائمة المندوبين وحاول مرة ثانية.");
  let dialog = $("chatPersonProfileDialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "chatPersonProfileDialog";
    dialog.style.cssText = "width:min(420px,calc(100% - 28px));border:0;border-radius:18px;padding:0;box-shadow:0 20px 60px #0f172a40;color:#172033;";
    dialog.innerHTML = `
      <div style="padding:18px;background:linear-gradient(135deg,#10233f,#1d426c);color:white;display:flex;align-items:center;gap:12px">
        <div id="chatProfileAvatar" style="width:54px;height:54px;border-radius:50%;display:grid;place-items:center;background:#ffffff22;font-size:25px;border:1px solid #ffffff55">👤</div>
        <div style="min-width:0;flex:1"><div id="chatProfileName" style="font-size:18px;font-weight:900;overflow-wrap:anywhere"></div><div id="chatProfileRole" style="font-size:12px;opacity:.85;margin-top:4px"></div></div>
        <button type="button" onclick="document.getElementById('chatPersonProfileDialog').close()" aria-label="إغلاق" style="border:0;background:transparent;color:white;font-size:25px;padding:0 4px">×</button>
      </div>
      <div style="padding:18px">
        <div style="font-size:12px;color:#64748b;margin-bottom:5px">اسم المستخدم</div>
        <div id="chatProfileUsername" style="font-weight:800;overflow-wrap:anywhere;margin-bottom:18px"></div>
        <div style="font-size:12px;color:#64748b;line-height:1.8;margin-bottom:15px">تقدر تراسل هذا المستخدم برسالة خاصة. المحادثة ما تظهر لبقية أعضاء المجموعة.</div>
        <button id="chatProfileMessageButton" type="button" class="btn-navy" style="width:100%">💬 مراسلة خاصة</button>
        <button type="button" onclick="document.getElementById('chatPersonProfileDialog').close()" class="btn-navy" style="width:100%;margin-top:8px;background:#64748b">إغلاق</button>
      </div>`;
    document.body.appendChild(dialog);
    dialog.addEventListener("click", event => {
      if (event.target === dialog) dialog.close();
    });
  }
  $("chatProfileAvatar").textContent = person.role === "admin" ? "👑" : (String(person.full_name || "م").trim().charAt(0) || "م");
  $("chatProfileName").textContent = person.full_name || "مستخدم";
  $("chatProfileRole").textContent = person.role === "admin" ? "إدارة وسيط" : "مندوب وسيط";
  $("chatProfileUsername").textContent = person.username ? "@" + person.username : "غير محدد";
  $("chatProfileMessageButton").onclick = () => {
    dialog.close();
    void window.startPrivateChat(person.id);
  };
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
};

window.startPrivateChat = async function(personId) {
  if (!currentUser || !personId) return;
  try {
    const {data,error} = await db.rpc("create_direct_chat",{p_recipient_id:personId});
    if (error) throw error;
    activeChatId = data;
    $("chatPeoplePanel")?.classList.add("hidden");
    $("chatPersonProfileDialog")?.close();
    await loadChatConversations();
    await openChatConversation(activeChatId);
  } catch(err) {
    alert("تعذّر بدء المحادثة: " + (err.message || "حاول مرة أخرى"));
  }
};
window.openChatConversation = async function(id) {
  activeChatId = id;
  const panel = $("chatConversationPanel");
  const listPanel = $("chatListPanel");
  if (panel) panel.classList.remove("hidden");
  if (listPanel) listPanel.classList.add("hidden");
  await loadChatMessages(id);
  renderChatConversationList();
};
window.backToChatList = function() {
  activeChatId = null;
  $("chatConversationPanel")?.classList.add("hidden");
  $("chatListPanel")?.classList.remove("hidden");
  void loadChatConversations();
};
window.loadChatMessages = async function(id, quiet = false) {
  if (!currentUser || !id || !db) return;
  const conversation = chatConversations.find(c => c.id === id);
  const messagesBox = $("chatMessages");
  const heading = $("chatActiveTitle");
  const subtitle = $("chatActiveSubtitle");
  if (!messagesBox) return;
  if (heading) heading.textContent = conversation?.displayTitle || (id === chatGroupId ? "مجموعة المندوبين" : "الدردشة");
  if (subtitle) subtitle.textContent = conversation?.kind === "group" ? "رسائل مشتركة مع فريق وسيط" : "محادثة خاصة";
  try {
    const {data,error} = await db.from("chat_messages").select("id,conversation_id,sender_id,body,created_at")
      .eq("conversation_id",id).order("created_at",{ascending:true}).limit(150);
    if (error) throw error;
    const oldScroll = messagesBox.scrollTop;
    const nearBottom = messagesBox.scrollHeight - messagesBox.clientHeight - oldScroll < 100;
    messagesBox.innerHTML = (data || []).length ? data.map(m => {
      const mine = m.sender_id === currentUser.id;
      const author = conversation?.kind === "group" && !mine ? `<div class="chat-message-author">${chatEscape(chatPersonName(m.sender_id))}</div>` : "";
      return `<div class="chat-message-row ${mine ? "chat-message-mine" : "chat-message-theirs"}">${conversation?.kind === "group" ? `<div class="chat-message-author-row ${mine ? "chat-author-mine" : ""}">${chatAvatar(chatPerson(m.sender_id),30)}<span class="chat-message-author">${chatEscape(chatPersonName(m.sender_id))}</span></div>` : ""}
        <div class="chat-bubble"><div class="chat-message-body">${chatEscape(m.body).replace(/\n/g,"<br>")}</div>
        <div class="chat-message-time">${chatEscape(chatTime(m.created_at))}</div></div></div>`;
    }).join("") : '<div class="chat-empty chat-message-empty">ابدأ المحادثة برسالة ترحيب 👋</div>';
    if (!quiet || nearBottom) messagesBox.scrollTop = messagesBox.scrollHeight;
    await db.from("chat_members").update({last_read_at:new Date().toISOString()})
      .eq("conversation_id",id).eq("user_id",currentUser.id);
    const active = chatConversations.find(c => c.id === id);
    if (active) active.unread = 0;
    renderChatConversationList();
  } catch(err) {
    if (!quiet) messagesBox.innerHTML = '<div class="chat-empty">تعذّر تحميل الرسائل. ' + chatEscape(err.message || "") + '</div>';
  }
};
window.sendChatMessage = async function() {
  if (!currentUser || !activeChatId) return;
  const input = $("chatMessageInput");
  const body = String(input?.value || "").trim();
  if (!body) return;
  if (body.length > 2000) return alert("الرسالة طويلة جداً؛ الحد الأقصى 2000 حرف.");
  const button = $("chatSendButton");
  if (button) { button.disabled = true; button.textContent = "…"; }
  try {
    const {data: savedMessage, error} = await db.from("chat_messages").insert({
      conversation_id:activeChatId, sender_id:currentUser.id, body
    }).select("id").single();
    if (error) throw error;
    if (savedMessage?.id) {
      void sendPushEvent("chat_message", {messageId:savedMessage.id}).then(result => {
        if (!result?.ok) console.warn("Chat message saved, but push notification failed:", result?.error || result);
      });
    }
    input.value = "";
    await loadChatMessages(activeChatId);
    await loadChatConversations();
    input?.focus();
  } catch(err) {
    alert("تعذّر إرسال الرسالة: " + (err.message || "تحقق من إعداد الدردشة في Supabase"));
  } finally {
    if (button) { button.disabled = false; button.textContent = "إرسال"; }
  }
};
window.refreshChat = async function() {
  await loadChatConversations();
  if (activeChatId) await loadChatMessages(activeChatId,true);
};
document.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && event.target?.id === "chatMessageInput") {
    event.preventDefault();
    void sendChatMessage();
  }
});
