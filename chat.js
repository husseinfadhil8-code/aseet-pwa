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
function chatPersonName(id) {
  return chatPeople.find(p => String(p.id) === String(id))?.full_name || "مستخدم";
}
function chatNotice(message) {
  const node = $("chatStatus");
  if (node) node.textContent = message || "";
}
window.initChatFeature = async function() {
  if (!currentUser || !db || chatBusy) return;
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
  panel.innerHTML = '<div class="chat-panel-heading">ابدأ دردشة خاصة</div>' + (options.length ? options.map(p => `
    <button type="button" class="chat-person" onclick="startPrivateChat('${p.id}')">
      <span class="chat-person-avatar">${p.role === "admin" ? "👑" : "👤"}</span>
      <span><b>${chatEscape(p.full_name || "مستخدم")}</b><small>${p.role === "admin" ? "الإدارة" : "مندوب"}</small></span>
      <span class="chat-person-arrow">‹</span>
    </button>`).join("") : '<div class="chat-empty">ماكو مستخدمين متاحين.</div>');
};
window.startPrivateChat = async function(personId) {
  if (!currentUser || !personId) return;
  try {
    const {data,error} = await db.rpc("create_direct_chat",{p_recipient_id:personId});
    if (error) throw error;
    activeChatId = data;
    $("chatPeoplePanel")?.classList.add("hidden");
    await loadChatConversations();
    await loadChatMessages(activeChatId);
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
      return `<div class="chat-message-row ${mine ? "chat-message-mine" : "chat-message-theirs"}">${!mine ? author : ""}
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
    const {error} = await db.from("chat_messages").insert({
      conversation_id:activeChatId, sender_id:currentUser.id, body
    });
    if (error) throw error;
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
