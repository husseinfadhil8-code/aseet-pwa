/* Waseet chat: private conversations and the representatives' group. */
let chatGroupId = null;
let chatPeople = [];
let chatConversations = [];
let activeChatId = null;
let chatPollTimer = null;
let chatBusy = false;
let chatConversationRequest = 0;

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
  const person = chatPerson(id);
  return person?.full_name || "مستخدم";
}
function chatVerifiedName(id) {
  const person = chatPerson(id);
  const safeName = chatEscape(chatPersonName(id));
  return person?.role === "admin"
    ? `${safeName} <span title="مدير وسيط موثّق" aria-label="مدير وسيط موثّق" style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;margin-inline-start:4px;border-radius:50%;background:#2583f5;color:#fff;font-size:10px;font-weight:900;line-height:1;vertical-align:middle;">✓</span>`
    : safeName;
}
function chatAvatar(person, size = 36) {
  const name = String(person?.full_name || "مستخدم").trim();
  const fallback = person?.role === "admin" ? "👑" : (name.charAt(0) || "م");
  const base = `width:${size}px;height:${size}px;flex:0 0 ${size}px;border-radius:50%;object-fit:cover;display:block;`;
  const avatar=getSafeImageUrl(person?.avatar_url);
  return avatar
    ? `<img src="${chatEscape(avatar)}" alt="صورة ${chatEscape(name)}" loading="lazy" style="${base}background:#e8edf4">`
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
    chatNotice("الدردشة غير متاحة حالياً. حاول لاحقاً أو تواصل مع إدارة وسيط.");
  } finally {
    chatBusy = false;
  }
};

window.loadChatConversations = async function() {
  if (!currentUser || !db) return;
  const list = $("chatConversationList");
  if (!list) return;
  const actor = currentUser;
  const requestId = ++chatConversationRequest;
  const isCurrentRequest = () => currentUser === actor && requestId === chatConversationRequest;
  try {
    const {data: memberships, error: memberError} = await db.from("chat_members")
      .select("conversation_id,last_read_at").eq("user_id", actor.id);
    if (!isCurrentRequest()) return;
    if (memberError) throw memberError;
    const ids = (memberships || []).map(m => m.conversation_id);
    if (!ids.length) {
      chatConversations = [];
      activeChatId = null;
      resetChatPages();
      list.innerHTML = '<div class="chat-empty">ماكو محادثات لحد الآن.</div>';
      return;
    }
    const [{data: conversations, error: conversationError}, {data: messages, error: messagesError}] = await Promise.all([
      db.from("chat_conversations").select("id,kind,title,created_at").in("id", ids).order("created_at",{ascending:false}),
      db.from("chat_messages").select("id,conversation_id,sender_id,body,created_at").in("conversation_id",ids).order("created_at",{ascending:false}).limit(250)
    ]);
    if (!isCurrentRequest()) return;
    if (conversationError) throw conversationError;
    if (messagesError) throw messagesError;

    const {data: allMembers, error: allMembersError} = await db.from("chat_members")
      .select("conversation_id,user_id,last_read_at").in("conversation_id",ids);
    if (!isCurrentRequest()) return;
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
    if (!isCurrentRequest()) return;
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
    return `<button type="button" class="chat-thread ${c.id === activeChatId ? "chat-thread-active" : ""}" data-chat-thread="${chatEscape(c.id)}">
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
    <button type="button" class="chat-person" data-chat-person="${chatEscape(p.id)}">
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

let privateChatOpening = false;
window.startPrivateChat = async function(personId) {
  if (!currentUser || !personId || personId === currentUser.id || privateChatOpening) return;
  privateChatOpening = true;
  const actor = currentUser.id;
  try {
    const existing = chatConversations.find(c => c.kind === "direct" && c.otherUserId === personId);
    const {data,error} = existing ? {data:existing.id} : await db.rpc("create_direct_chat",{p_recipient_id:personId});
    if (currentUser?.id !== actor) return;
    if (error) throw error;
    activeChatId = data;
    $("chatPeoplePanel")?.classList.add("hidden");
    $("chatPersonProfileDialog")?.close();
    await loadChatConversations();
    if (currentUser?.id !== actor) return;
    await openChatConversation(data);
  } catch(err) {
    if (currentUser?.id === actor) alert("تعذّر بدء المحادثة: " + (err.message || "حاول مرة أخرى"));
  } finally { privateChatOpening = false; }
};
const chatDrafts=new Map(),chatReadPositions=new Map();
let chatInputContext=null;
const chatContextKey=(actor,id)=>JSON.stringify([actor,id]);
function saveChatContext(){
  if(!chatInputContext || currentUser?.id!==chatInputContext.actor)return;
  const key=chatContextKey(chatInputContext.actor,chatInputContext.id),input=$('chatMessageInput');
  if(input?.value)chatDrafts.set(key,input.value);else chatDrafts.delete(key);
  chatReadPositions.set(key,$('chatMessages')?.scrollTop||0);
}
document.addEventListener('input',event=>{if(event.target.id==='chatMessageInput')saveChatContext();});
window.openChatConversation=async function(id){
  if(!currentUser)return;
  saveChatContext();const actor=currentUser;activeChatId=id;
  chatInputContext={actor:actor.id,id};
  if($('chatMessageInput'))$('chatMessageInput').value=chatDrafts.get(chatContextKey(actor.id,id))||'';
  $('chatConversationPanel')?.classList.remove('hidden');$('chatListPanel')?.classList.add('hidden');
  await loadChatMessages(id);
  if(currentUser!==actor || activeChatId!==id)return;
  const key=chatContextKey(actor.id,id);
  if(chatReadPositions.has(key) && $('chatMessages'))$('chatMessages').scrollTop=chatReadPositions.get(key);
  renderChatConversationList();
};
window.backToChatList=function(){
  saveChatContext();activeChatId=null;
  $('chatConversationPanel')?.classList.add('hidden');$('chatListPanel')?.classList.remove('hidden');
  void loadChatConversations();
};
const CHAT_PAGE_SIZE=50;
const chatMessagePages=new Map();
const chatMessageLoads=new Map();
let chatPageGeneration=0;
function resetChatPages(){++chatPageGeneration;chatMessagePages.clear();chatMessageLoads.clear();chatDrafts.clear();chatReadPositions.clear();chatInputContext=null;if($('chatMessageInput'))$('chatMessageInput').value='';}
function subMillisecond(value){
  const fraction=/\.(\d+)(?:Z|[+-]\d\d(?::?\d\d)?)$/.exec(String(value))?.[1] || '';
  return Number(fraction.slice(3).padEnd(6,'0'));
}
function compareMessages(a,b){
  return Date.parse(a.created_at)-Date.parse(b.created_at) || subMillisecond(a.created_at)-subMillisecond(b.created_at)
    || String(a.id).localeCompare(String(b.id));
}
function renderMessagePage(id,quiet=false,prepend=false){
  const state=chatMessagePages.get(id);if(!state)return;
  const rows=state.rows;
  const conversation=chatConversations.find(c=>c.id===id);
  const messagesBox=$("chatMessages");if(!messagesBox)return;
  const oldScroll=messagesBox.scrollTop,oldHeight=messagesBox.scrollHeight;
  const nearBottom=oldHeight-messagesBox.clientHeight-oldScroll<100;
  const boxTop=messagesBox.getBoundingClientRect().top;
  const firstVisible=[...messagesBox.querySelectorAll('[data-message-id]')].find(node=>node.getBoundingClientRect().bottom>boxTop);
  const anchor=firstVisible?{id:firstVisible.dataset.messageId,top:firstVisible.getBoundingClientRect().top}:null;
    messagesBox.innerHTML = rows.length ? rows.map((m,index) => {
      const mine = m.sender_id === currentUser.id;
      const previous = rows[index-1];
      const showAuthor = !previous || previous.sender_id !== m.sender_id ||
        chatDate(previous.created_at) !== chatDate(m.created_at) ||
        Date.parse(m.created_at)-Date.parse(previous.created_at)>300000;
      return `<div data-message-id="${chatEscape(m.id)}" class="chat-message-row ${mine ? "chat-message-mine" : "chat-message-theirs"}">${conversation?.kind === "group" && showAuthor ? `<button type="button" class="chat-message-author-row chat-author-button ${mine ? "chat-author-mine" : ""}" data-chat-message-person="${chatEscape(m.sender_id)}" ${mine ? "disabled" : ""}>${chatAvatar(chatPerson(m.sender_id),30)}<span class="chat-message-author">${chatVerifiedName(m.sender_id)}</span></button>` : ""}
        <div class="chat-bubble"><div class="chat-message-body">${chatEscape(m.body).replace(/\n/g,"<br>")}</div>
        <div class="chat-message-time">${chatEscape(chatTime(m.created_at))}</div></div></div>`;
    }).join("") : '<div class="chat-empty chat-message-empty">ابدأ المحادثة برسالة ترحيب 👋</div>';
    if(prepend || (quiet && !nearBottom)){
      const node=anchor?[...messagesBox.querySelectorAll('[data-message-id]')].find(row=>row.dataset.messageId===anchor.id):null;
      if(node)messagesBox.scrollTop+=node.getBoundingClientRect().top-anchor.top;
      else if(prepend)messagesBox.scrollTop=oldScroll+messagesBox.scrollHeight-oldHeight;
    } else messagesBox.scrollTop = messagesBox.scrollHeight;

  const button=$("loadOlderMessagesButton");
  if(button){button.classList.toggle('hidden',!state.hasOlder && !state.gapCursor);button.disabled=false;button.textContent=state.gapCursor?'تحميل الرسائل الفائتة':'تحميل الرسائل الأقدم';}
}
async function fetchMessagePage(id,{quiet=false,older=false}={}){
  if(!currentUser || !id || !db)return;
  if(chatMessageLoads.has(id))return chatMessageLoads.get(id);
  const actor=currentUser.id,generation=chatPageGeneration;
  const initialState=chatMessagePages.get(id);
  if(older && (!initialState || (!initialState.hasOlder && !initialState.gapCursor)))return;
  const loading=(async()=>{
    const state=chatMessagePages.get(id);
    const gap=older && Boolean(state?.gapCursor);
    const cursor=older ? (state.gapCursor || state.olderCursor) : null;
    let query=db.from('chat_messages').select('id,conversation_id,sender_id,body,created_at')
      .eq('conversation_id',id).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(CHAT_PAGE_SIZE);
    if(cursor)query=query.or(pageCursorFilter(cursor));
    const {data,error}=await query;if(error)throw error;
    if(currentUser?.id!==actor || activeChatId!==id || generation!==chatPageGeneration)return;
    const incoming=data||[];
    if(incoming.some(row=>row.conversation_id && row.conversation_id!==id))throw new Error('Unexpected conversation');
    const known=new Set((state?.rows||[]).map(row=>row.id));
    const overlap=incoming.some(row=>known.has(row.id));
    const oldest=incoming.at(-1)||cursor;
    const next=state || {rows:[],hasOlder:false,olderCursor:null,gapCursor:null};
    if(!state){next.hasOlder=incoming.length===CHAT_PAGE_SIZE;next.olderCursor=oldest;}
    else if(older && gap){next.gapCursor=overlap || incoming.length<CHAT_PAGE_SIZE ? null : oldest;}
    else if(older){next.hasOlder=incoming.length===CHAT_PAGE_SIZE;next.olderCursor=oldest;}
    else if(incoming.length===CHAT_PAGE_SIZE && !overlap && state.rows.length){next.gapCursor=oldest;}
    next.rows=[...new Map([...next.rows,...incoming].map(row=>[row.id,row])).values()].sort(compareMessages);
    chatMessagePages.set(id,next);
    renderMessagePage(id,quiet,older);
    if(!older){
      const result=await db.from('chat_members').update({last_read_at:new Date().toISOString()}).eq('conversation_id',id).eq('user_id',actor);
      if(result?.error)throw result.error;
      if(currentUser?.id!==actor || activeChatId!==id || generation!==chatPageGeneration)return;
      const conversation=chatConversations.find(c=>c.id===id);if(conversation)conversation.unread=0;
      renderChatConversationList();
    }
  })();
  chatMessageLoads.set(id,loading);
  try{await loading;}finally{if(chatMessageLoads.get(id)===loading)chatMessageLoads.delete(id);}
}
window.loadChatMessages=async function(id,quiet=false){
  const conversation=chatConversations.find(c=>c.id===id);
  if($("chatActiveTitle"))$("chatActiveTitle").textContent=conversation?.displayTitle || 'الدردشة';
  if($("chatActiveSubtitle"))$("chatActiveSubtitle").textContent=conversation?.kind==='group'?'رسائل مشتركة مع فريق وسيط':'محادثة خاصة';
  try{await fetchMessagePage(id,{quiet});chatNotice('');}
  catch(_){chatNotice('تعذّر تحميل الرسائل. أعد المحاولة؛ بقيت الرسائل المحمّلة محفوظة في العرض.');}
};
window.loadOlderMessages=async function(){
  const id=activeChatId;if(!id)return;
  const button=$("loadOlderMessagesButton");if(button){button.disabled=true;button.textContent='جارٍ تحميل الرسائل…';}
  try{await fetchMessagePage(id,{older:true,quiet:true});chatNotice('');}
  catch(_){chatNotice('تعذّر تحميل الرسائل الأقدم. حاول مجدداً.');}
  finally{if(button && activeChatId===id){button.disabled=false;button.textContent='تحميل الرسائل الأقدم';}}
};
window.sendChatMessage = async function() {
  if (!currentUser || !activeChatId) return;
  const input = $("chatMessageInput");
  const body = String(input?.value || "").trim();
  const conversationId = activeChatId;
  const senderId = currentUser.id;
  if (!body) return;
  if (body.length > 2000) return alert("الرسالة طويلة جداً؛ الحد الأقصى 2000 حرف.");
  const button = $("chatSendButton");
  if (button?.disabled) return;
  if (button) { button.disabled = true; button.textContent = "…"; }
  try {
    const {data: savedMessage, error} = await db.from("chat_messages").insert({
      conversation_id:conversationId, sender_id:senderId, body
    }).select("id").single();
    if (error) throw error;
    if (savedMessage?.id) {
      void sendPushEvent("chat_message", {messageId:savedMessage.id}).then(result => {
        if (!result?.ok) console.warn("Chat message saved, but push notification failed:", result?.error || result);
      });
    }
    if (currentUser?.id === senderId) {
      const key=chatContextKey(senderId,conversationId);
      if(chatDrafts.get(key)?.trim()===body)chatDrafts.delete(key);
      if (activeChatId === conversationId && input?.value.trim() === body) input.value = "";
      await loadChatConversations();
      if (activeChatId === conversationId) {
        await loadChatMessages(conversationId);
        input?.focus();
      }
    }
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

// IDs remain inert attribute values; server RPC/RLS still enforce conversation access.
document.addEventListener('click', event => {
  const thread = event.target.closest('[data-chat-thread]');
  if (thread) { void openChatConversation(thread.dataset.chatThread); return; }
  const person = event.target.closest('[data-chat-person]');
  if (person) { openChatPersonProfile(person.dataset.chatPerson); return; }
  const sender = event.target.closest('[data-chat-message-person]');
  if (sender && !sender.disabled) void startPrivateChat(sender.dataset.chatMessagePerson);
});
