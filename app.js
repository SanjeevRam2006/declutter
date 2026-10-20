/* Back to Center — conversation state and browser-local history. */
(function () {
  "use strict";

  var STORAGE_KEY = "back_to_center_conversations_v1";
  var LEGACY_KEY = "back_to_center_sessions_v1";
  var DRAFT_KEY = "back_to_center_drafts_v1";

  var $ = function (id) { return document.getElementById(id); };

  var els = {};
  ["homeView", "homeEntry", "homeInput", "chatView", "thread", "promptChips", "composer", "composerInput", "sendBtn",
    "emptyError", "storageWarning", "responseStatus", "accountNudge", "nudgeSignup", "nudgeDismiss", "retryBtn", "privacyBtn", "privacyModal", "privacyCloseBtn",
    "historyList", "historyCount", "emptyHistory", "deleteAllBtn", "brandHome",
    "historySearch", "clearSearchBtn", "activeChatsBtn", "pinnedOnlyBtn", "archivedBtn", "exportBtn", "exportCurrentBtn", "shareCurrentBtn", "copyLinkBtn", "importBtn", "importInput", "draftStatus", "clearDraftBtn", "charCount", "focusBtn", "sidebarBtn", "historyDrawer", "historyDrawerToggle", "historyDrawerCloseSlider", "historyDrawerScrim", "focusScreen", "focusBackBtn", "countdownModeBtn", "stopwatchModeBtn", "focusTime", "focusState", "focusPresets", "focusDescription", "focusStartBtn", "focusResetBtn", "focusNotice", "installBtn", "themeBtn", "takeaway", "takeawayText", "clearTakeawayBtn", "privateNote", "noteStatus", "undoDeleteBtn", "deleteCurrentBtn", "shortcutOverlay", "closeShortcutsBtn", "checkHealthBtn", "healthResult", "chatStats", "togglePromptsBtn", "textSmallerBtn", "textResetBtn", "textLargerBtn", "timestampsBtn", "accountGreeting", "homeAccountGreeting", "accountStatus", "loginBtn", "signupBtn", "logoutBtn", "headerAccountBtn", "headerAccountLabel", "saveAccountChatBtn", "syncAccountChatsBtn", "accountSavedList", "authModal", "authModeLabel", "authTitle", "authCloseBtn", "authForm", "authEmail", "authEmailRow", "authUsername", "authUsernameRow", "authPasswordRow", "authPassword", "confirmPasswordRow", "authConfirmPassword", "authError", "authSubmitBtn", "authResetBtn", "authSwitchBtn", "profileModal", "profileTitle", "profileCloseBtn", "profileUsername", "profileEmail", "changePasswordToggle", "changePasswordForm", "currentPassword", "newPassword", "confirmNewPassword", "profileError", "changePasswordBtn", "profileLogoutBtn"
  ].forEach(function (id) { els[id] = $(id); });

  var convos = [];
  var currentId = null;
  var accountUser = null;
  var accountSyncInFlight = null;
  var accountSyncQueued = false;
  var authMode = "login";
  var accountPromptReady = false;
  var authPromptShown = false;
  var ACCOUNT_PROMPT_USER_TURNS = 10;
  var sending = false;
  var editingIndex = null;
  var lastDeleted = null;
  var pinnedOnly = false;
  var archivedOnly = false;
  var deferredInstall = null;
  var timestampsOn = true;
  var textScale = 1;
  var FOCUS_KEY = "back_to_center_focus_timer_v1";
  var focusTimer = { mode: "countdown", durationMs: 25 * 60 * 1000, elapsedMs: 0, running: false, startedAt: null, completed: false, description: "" };
  var focusTick = null;

  /* ---------- storage ---------- */
  function loadConvos() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter(function (c) {
          return c && typeof c.id === "string" && Array.isArray(c.messages) && c.messages.every(function (m) {
            return m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string";
          });
        });
      }
    } catch (err) {
      showStorageWarning("We couldn't read your saved chats (browser storage is unavailable or full). You can still talk — saving is paused.");
      return [];
    }
    // One-time migration from the older single-shot session format.
    try {
      var legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        var old = JSON.parse(legacy);
        if (Array.isArray(old) && old.length) {
          var migrated = old.map(function (s) {
            var msgs = [{ role: "user", text: s.input || "", at: s.createdAt || Date.now() }];
            var a = s.analysis || {};
            var reply = a.nextStep || a.summary || "";
            if (reply) msgs.push({ role: "assistant", text: reply, at: s.createdAt || Date.now() });
            return { id: typeof s.id === "string" ? s.id : uid(), createdAt: s.createdAt || Date.now(), updatedAt: s.createdAt || Date.now(), messages: msgs, openQuestionKey: null, askedKeys: [] };
          }).filter(function (c) { return c.messages.length && c.messages[0].text; });
          persistConvos(migrated);
          return migrated;
        }
      }
    } catch (err) { /* migration is best-effort; ignore */ }
    return [];
  }

  function persistConvos(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      if (els.storageWarning) els.storageWarning.hidden = true;
      return true;
    } catch (err) {
      showStorageWarning("We couldn't save to this browser (storage may be full or blocked). Your current chat is still on screen.");
      return false;
    }
  }

  function showStorageWarning(msg) {
    els.storageWarning.textContent = msg;
    els.storageWarning.hidden = false;
  }

  function uid() {
    return "c_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
  }

  function current() {
    return convos.filter(function (c) { return c.id === currentId; })[0] || null;
  }

  function save() {
    persistConvos(convos);
    renderHistory();
    if (accountUser && current()) queueAccountChat(current());
  }

  function accountChatId(c) {
    if (!c || typeof c.id !== "string") return "";
    if (c.accountId) return String(c.accountId);
    return c.id.indexOf("account_") === 0 ? c.id.slice("account_".length) : c.id;
  }

  function isAccountSynced(c) {
    return Boolean(c && (c.accountSynced || c.accountId || (typeof c.id === "string" && c.id.indexOf("account_") === 0)));
  }

  function markAccountSynced(c, remoteId) {
    if (!c) return;
    c.accountSynced = true;
    c.accountId = String(remoteId || accountChatId(c));
  }

  function queueAccountChat(c) {
    if (!accountUser || !c || !c.messages || !c.messages.length) return;
    accountSyncQueued = true;
    if (accountSyncInFlight) return;
    setTimeout(function () {
      if (!accountSyncQueued || accountSyncInFlight || !accountUser) return;
      accountSyncQueued = false;
      accountSyncInFlight = syncConversation(c).catch(function (err) {
        showResponseStatus(err.message || "Could not sync this chat. Your local copy is still safe.", true);
      }).finally(function () {
        accountSyncInFlight = null;
        if (accountSyncQueued && accountUser) queueAccountChat(c);
      });
    }, 250);
  }

  async function syncConversation(c) {
    if (!accountUser || !c || !c.messages || !c.messages.length) return;
    await authRequest("/api/account/chats", { conversation: { id: accountChatId(c), title: titleFor(c), messages: c.messages.map(function (m) { return { role: m.role, text: m.text, at: m.at }; }) } });
    markAccountSynced(c, accountChatId(c));
    persistConvos(convos);
    renderAccount();
  }

  function readDrafts() {
    try { var raw = localStorage.getItem(DRAFT_KEY); var parsed = raw ? JSON.parse(raw) : {}; return parsed && typeof parsed === "object" ? parsed : {}; }
    catch (_) { return {}; }
  }

  function saveDraft(text) {
    if (!els.composerInput) return;
    var drafts = readDrafts();
    var key = currentId || "new";
    if (text) drafts[key] = String(text).slice(0, 4000); else delete drafts[key];
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch (_) { /* best effort */ }
    if (els.draftStatus) els.draftStatus.textContent = text ? " · draft saved locally" : "";
  }

  function updateCharCount() {
    if (!els.charCount || !els.composerInput) return;
    var length = els.composerInput.value.length;
    els.charCount.textContent = length.toLocaleString() + " / 4,000";
    els.charCount.classList.toggle("near-limit", length > 3600);
    if (els.clearDraftBtn) els.clearDraftBtn.hidden = !length;
  }

  function autoResizeComposer() {
    if (!els.composerInput || !els.composerInput.style) return;
    // Keep a compact single-line bar, expanding only as the draft needs space.
    els.composerInput.style.height = "auto";
    var maxHeight = 160;
    var nextHeight = Math.min(maxHeight, Math.max(48, els.composerInput.scrollHeight));
    els.composerInput.style.height = nextHeight + "px";
    els.composerInput.style.overflowY = els.composerInput.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function restoreDraft() {
    if (!els.composerInput) return;
    var drafts = readDrafts();
    var text = drafts[currentId || "new"] || "";
    els.composerInput.value = text;
    autoResizeComposer();
    updateCharCount();
    if (els.draftStatus) els.draftStatus.textContent = text ? " · draft restored" : "";
  }

  /* ---------- thread rendering ---------- */
  function scrollBottom() {
    if (document.body && document.body.classList.contains("chat-view") && els.thread) {
      els.thread.scrollTop = els.thread.scrollHeight;
      if (els.jumpLatestBtn) els.jumpLatestBtn.hidden = true;
      return;
    }
    els.thread.scrollTop = els.thread.scrollHeight;
    if (els.jumpLatestBtn) els.jumpLatestBtn.hidden = true;
  }

  function bubble(role, text, source, canRegenerate, canEdit, at, isTakeaway, latencyMs) {
    var div = document.createElement("div");
    div.className = "msg msg-" + role;
    var p = document.createElement("p");
    // Preserve the responder's paragraph breaks, nothing more.
    var parts = String(text).split(/\n\n+/);
    parts.forEach(function (part, i) {
      if (i > 0) p.appendChild(document.createElement("br"));
      if (i > 0) p.appendChild(document.createElement("br"));
      p.appendChild(document.createTextNode(part));
    });
    div.appendChild(p);
    if (at) {
      var stamp = document.createElement("time");
      stamp.className = "message-time";
      try { stamp.dateTime = new Date(at).toISOString(); stamp.textContent = new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch (_) { stamp.textContent = ""; }
      div.appendChild(stamp);
    }
    if (canEdit !== null && canEdit !== undefined) {
      var edit = document.createElement("button");
      edit.type = "button"; edit.className = "message-action"; edit.textContent = "Edit";
      edit.setAttribute("aria-label", "Edit this message");
      edit.addEventListener("click", function () {
        if (sending || !els.composerInput) return;
        els.composerInput.value = String(text); editingIndex = canEdit;
        if (els.draftStatus) els.draftStatus.textContent = " · editing previous message — send to replace";
        els.composerInput.focus(); els.composerInput.setSelectionRange(els.composerInput.value.length, els.composerInput.value.length);
      });
      var editActions = document.createElement("div"); editActions.className = "message-actions"; editActions.appendChild(edit); div.appendChild(editActions);
    }
    if (role === "assistant") {
      var actions = document.createElement("div");
      actions.className = "message-actions";
      var copy = document.createElement("button");
      copy.type = "button"; copy.className = "message-action"; copy.textContent = "Copy";
      copy.setAttribute("aria-label", "Copy this reply");
      copy.addEventListener("click", function () {
        var done = function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy"; }, 1400); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(String(text)).then(done).catch(function () {});
        else { var area = document.createElement("textarea"); area.value = String(text); document.body.appendChild(area); area.select(); try { document.execCommand("copy"); done(); } catch (_) {} area.remove(); }
      });
      actions.appendChild(copy);
      if (canRegenerate) {
        var quote = document.createElement("button");
        quote.type = "button"; quote.className = "message-action"; quote.textContent = "Use as context";
        quote.setAttribute("aria-label", "Quote this reply into the composer");
        quote.addEventListener("click", function () { if (els.composerInput) { els.composerInput.value = "About that:\n\"" + String(text).slice(0, 1200) + "\"\n\n"; updateCharCount(); autoResizeComposer(); els.composerInput.focus(); } });
        actions.appendChild(quote);
        var regenerate = document.createElement("button");
        regenerate.type = "button"; regenerate.className = "message-action"; regenerate.textContent = "Regenerate";
        regenerate.setAttribute("aria-label", "Regenerate this reply");
        regenerate.addEventListener("click", function () { var c = current(); if (c && !sending) requestReply(c, true); });
        actions.appendChild(regenerate);
        [{ label: "One next step", text: "Based on what I wrote, give me one realistic next step." },
          { label: "See the trade-off", text: "Help me see the main trade-off in this situation." },
          { label: "Ask me one useful question", text: "Ask me one focused question that would help clarify this." }].forEach(function (quick) {
          var quickBtn = document.createElement("button");
          quickBtn.type = "button"; quickBtn.className = "message-action quick-action"; quickBtn.textContent = quick.label;
          quickBtn.addEventListener("click", function () { if (els.composerInput) { els.composerInput.value = quick.text; els.composerInput.focus(); els.composerInput.setSelectionRange(els.composerInput.value.length, els.composerInput.value.length); } });
          actions.appendChild(quickBtn);
        });
        if (typeof window.speechSynthesis !== "undefined" && typeof window.SpeechSynthesisUtterance !== "undefined") {
          var speak = document.createElement("button");
          speak.type = "button"; speak.className = "message-action"; speak.textContent = "Read aloud";
          speak.setAttribute("aria-label", "Read this reply aloud");
          speak.addEventListener("click", function () {
            if (window.speechSynthesis.speaking) { window.speechSynthesis.cancel(); speak.textContent = "Read aloud"; return; }
            var utterance = new window.SpeechSynthesisUtterance(String(text));
            utterance.rate = 0.95; utterance.onend = function () { speak.textContent = "Read aloud"; };
            speak.textContent = "Stop reading"; window.speechSynthesis.speak(utterance);
          });
          actions.appendChild(speak);
        }
      }
      var pin = document.createElement("button");
      pin.type = "button"; pin.className = "message-action" + (isTakeaway ? " saved" : ""); pin.textContent = isTakeaway ? "Saved takeaway" : "Save takeaway";
      pin.setAttribute("aria-label", isTakeaway ? "Remove this reply from the saved takeaway" : "Save this reply as the chat takeaway");
      pin.addEventListener("click", function () {
        var c = current(); if (!c) return;
        if (c.takeaway === String(text).slice(0, 1200)) delete c.takeaway; else c.takeaway = String(text).slice(0, 1200);
        c.updatedAt = Date.now(); save(); renderThread();
      });
      actions.appendChild(pin); div.appendChild(actions);
    }
    return div;
  }

  function renderTakeaway() {
    var c = current();
    if (!els.takeaway) return;
    els.takeaway.hidden = !(c && c.takeaway);
    if (c && c.takeaway && els.takeawayText) els.takeawayText.textContent = c.takeaway;
  }

  function renderPrivateNote() {
    if (!els.privateNote) return;
    var c = current();
    els.privateNote.value = c && c.privateNote ? c.privateNote : "";
    if (els.noteStatus) els.noteStatus.textContent = c && c.privateNote ? "Saved locally" : "";
  }

  function renderChatStats() {
    if (!els.chatStats) return;
    var c = current();
    if (!c || !c.messages.length) { els.chatStats.textContent = ""; return; }
    var words = c.messages.reduce(function (total, m) { return total + String(m.text).trim().split(/\s+/).filter(Boolean).length; }, 0);
    var turns = c.messages.filter(function (m) { return m.role === "user"; }).length;
    var latest = c.messages[c.messages.length - 1].at;
    var when = "";
    try { when = " · last active " + new Date(latest).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch (_) {}
    els.chatStats.textContent = turns + (turns === 1 ? " turn" : " turns") + " · " + words.toLocaleString() + " words" + when;
  }

  function renderCurrentDelete() { if (els.deleteCurrentBtn) els.deleteCurrentBtn.hidden = !current(); }

  function renderThread() {
    els.thread.innerHTML = "";
    var c = current();
    if (!c || !c.messages.length) {
      var empty = document.createElement("div");
      empty.className = "thread-empty";
      empty.textContent = "Start anywhere. One honest sentence beats a perfect paragraph.";
      els.thread.appendChild(empty);
      els.retryBtn.hidden = true;
      showResponseStatus("", false);
      renderTakeaway();
      renderPrivateNote();
      renderChatStats();
      renderCurrentDelete();
      renderAccount();
      return;
    }
    var lastUserIndex = -1;
    c.messages.forEach(function (m, i) { if (m.role === "user") lastUserIndex = i; });
    c.messages.forEach(function (m, i) {
      els.thread.appendChild(bubble(m.role, m.text, m.source || m.engine, i === c.messages.length - 1 && m.role === "assistant", m.role === "user" && i === lastUserIndex ? i : null, m.at, c.takeaway === m.text, m.latencyMs));
    });
    var last = c.messages[c.messages.length - 1];
    var canRetry = !sending && last && ((last.role === "assistant" && (last.source === "fallback" || last.engine === "fallback")) || (last.role === "user" && c.replyError));
    els.retryBtn.hidden = !canRetry;
    if (canRetry && last.role === "assistant") els.retryBtn.textContent = "Try DeepInfra again";
    if (c.replyError) showResponseStatus(c.replyErrorMessage || "A reply is unavailable. Please retry.", true);
    else if (last.source === "fallback" || last.engine === "fallback") showResponseStatus(fallbackNotice(last.reason), false);
    else if (last.source === "safety" && last.reason === "local_server_unavailable") showResponseStatus("The local server could not be reached. This safety guidance was generated locally.", false);
    else showResponseStatus("", false);
    renderTakeaway();
    renderPrivateNote();
    renderChatStats();
    renderCurrentDelete();
    renderAccount();
    scrollBottom();
  }

  function showTyping() {
    var t = document.createElement("div");
    t.className = "msg msg-assistant typing";
    t.id = "typingRow";
    t.textContent = "…";
    els.thread.appendChild(t);
    scrollBottom();
  }

  function hideTyping() {
    var t = document.getElementById("typingRow");
    if (t) t.remove();
  }

  function setSending(on) {
    sending = !!on;
    if (els.sendBtn) {
      els.sendBtn.disabled = sending;
      els.sendBtn.setAttribute("aria-busy", sending ? "true" : "false");
    }
    els.thread.setAttribute("aria-busy", sending ? "true" : "false");
    if (sending) els.retryBtn.hidden = true;
    else renderThread();
  }

  function showResponseStatus(text, isError) {
    els.responseStatus.textContent = text || "";
    els.responseStatus.classList.toggle("error", Boolean(isError));
    els.responseStatus.hidden = !text;
  }

  function renderAccount() {
    var c = current();
    var userTurnCount = c ? c.messages.filter(function (m) { return m.role === "user"; }).length : 0;
    var unsyncedCount = convos.filter(function (item) { return item && item.messages && item.messages.length && !isAccountSynced(item); }).length;
    if (els.accountGreeting) {
      els.accountGreeting.hidden = !accountUser;
      els.accountGreeting.textContent = accountUser ? "Hi, " + accountUser.username : "";
    }
    if (els.homeAccountGreeting) {
      els.homeAccountGreeting.hidden = !accountUser;
      els.homeAccountGreeting.textContent = accountUser ? "Hi, " + accountUser.username : "";
    }
    if (els.accountStatus) els.accountStatus.textContent = accountUser ? (unsyncedCount ? "Signed in as " + accountUser.username + ". " + unsyncedCount + " local chat" + (unsyncedCount === 1 ? " is" : "s are") + " ready to sync." : "Signed in as " + accountUser.username + ". Your saved chats follow you across browsers.") : (c && c.messages.length >= 2 ? "This chat is local. Save it to your account when you are ready." : "Save selected chats across sessions when you choose.");
    if (els.loginBtn) els.loginBtn.hidden = Boolean(accountUser);
    if (els.signupBtn) els.signupBtn.hidden = Boolean(accountUser);
    if (els.logoutBtn) els.logoutBtn.hidden = !accountUser;
    if (els.headerAccountBtn) {
      els.headerAccountBtn.hidden = false;
      if (els.headerAccountLabel) els.headerAccountLabel.textContent = accountUser ? accountUser.username : "Log in / Create account";
      els.headerAccountBtn.setAttribute("aria-label", accountUser ? "Open profile for " + accountUser.username : "Log in or create an account");
    }
    if (els.saveAccountChatBtn) els.saveAccountChatBtn.hidden = !accountUser || !c || !c.messages.length;
    if (els.syncAccountChatsBtn) els.syncAccountChatsBtn.hidden = !accountUser || !unsyncedCount;
    var dismissed = localStorage.getItem("back_to_center_account_nudge_dismissed_v1") === "1";
    if (els.accountNudge) els.accountNudge.hidden = Boolean(accountUser) || !c || userTurnCount < ACCOUNT_PROMPT_USER_TURNS || authPromptShown || dismissed;
    if (accountPromptReady && !accountUser && !authPromptShown && !dismissed && els.authModal && els.authModal.hidden) {
      authPromptShown = true;
      setTimeout(function () { openAuth("signup"); }, 0);
    }
  }

  function openAuth(mode) {
    authMode = mode === "signup" || mode === "reset" || mode === "set-password" ? mode : "login";
    if (!els.authModal) return;
    els.authModal.hidden = false;
    var signup = authMode === "signup";
    var reset = authMode === "reset";
    var setPassword = authMode === "set-password";
    els.authModeLabel.textContent = signup ? "Create account" : reset ? "Reset password" : setPassword ? "Choose a new password" : "Log in";
    els.authTitle.textContent = signup ? "Keep your place." : reset ? "A fresh start." : setPassword ? "A fresh start." : "Welcome back.";
    els.authSubmitBtn.textContent = signup ? "Create account" : reset ? "Send reset link" : setPassword ? "Update password" : "Log in";
    els.authSwitchBtn.textContent = signup ? "I already have an account" : "Create an account instead";
    if (els.authUsernameRow) els.authUsernameRow.hidden = !signup;
    if (els.authUsername) els.authUsername.required = signup;
    if (els.authEmailRow) els.authEmailRow.hidden = setPassword;
    if (els.authEmail) els.authEmail.required = !setPassword;
    if (els.authPasswordRow) els.authPasswordRow.hidden = reset;
    if (els.authPassword) { els.authPassword.required = !reset; els.authPassword.autocomplete = setPassword ? "new-password" : "current-password"; }
    if (els.authResetBtn) els.authResetBtn.hidden = signup || reset || setPassword;
    if (els.authSwitchBtn) els.authSwitchBtn.hidden = setPassword;
    if (els.authEmail) els.authEmail.focus();
    els.confirmPasswordRow.hidden = !(signup || setPassword);
    els.authConfirmPassword.required = signup || setPassword;
    els.authError.className = "form-error";
    els.authError.hidden = true;
    if (els.authEmail) els.authEmail.focus(); else els.authUsername.focus();
  }

  function closeAuth() { if (els.authModal) els.authModal.hidden = true; }

  function openProfile() {
    if (!accountUser || !els.profileModal) return;
    els.profileModal.hidden = false;
    if (els.profileUsername) els.profileUsername.textContent = "@" + (accountUser.username || "");
    if (els.profileEmail) els.profileEmail.textContent = accountUser.email || "";
    if (els.profileError) { els.profileError.hidden = true; els.profileError.textContent = ""; }
    if (els.changePasswordForm) els.changePasswordForm.hidden = true;
    if (els.changePasswordToggle) { els.changePasswordToggle.hidden = false; els.changePasswordToggle.setAttribute("aria-expanded", "false"); }
    if (els.currentPassword) els.currentPassword.value = "";
    if (els.newPassword) els.newPassword.value = "";
    if (els.confirmNewPassword) els.confirmNewPassword.value = "";
    if (els.newPassword) els.newPassword.focus();
  }

  function closeProfile() { if (els.profileModal) els.profileModal.hidden = true; }

  function openPrivacy() {
    if (!els.privacyModal) return;
    els.privacyModal.hidden = false;
    if (els.privacyCloseBtn) els.privacyCloseBtn.focus();
  }
  function closePrivacy() { if (els.privacyModal) els.privacyModal.hidden = true; }

  async function logoutAccount() {
    try { await authRequest("/api/auth/logout", {}); } catch (_) {}
    accountUser = null; closeProfile(); renderAccount(); showResponseStatus("You are logged out. Your local chats are still here.", false);
  }

  async function authRequest(path, payload, method) {
    var response;
    try {
      var requestMethod = method || (payload ? "POST" : "GET");
      response = await fetch(path, { method: requestMethod, headers: payload ? { "Content-Type": "application/json" } : { "Accept": "application/json" }, credentials: "same-origin", body: payload ? JSON.stringify(payload) : undefined });
    } catch (_) {
      var networkError = new Error("Could not reach the local server. Make sure npm start is running, then refresh this page.");
      networkError.code = "network_error";
      throw networkError;
    }
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) { var error = new Error(data.error || "Account request failed."); error.code = data.code; throw error; }
    return data;
  }

  async function loadAccountChats() {
    if (!accountUser) return;
    try {
      var data = await authRequest("/api/account/chats");
      var saved = Array.isArray(data.chats) ? data.chats : [];
      saved.forEach(function (remote) {
        var local = convos.filter(function (c) {
          return c.id === remote.id || c.accountId === remote.id || c.id === "account_" + remote.id;
        })[0];
        if (!local) {
          local = { id: String(remote.id), title: remote.title || "Saved chat", createdAt: remote.savedAt || Date.now(), updatedAt: remote.savedAt || Date.now(), messages: remote.messages || [], openQuestionKey: null, askedKeys: [] };
          convos.push(local);
        } else if (isAccountSynced(local) || local.id === remote.id || local.id === "account_" + remote.id) {
          // The account copy is authoritative for a previously synced chat.
          local.title = remote.title || local.title;
          local.messages = Array.isArray(remote.messages) ? remote.messages : local.messages;
          local.updatedAt = remote.savedAt || local.updatedAt;
        }
        markAccountSynced(local, remote.id);
      });
      if (saved.length) { persistConvos(convos); renderHistory(); }
      if (els.accountSavedList) {
        els.accountSavedList.innerHTML = "";
        saved.forEach(function (remote) {
          var item = document.createElement("li"); item.className = "account-saved-item";
          var button = document.createElement("button"); button.type = "button"; button.className = "link-btn"; button.textContent = remote.title || "Saved chat";
          button.addEventListener("click", function () {
            var chat = convos.filter(function (c) { return c.accountId === remote.id || c.id === remote.id || c.id === "account_" + remote.id; })[0];
            if (chat) { currentId = chat.id; showChatView(); renderThread(); restoreDraft(); }
          });
          var remove = document.createElement("button"); remove.type = "button"; remove.className = "link-btn danger"; remove.textContent = "Delete"; remove.setAttribute("aria-label", "Delete saved chat: " + (remote.title || "Saved chat"));
          remove.addEventListener("click", function () { deleteAccountChat(remote.id, item); });
          item.appendChild(button); item.appendChild(remove); els.accountSavedList.appendChild(item);
        });
      }
    } catch (err) {
      showResponseStatus(err.message || "Could not load account history. Your local chats are still safe.", true);
    }
  }

  async function deleteAccountChat(remoteId, item) {
    if (!accountUser || !remoteId || !window.confirm("Delete this saved chat from your account?")) return;
    try {
      await authRequest("/api/account/chats/" + encodeURIComponent(remoteId), null, "DELETE");
      var local = convos.filter(function (c) { return c.accountId === remoteId || c.id === remoteId || c.id === "account_" + remoteId; })[0];
      var localId = local && local.id;
      convos = convos.filter(function (c) { return c.id !== localId; });
      persistConvos(convos); renderHistory();
      if (item && item.parentNode) item.parentNode.removeChild(item);
      if (currentId === localId) { currentId = convos[0] ? convos[0].id : null; renderThread(); }
      showResponseStatus("Saved chat deleted from your account.", false);
    } catch (err) { showResponseStatus(err.message || "Could not delete that saved chat.", true); }
  }

  async function saveAccountChat() {
    var c = current();
    if (!accountUser || !c || !c.messages.length) return;
    try {
      await syncConversation(c);
      renderAccount();
      showResponseStatus("Saved to your account. The browser copy remains here too.", false);
    } catch (err) {
      if (err.code === "authentication_required") { accountUser = null; renderAccount(); }
      showResponseStatus(err.message || "Could not save this chat.", true);
    }
  }

  async function syncLocalChats(options) {
    if (!accountUser) return;
    options = options || {};
    var localChats = convos.filter(function (item) { return item && item.messages && item.messages.length && !isAccountSynced(item); });
    if (!localChats.length) { renderAccount(); return; }
    if (!options.automatic && !window.confirm("Sync " + localChats.length + " local chat" + (localChats.length === 1 ? "" : "s") + " to your account?")) return;
    if (els.syncAccountChatsBtn) els.syncAccountChatsBtn.disabled = true;
    try {
      for (var i = 0; i < localChats.length; i += 1) {
        var item = localChats[i];
        await syncConversation(item);
      }
      persistConvos(convos);
      await loadAccountChats();
      renderAccount();
      if (!options.automatic) showResponseStatus("Your local chats are now available on this account.", false);
    } catch (err) {
      showResponseStatus(err.message || "Could not sync all local chats. Your local copies are still safe.", true);
    } finally { if (els.syncAccountChatsBtn) els.syncAccountChatsBtn.disabled = false; }
  }

  function fallbackNotice(reason) {
    var detail = {
      unconfigured: "DeepInfra is not configured.",
      auth_error: "DeepInfra rejected the server key.",
      rate_limited: "DeepInfra is rate limiting requests.",
      timeout: "DeepInfra took too long to reply.",
      local_server_unavailable: "The local server could not be reached."
    }[reason] || "DeepInfra is unavailable right now.";
    return detail + " This is a basic offline reply.";
  }

  function pushAssistant(c, text, source, reason, questionKey, replace, latencyMs) {
    if (!text) return false;
    if (convos.indexOf(c) === -1) return false;
    var message = { role: "assistant", text: text, at: Date.now(), source: source || "deepinfra", reason: reason || null, latencyMs: latencyMs || null };
    if (replace && c.messages.length && c.messages[c.messages.length - 1].role === "assistant") c.messages[c.messages.length - 1] = message;
    else c.messages.push(message);
    var userTurnCount = c.messages.filter(function (m) { return m.role === "user"; }).length;
    if (userTurnCount >= ACCOUNT_PROMPT_USER_TURNS && !accountUser) accountPromptReady = true;
    c.openQuestionKey = questionKey || null;
    if (questionKey) c.askedKeys = (c.askedKeys || []).concat([questionKey]);
    c.updatedAt = Date.now();
    if (currentId === c.id) renderThread();
    save();
    return true;
  }

  /* ---------- send flow ---------- */
  function userTurns(c) {
    return c.messages.filter(function (m) { return m.role === "user"; }).map(function (m) { return m.text; });
  }

  function requestHistory(c, replace) {
    var messages = replace ? c.messages.slice(0, -1) : c.messages.slice();
    return messages.slice(-24).map(function (m) {
      return { role: m.role, content: String(m.text).slice(0, 4000) };
    });
  }

  async function requestReply(c, replace) {
    if (sending || convos.indexOf(c) === -1) return;
    var history = requestHistory(c, replace);
    var latest = history[history.length - 1];
    if (!latest || latest.role !== "user") return;
    c.replyError = false;
    c.replyErrorMessage = null;
    showResponseStatus("", false);
    setSending(true);
    var requestStarted = Date.now();
    if (currentId === c.id) showTyping();
    try {
      var response;
      try {
        response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history })
        });
      } catch (networkError) {
        var safetyText = window.BackToCenterSafety.safetyReply(history);
        var result = safetyText ? { text: safetyText, source: "safety" } : window.generateReply(latest.content, {
          userTurns: userTurns(c).slice(0, -1),
          openQuestionKey: c.openQuestionKey,
          askedKeys: c.askedKeys || []
        });
        if (!result || !result.text) throw new Error("A reply is unavailable right now. Please retry.");
        if (safetyText) result.source = "safety";
        else result.source = "fallback";
        result.reason = "local_server_unavailable";
        hideTyping();
        pushAssistant(c, result.text, result.source, result.reason, result.questionKey, replace);
        if (currentId === c.id) showResponseStatus(safetyText ? "The local server could not be reached. This safety guidance was generated locally." : fallbackNotice(result.reason), false);
        return;
      }
      var data;
      try { data = await response.json(); }
      catch (_) { throw new Error("The server returned an unreadable reply. Please retry."); }
      if (!response.ok) throw new Error(data && typeof data.error === "string" ? data.error : "The request failed. Please retry.");
      if (!data || typeof data.text !== "string" || !data.text.trim() ||
          ["deepinfra", "fallback", "safety", "guardrail"].indexOf(data.source) === -1) {
        throw new Error("The server returned an invalid reply. Please retry.");
      }
      hideTyping();
      pushAssistant(c, data.text, data.source, data.reason, data.questionKey, replace, Date.now() - requestStarted);
      if (currentId === c.id && data.source === "fallback") {
        showResponseStatus(fallbackNotice(data.reason), false);
      }
    } catch (err) {
      hideTyping();
      c.replyError = true;
      c.replyErrorMessage = err.message || "A reply is unavailable. Please retry.";
      save();
      if (currentId === c.id) showResponseStatus(err.message || "A reply is unavailable. Please retry.", true);
    } finally {
      setSending(false);
      if (currentId === c.id) renderThread();
    }
  }

  function handleSend(rawText) {
    if (sending) return;
    var text = (rawText || "").trim();
    if (!text || text.length > 4000) {
      els.emptyError.textContent = text ? "Keep this message under 4,000 characters." : "Write a little something first — even a rough fragment is enough.";
      els.emptyError.hidden = false;
      els.composerInput.classList.remove("shake");
      void els.composerInput.offsetWidth;
      els.composerInput.classList.add("shake");
      els.composerInput.focus();
      return;
    }
    els.emptyError.hidden = true;
    var c = current();
    if (!c) {
      c = { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), messages: [], openQuestionKey: null, askedKeys: [] };
      convos.unshift(c);
      currentId = c.id;
    }
    if (editingIndex !== null && editingIndex >= 0 && editingIndex < c.messages.length && c.messages[editingIndex].role === "user") {
      c.messages[editingIndex].text = text;
      c.messages = c.messages.slice(0, editingIndex + 1);
      editingIndex = null;
    } else {
      c.messages.push({ role: "user", text: text, at: Date.now() });
    }
    c.updatedAt = Date.now();
    els.composerInput.value = "";
    autoResizeComposer();
    updateCharCount();
    autoResizeComposer();
    saveDraft("");
    els.composerInput.focus();
    renderThread();
    save();
    requestReply(c, false);
  }

  els.retryBtn.addEventListener("click", function () {
    var c = current();
    if (!c || sending) return;
    var last = c.messages[c.messages.length - 1];
    if (!last) return;
    if (last.role === "assistant" && (last.source === "fallback" || last.engine === "fallback")) requestReply(c, true);
    else if (last.role === "user" && c.replyError) requestReply(c, false);
  });

  els.composer.addEventListener("submit", function (e) {
    e.preventDefault();
    handleSend(els.composerInput.value);
  });

  els.composerInput.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.isComposing) {
      e.preventDefault(); handleSend(els.composerInput.value); return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend(els.composerInput.value);
    }
  });
  if (els.thread && els.thread.addEventListener) els.thread.addEventListener("scroll", function () {
    var away = els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight > 60;
    if (els.jumpLatestBtn) els.jumpLatestBtn.hidden = !away;
  });
  if (els.jumpLatestBtn) els.jumpLatestBtn.addEventListener("click", scrollBottom);

  var shortcutReturnFocus = null;
  function closeShortcuts() { if (els.shortcutOverlay) els.shortcutOverlay.hidden = true; if (shortcutReturnFocus && shortcutReturnFocus.focus) shortcutReturnFocus.focus(); shortcutReturnFocus = null; }
  function openShortcuts() { if (els.shortcutOverlay) { shortcutReturnFocus = document.activeElement; els.shortcutOverlay.hidden = false; if (els.closeShortcutsBtn) els.closeShortcutsBtn.focus(); } }
  if (els.closeShortcutsBtn) els.closeShortcutsBtn.addEventListener("click", closeShortcuts);
  if (els.shortcutOverlay) els.shortcutOverlay.addEventListener("click", function (e) { if (e.target === els.shortcutOverlay) closeShortcuts(); });
  if (document.addEventListener) document.addEventListener("keydown", function (e) {
    var active = document.activeElement;
    var typingTarget = active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || "");
    if (e.key === "Escape") { closeShortcuts(); closeProfile(); closePrivacy(); closeAuth(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); els.composerInput.focus(); return; }
    if (typingTarget) return;
    if (e.key === "/" && els.historySearch) { e.preventDefault(); els.historySearch.focus(); return; }
    if (e.key.toLowerCase() === "n" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); newChat(); return; }
    if (e.key.toLowerCase() === "r" && !e.ctrlKey && !e.metaKey && !e.altKey) { var activeChat = current(); var activeLast = activeChat && activeChat.messages[activeChat.messages.length - 1]; if (activeLast && activeLast.role === "assistant" && !sending) { e.preventDefault(); requestReply(activeChat, true); return; } }
    if (e.key === "?") { e.preventDefault(); openShortcuts(); }
  });

  els.composerInput.addEventListener("input", function () {
    els.emptyError.hidden = true;
    els.composerInput.classList.remove("shake");
    saveDraft(els.composerInput.value);
    updateCharCount();
  });
  if (els.clearDraftBtn) els.clearDraftBtn.addEventListener("click", function () {
    els.composerInput.value = ""; editingIndex = null; saveDraft(""); updateCharCount(); autoResizeComposer(); els.composerInput.focus();
  });

  els.promptChips.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-prompt]");
    if (!btn) {
      var random = e.target.closest("[data-random]");
      if (!random) return;
      var prompts = Array.prototype.slice.call(els.promptChips.querySelectorAll("[data-prompt]"));
      if (!prompts.length) return;
      btn = prompts[Math.floor(Math.random() * prompts.length)];
    }
    els.composerInput.value = btn.getAttribute("data-prompt") + " ";
    els.composerInput.focus();
    els.composerInput.setSelectionRange(els.composerInput.value.length, els.composerInput.value.length);
  });
  if (els.togglePromptsBtn) els.togglePromptsBtn.addEventListener("click", function () {
    var expanded = els.togglePromptsBtn.getAttribute("aria-expanded") === "true";
    Array.prototype.forEach.call(els.promptChips.querySelectorAll(".prompt-secondary"), function (chip) { chip.hidden = expanded; });
    els.togglePromptsBtn.setAttribute("aria-expanded", expanded ? "false" : "true");
    els.togglePromptsBtn.textContent = expanded ? "Show more prompts" : "Show fewer prompts";
  });
  if (els.togglePromptsBtn && els.promptChips.querySelectorAll) Array.prototype.forEach.call(els.promptChips.querySelectorAll(".prompt-secondary"), function (chip) { chip.hidden = true; });

  function newChat() {
    editingIndex = null;
    currentId = null;
    // A new conversation gets its own prompt threshold. Existing chats are
    // never used to trigger the automatic account prompt on initial load.
    accountPromptReady = false;
    authPromptShown = false;
    showChatView();
    if (typeof history !== "undefined" && history.replaceState) history.replaceState(null, "", window.location.pathname || "/");
    renderThread();
    renderHistory();
    restoreDraft();
    els.composerInput.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  els.brandHome.addEventListener("click", function (e) {
    e.preventDefault();
    showHomeView();
  });

  function showHomeView() {
    if (document.body) document.body.classList.remove("chat-view");
    if (els.homeView) els.homeView.hidden = false;
    if (els.chatView) els.chatView.hidden = true;
    if (typeof history !== "undefined" && history.replaceState) history.replaceState(null, "", window.location.pathname || "/");
  }
  function showChatView() {
    if (document.body) document.body.classList.add("chat-view");
    if (els.homeView) els.homeView.hidden = true;
    if (els.chatView) els.chatView.hidden = false;
  }
  function enterChatWith(text) {
    showChatView();
    newChat();
    if (els.composerInput && text) {
      els.composerInput.value = String(text).slice(0, 4000);
      autoResizeComposer(); updateCharCount(); saveDraft(els.composerInput.value); els.composerInput.focus();
    }
  }
  if (els.homeEntry) els.homeEntry.addEventListener("submit", function (event) {
    event.preventDefault();
    enterChatWith(els.homeInput ? els.homeInput.value.trim() : "");
  });
  if (els.homeInput) els.homeInput.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (els.homeEntry && typeof els.homeEntry.requestSubmit === "function") els.homeEntry.requestSubmit();
    else if (els.homeEntry) els.homeEntry.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  });
  if (els.homeView) Array.prototype.forEach.call(els.homeView.querySelectorAll("[data-home-prompt]"), function (button) {
    button.addEventListener("click", function () { enterChatWith(button.getAttribute("data-home-prompt") || ""); });
  });

  if (els.clearTakeawayBtn) els.clearTakeawayBtn.addEventListener("click", function () {
    var c = current(); if (!c) return;
    delete c.takeaway; save(); renderTakeaway();
  });

  if (els.privateNote) els.privateNote.addEventListener("input", function () {
    var c = current();
    if (!c && els.privateNote.value.trim()) {
      c = { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), messages: [], openQuestionKey: null, askedKeys: [] };
      convos.unshift(c); currentId = c.id;
    }
    if (!c) return;
    c.privateNote = els.privateNote.value.slice(0, 4000);
    c.updatedAt = Date.now();
    if (els.noteStatus) els.noteStatus.textContent = c.privateNote ? "Saved locally" : "";
    save();
  });

  /* ---------- focus mode ---------- */
  function saveFocusTimer() {
    try { localStorage.setItem(FOCUS_KEY, JSON.stringify(focusTimer)); } catch (_) {}
  }
  function loadFocusTimer() {
    try {
      var raw = localStorage.getItem(FOCUS_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || (parsed.mode !== "countdown" && parsed.mode !== "stopwatch")) return;
      if (Number.isFinite(parsed.durationMs) && parsed.durationMs >= 60000 && parsed.durationMs <= 3600000) focusTimer.durationMs = parsed.durationMs;
      if (Number.isFinite(parsed.elapsedMs) && parsed.elapsedMs >= 0) focusTimer.elapsedMs = parsed.elapsedMs;
      focusTimer.mode = parsed.mode;
      focusTimer.running = parsed.running === true;
      focusTimer.startedAt = Number.isFinite(parsed.startedAt) ? parsed.startedAt : null;
      focusTimer.completed = parsed.completed === true;
      focusTimer.description = typeof parsed.description === "string" ? parsed.description.slice(0, 160) : "";
    } catch (_) {}
  }
  function focusElapsed() {
    var elapsed = Math.max(0, Number(focusTimer.elapsedMs) || 0);
    if (focusTimer.running && focusTimer.startedAt) elapsed += Math.max(0, Date.now() - focusTimer.startedAt);
    return elapsed;
  }
  function formatFocusTime(ms, countdown) {
    var total = Math.max(0, countdown ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
    var hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
    return (hours ? String(hours).padStart(2, "0") + ":" : "") + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
  }
  function renderFocus() {
    if (!els.focusTime) return;
    var elapsed = focusElapsed(), remaining = Math.max(0, focusTimer.durationMs - elapsed), countdown = focusTimer.mode === "countdown";
    els.focusTime.textContent = formatFocusTime(countdown ? remaining : elapsed, countdown);
    if (els.focusState) els.focusState.textContent = focusTimer.completed ? "Complete" : (focusTimer.running ? "In progress" : (elapsed ? "Paused" : "Ready"));
    if (els.focusStartBtn) els.focusStartBtn.textContent = focusTimer.running ? "Pause" : (focusTimer.completed ? "Start again" : (elapsed ? "Resume" : "Start"));
    if (els.focusDescription && document.activeElement !== els.focusDescription) els.focusDescription.value = focusTimer.description || "";
    if (els.countdownModeBtn) els.countdownModeBtn.setAttribute("aria-selected", countdown ? "true" : "false");
    if (els.stopwatchModeBtn) els.stopwatchModeBtn.setAttribute("aria-selected", countdown ? "false" : "true");
    if (els.focusPresets) Array.prototype.forEach.call(els.focusPresets.querySelectorAll("[data-focus-minutes]"), function (button) {
      var selected = countdown && Number(button.getAttribute("data-focus-minutes")) * 60000 === focusTimer.durationMs;
      button.classList.toggle("btn-soft", selected); button.classList.toggle("btn-ghost", !selected);
    });
  }
  function stopFocusLoop() { if (focusTick) { clearInterval(focusTick); focusTick = null; } }
  function checkFocusTimer() {
    if (!focusTimer.running) { renderFocus(); return; }
    var elapsed = focusElapsed();
    if (focusTimer.mode === "countdown" && elapsed >= focusTimer.durationMs) {
      focusTimer.elapsedMs = focusTimer.durationMs; focusTimer.running = false; focusTimer.startedAt = null; focusTimer.completed = true;
      stopFocusLoop(); saveFocusTimer(); renderFocus();
      if (els.focusNotice) els.focusNotice.textContent = "Time is up. Take a breath, or reset when you’re ready.";
      return;
    }
    renderFocus();
  }
  function startFocusLoop() { stopFocusLoop(); if (focusTimer.running) focusTick = setInterval(checkFocusTimer, 250); }
  function resetFocusTimer() {
    focusTimer.elapsedMs = 0; focusTimer.running = false; focusTimer.startedAt = null; focusTimer.completed = false;
    stopFocusLoop(); saveFocusTimer(); renderFocus(); if (els.focusNotice) els.focusNotice.textContent = "Your timer stays accurate if you switch tabs or return to chat.";
  }
  function setFocusMode(mode) { if (focusTimer.mode === mode) return; focusTimer.mode = mode; resetFocusTimer(); renderFocus(); }
  function openFocusScreen() {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new Event("declutter:focus-open"));
    document.body.classList.add("focus-mode"); if (els.focusScreen) els.focusScreen.hidden = false;
    if (els.focusBtn) { els.focusBtn.setAttribute("aria-pressed", "true"); els.focusBtn.textContent = "Chat"; els.focusBtn.title = "Return to chat"; }
    renderFocus(); startFocusLoop(); if (els.focusBackBtn) els.focusBackBtn.focus();
  }
  function closeFocusScreen() {
    document.body.classList.remove("focus-mode"); if (els.focusScreen) els.focusScreen.hidden = true;
    if (els.focusBtn) { els.focusBtn.setAttribute("aria-pressed", "false"); els.focusBtn.textContent = "Focus"; els.focusBtn.title = "Open Focus Mode"; }
    showChatView();
    renderFocus(); if (els.composerInput) els.composerInput.focus();
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("declutter:voice-open", function () {
    if (document.body.classList.contains("focus-mode")) closeFocusScreen();
    setSidebar(false);
  });
  if (els.focusBtn) els.focusBtn.addEventListener("click", function () { document.body.classList.contains("focus-mode") ? closeFocusScreen() : openFocusScreen(); });
  if (els.focusBackBtn) els.focusBackBtn.addEventListener("click", closeFocusScreen);
  if (els.countdownModeBtn) els.countdownModeBtn.addEventListener("click", function () { setFocusMode("countdown"); });
  if (els.stopwatchModeBtn) els.stopwatchModeBtn.addEventListener("click", function () { setFocusMode("stopwatch"); });
  if (els.focusPresets) els.focusPresets.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("[data-focus-minutes]") : null;
    if (!button) return;
    focusTimer.mode = "countdown"; focusTimer.durationMs = Number(button.getAttribute("data-focus-minutes")) * 60000; resetFocusTimer();
  });
  if (els.focusDescription) els.focusDescription.addEventListener("input", function () { focusTimer.description = els.focusDescription.value.slice(0, 160); saveFocusTimer(); });
  if (els.focusStartBtn) els.focusStartBtn.addEventListener("click", function () {
    if (focusTimer.completed) resetFocusTimer();
    if (focusTimer.running) {
      focusTimer.elapsedMs = focusElapsed(); focusTimer.running = false; focusTimer.startedAt = null;
      if (els.focusNotice) els.focusNotice.textContent = "Paused. Resume whenever you’re ready.";
    } else {
      focusTimer.startedAt = Date.now(); focusTimer.running = true;
      if (els.focusNotice) els.focusNotice.textContent = focusTimer.description ? "Working on: " + focusTimer.description : "Focus time has started.";
    }
    saveFocusTimer(); renderFocus(); startFocusLoop();
  });
  if (els.focusResetBtn) els.focusResetBtn.addEventListener("click", resetFocusTimer);

  function setSidebar(open, restoreFocus) {
    var isOpen = Boolean(open);
    if (document.body && document.body.classList) document.body.classList.toggle("history-drawer-open", isOpen);
    if (els.historyDrawerToggle) els.historyDrawerToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (els.historyDrawer) {
      els.historyDrawer.setAttribute("aria-hidden", isOpen ? "false" : "true");
      els.historyDrawer.inert = !isOpen;
    }
    if (els.historyDrawerScrim) els.historyDrawerScrim.hidden = !isOpen;
    if (isOpen && els.historyDrawerCloseSlider) els.historyDrawerCloseSlider.focus();
    else if (restoreFocus && els.historyDrawerToggle) els.historyDrawerToggle.focus();
  }
  if (els.sidebarBtn) els.sidebarBtn.addEventListener("click", function () {
    if (document.body.classList.contains("focus-mode")) closeFocusScreen();
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new Event("declutter:chat-open"));
    showChatView();
    setSidebar(false);
  });
  if (els.historyDrawerToggle) els.historyDrawerToggle.addEventListener("click", function () { setSidebar(true); });
  if (els.historyDrawerCloseSlider) els.historyDrawerCloseSlider.addEventListener("click", function () { setSidebar(false, true); });
  if (els.historyDrawerScrim) els.historyDrawerScrim.addEventListener("click", function () { setSidebar(false, true); });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && document.body.classList.contains("history-drawer-open")) setSidebar(false, true);
  });

  if (els.themeBtn) els.themeBtn.addEventListener("click", function () {
    var night = document.body.getAttribute("data-theme") !== "night";
    if (night) document.body.setAttribute("data-theme", "night"); else document.body.removeAttribute("data-theme");
    els.themeBtn.setAttribute("aria-pressed", night ? "true" : "false");
    els.themeBtn.textContent = night ? "Day theme" : "Night theme";
    try { localStorage.setItem("back_to_center_theme_v1", night ? "night" : "day"); } catch (_) {}
  });

  if (els.loginBtn) els.loginBtn.addEventListener("click", function () { openAuth("login"); });
  if (els.signupBtn) els.signupBtn.addEventListener("click", function () { openAuth("signup"); });
  if (els.headerAccountBtn) els.headerAccountBtn.addEventListener("click", function () { accountUser ? openProfile() : openAuth("login"); });
  if (els.nudgeSignup) els.nudgeSignup.addEventListener("click", function () { openAuth("signup"); });
  if (els.nudgeDismiss) els.nudgeDismiss.addEventListener("click", function () { try { localStorage.setItem("back_to_center_account_nudge_dismissed_v1", "1"); } catch (_) {} renderAccount(); });
  if (els.logoutBtn) els.logoutBtn.addEventListener("click", async function () {
    await logoutAccount();
  });
  if (els.profileCloseBtn) els.profileCloseBtn.addEventListener("click", closeProfile);
  if (els.profileLogoutBtn) els.profileLogoutBtn.addEventListener("click", logoutAccount);
  if (els.privacyBtn) els.privacyBtn.addEventListener("click", openPrivacy);
  if (els.privacyCloseBtn) els.privacyCloseBtn.addEventListener("click", closePrivacy);
  if (els.privacyModal) els.privacyModal.addEventListener("click", function (event) { if (event.target === els.privacyModal) closePrivacy(); });
  if (els.changePasswordToggle) els.changePasswordToggle.addEventListener("click", function () {
    var open = els.changePasswordForm.hidden;
    els.changePasswordForm.hidden = !open;
    els.changePasswordToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open && els.newPassword) els.newPassword.focus();
  });
  if (els.profileModal) els.profileModal.addEventListener("click", function (event) { if (event.target === els.profileModal) closeProfile(); });
  if (els.changePasswordForm) els.changePasswordForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (els.changePasswordBtn) els.changePasswordBtn.disabled = true;
    if (els.profileError) els.profileError.hidden = true;
    try {
      var currentPassword = els.currentPassword.value;
      var nextPassword = els.newPassword.value;
      var confirmNext = els.confirmNewPassword.value;
      if (!currentPassword) throw new Error("Enter your current password.");
      if (nextPassword !== confirmNext) throw new Error("Passwords do not match.");
      await authRequest("/api/auth/change-password", { currentPassword: currentPassword, password: nextPassword, confirmPassword: confirmNext });
      closeProfile(); showResponseStatus("Password updated successfully.", false);
    } catch (error) {
      if (els.profileError) { els.profileError.textContent = error.message || "Could not update your password."; els.profileError.hidden = false; }
    } finally { if (els.changePasswordBtn) els.changePasswordBtn.disabled = false; }
  });
  if (els.saveAccountChatBtn) els.saveAccountChatBtn.addEventListener("click", saveAccountChat);
  if (els.syncAccountChatsBtn) els.syncAccountChatsBtn.addEventListener("click", syncLocalChats);
  if (els.authCloseBtn) els.authCloseBtn.addEventListener("click", closeAuth);
  if (els.authSwitchBtn) els.authSwitchBtn.addEventListener("click", function () { openAuth(authMode === "signup" ? "login" : "signup"); });
  if (els.authResetBtn) els.authResetBtn.addEventListener("click", function () { openAuth("reset"); });
  if (els.authForm) els.authForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (els.authSubmitBtn) els.authSubmitBtn.disabled = true;
    els.authError.hidden = true;
    try {
      var path = authMode === "signup" ? "/api/auth/signup" : authMode === "reset" ? "/api/auth/reset-request" : authMode === "set-password" ? "/api/auth/update-password" : "/api/auth/login";
      var hash = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
      var data = await authRequest(path, { email: els.authEmail ? els.authEmail.value : "", username: els.authUsername.value, password: els.authPassword.value, confirmPassword: els.authConfirmPassword.value, token: authMode === "set-password" ? hash.get("access_token") : undefined });
      if (authMode === "reset") { els.authError.textContent = data.message || "If that email has an account, a reset link is on its way."; els.authError.className = "form-success"; els.authError.hidden = false; return; }
      if (authMode === "set-password") { window.history.replaceState({}, document.title, window.location.pathname + window.location.search); closeAuth(); showResponseStatus(data.message || "Password updated. You can now log in.", false); return; }
      accountUser = data.user;
      if (!accountUser) { els.authError.textContent = data.message || "Check your email to confirm your account."; els.authError.hidden = false; return; }
      // Clear credentials before closing so they are not retained in the DOM
      // if the dialog is reopened later.
      els.authPassword.value = "";
      els.authConfirmPassword.value = "";
      closeAuth();
      renderAccount();
      showResponseStatus("Signed in as " + accountUser.username + ". Syncing your chat history…", false);
      await syncLocalChats({ automatic: true });
      await loadAccountChats();
      if (!els.responseStatus || !els.responseStatus.classList || !els.responseStatus.classList.contains("error")) showResponseStatus("Signed in as " + accountUser.username + ". Your chat history is up to date.", false);
    } catch (err) { els.authError.textContent = err.message || "Could not complete that request."; els.authError.hidden = false; }
    finally { if (els.authSubmitBtn) els.authSubmitBtn.disabled = false; }
  });

  /* ---------- history ---------- */
  function titleFor(c) {
    if (c.title) return String(c.title).slice(0, 80);
    var first = (c.messages.filter(function (m) { return m.role === "user"; })[0] || {}).text || "";
    var oneLine = first.replace(/\s+/g, " ").trim();
    if (!oneLine) return "Empty chat";
    return oneLine.length > 70 ? oneLine.slice(0, 70).replace(/\s+\S*$/, "") + "…" : oneLine;
  }

  function niceDate(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function highlightTitle(text, query) {
    var escaped = escapeHtml(text);
    if (!query) return escaped;
    var needle = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return escaped.replace(new RegExp("(" + needle + ")", "ig"), "<mark>$1</mark>");
  }

  function renderHistory() {
    els.deleteAllBtn.style.display = convos.length ? "inline-flex" : "none";
    if (els.archivedBtn) {
      var hasArchived = convos.some(function (chat) { return chat.archived; });
      els.archivedBtn.hidden = !hasArchived;
      if (!hasArchived) archivedOnly = false;
      syncHistoryFilters();
    }
    els.historyList.innerHTML = "";
    var query = els.historySearch ? els.historySearch.value.trim().toLowerCase() : "";
    if (els.clearSearchBtn) els.clearSearchBtn.hidden = !query;
    var visible = convos.filter(function (c) {
      return (archivedOnly ? c.archived : !c.archived) && (!pinnedOnly || c.pinned) && (!query || titleFor(c).toLowerCase().indexOf(query) !== -1 || (c.privateNote || "").toLowerCase().indexOf(query) !== -1 || c.messages.some(function (m) { return m.text.toLowerCase().indexOf(query) !== -1; }));
    });
    visible.sort(function (a, b) { return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.updatedAt || 0) - (a.updatedAt || 0); });
    els.historyCount.textContent = (query || pinnedOnly) ? (visible.length + " / " + convos.length) : String(convos.length);
    if (els.historyCount.setAttribute) els.historyCount.setAttribute("aria-label", (query || pinnedOnly) ? (visible.length + " matching chats out of " + convos.length) : (convos.length + " saved chats"));
    els.emptyHistory.style.display = visible.length ? "none" : "block";
    if (els.emptyHistory) els.emptyHistory.textContent = !visible.length && query ? "No chats match that search." : (!visible.length && pinnedOnly ? "No pinned chats yet." : "Nothing here yet. Your chats will appear once you start talking.");
    visible.forEach(function (c) {
      var turns = c.messages.filter(function (m) { return m.role === "user"; }).length;
      var li = document.createElement("li");
      li.className = "history-item" + (c.id === currentId ? " current" : "");
      if (c.id === currentId) li.setAttribute("aria-current", "true");
      li.innerHTML =
        '<div class="history-top"><span class="history-date">' + escapeHtml(niceDate(c.updatedAt || c.createdAt)) +
        " · " + turns + (turns === 1 ? " message" : " messages") + "</span>" + (c.pinned ? '<span class="history-status">Pinned</span>' : "") + "</div>" +
        '<p class="history-preview">' + highlightTitle(titleFor(c), query) + "</p>" +
        '<div class="history-row"><button class="link-btn" data-act="open">Reopen</button>' +
        '<span class="history-separator" aria-hidden="true">·</span>' +
        '<button class="link-btn" data-act="pin">' + (c.pinned ? "Unpin" : "Pin") + '</button>' +
        '<span class="history-separator" aria-hidden="true">·</span>' +
        '<button class="link-btn" data-act="duplicate">Duplicate</button>' +
        '<span class="history-separator" aria-hidden="true">·</span>' +
        '<button class="link-btn" data-act="archive">' + (c.archived ? "Unarchive" : "Archive") + '</button>' +
        '<span class="history-separator" aria-hidden="true">·</span>' +
        '<button class="link-btn" data-act="rename">Rename</button>' +
        '<span class="history-separator" aria-hidden="true">·</span>' +
        '<button class="link-btn danger" data-act="delete">Delete</button></div>';
      var historyActions = li.querySelector(".history-row");
      var historyMenu = document.createElement("button");
      historyMenu.type = "button";
      historyMenu.className = "history-menu-toggle";
      historyMenu.textContent = "•••";
      historyMenu.setAttribute("aria-label", "Chat actions");
      historyMenu.setAttribute("aria-expanded", "false");
      historyActions.className = "history-actions";
      historyActions.hidden = true;
      li.querySelector(".history-top").appendChild(historyMenu);
      historyMenu.addEventListener("click", function (event) {
        event.stopPropagation();
        historyActions.hidden = !historyActions.hidden;
        historyMenu.setAttribute("aria-expanded", historyActions.hidden ? "false" : "true");
      });
      li.querySelector(".history-preview").addEventListener("click", function () {
        li.querySelector('[data-act="open"]').click();
      });
      li.querySelector('[data-act="open"]').addEventListener("click", function () {
        currentId = c.id;
        if (typeof history !== "undefined" && history.replaceState) history.replaceState(null, "", "#chat=" + encodeURIComponent(c.id));
        renderThread();
        renderHistory();
        restoreDraft();
        renderPrivateNote();
        els.thread.scrollIntoView({ behavior: "smooth", block: "start" });
        els.composerInput.focus();
      });
      li.querySelector('[data-act="open"]').setAttribute("aria-label", "Reopen chat: " + titleFor(c));
      li.querySelector('[data-act="delete"]').addEventListener("click", function () {
        var deletedIndex = convos.indexOf(c);
        lastDeleted = { conversation: c, index: deletedIndex };
        convos = convos.filter(function (x) { return x.id !== c.id; });
        if (currentId === c.id) {
          currentId = null;
          renderThread();
        }
        save();
        if (els.undoDeleteBtn) els.undoDeleteBtn.hidden = false;
        els.composerInput.focus();
      });
      li.querySelector('[data-act="delete"]').setAttribute("aria-label", "Delete chat: " + titleFor(c));
      li.querySelector('[data-act="rename"]').addEventListener("click", function () {
        if (typeof window.prompt !== "function") return;
        var next = window.prompt("Name this chat", c.title || titleFor(c));
        if (next === null) return;
        next = next.trim().slice(0, 80);
        if (!next) return;
        c.title = next;
        c.updatedAt = Date.now();
        save();
      });
      li.querySelector('[data-act="rename"]').setAttribute("aria-label", "Rename chat: " + titleFor(c));
      li.querySelector('[data-act="pin"]').addEventListener("click", function () { c.pinned = !c.pinned; save(); });
      li.querySelector('[data-act="pin"]').setAttribute("aria-label", (c.pinned ? "Unpin " : "Pin ") + titleFor(c));
      li.querySelector('[data-act="duplicate"]').addEventListener("click", function () {
        var copy = Object.assign({}, c, { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), pinned: false, messages: c.messages.map(function (m) { return Object.assign({}, m); }), title: c.title ? "Copy of " + c.title : "Copy of " + titleFor(c) });
        convos.unshift(copy); currentId = copy.id; save(); renderThread(); restoreDraft(); renderPrivateNote(); els.composerInput.focus();
      });
      li.querySelector('[data-act="duplicate"]').setAttribute("aria-label", "Duplicate chat: " + titleFor(c));
      li.querySelector('[data-act="archive"]').addEventListener("click", function () { c.archived = !c.archived; save(); if (c.archived && currentId === c.id && !archivedOnly) { currentId = null; renderThread(); } });
      li.querySelector('[data-act="archive"]').setAttribute("aria-label", (c.archived ? "Unarchive " : "Archive ") + titleFor(c));
      els.historyList.appendChild(li);
    });
  }

  els.deleteAllBtn.addEventListener("click", function () {
    if (!confirm("Delete all saved chats from this browser? This can't be undone.")) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_KEY);
    }
    catch (err) { showStorageWarning("We couldn't clear storage — it may be blocked in this browser."); return; }
    convos = [];
    lastDeleted = null;
    if (els.undoDeleteBtn) els.undoDeleteBtn.hidden = true;
    currentId = null;
    renderThread();
    renderHistory();
    els.composerInput.focus();
  });

  if (els.deleteCurrentBtn) els.deleteCurrentBtn.addEventListener("click", function () {
    var c = current();
    if (!c || !confirm("Delete this chat from this browser? You can undo once.")) return;
    lastDeleted = { conversation: c, index: convos.indexOf(c) };
    convos = convos.filter(function (x) { return x.id !== c.id; }); currentId = null;
    save(); renderThread(); renderHistory();
    if (els.undoDeleteBtn) els.undoDeleteBtn.hidden = false;
    els.composerInput.focus();
  });

  if (els.undoDeleteBtn) els.undoDeleteBtn.addEventListener("click", function () {
    if (!lastDeleted) return;
    var index = Math.max(0, Math.min(lastDeleted.index, convos.length));
    convos.splice(index, 0, lastDeleted.conversation);
    currentId = lastDeleted.conversation.id;
    lastDeleted = null;
    els.undoDeleteBtn.hidden = true;
    save(); renderThread(); restoreDraft(); renderPrivateNote();
    els.composerInput.focus();
  });

  function download(name, content, type) {
    var blob = new Blob([content], { type: type || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function markdownForConversation(c) {
    var lines = ["# " + titleFor(c), "", "_Back to Center conversation · " + niceDate(c.updatedAt || c.createdAt) + "_", ""];
    c.messages.forEach(function (m) { lines.push("**" + (m.role === "user" ? "You" : "Back to Center") + "**", "", m.text, ""); });
    if (c.takeaway) lines.push("## Saved takeaway", "", c.takeaway, "");
    return lines.join("\n");
  }

  function exportName(c) {
    var safe = titleFor(c).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "chat";
    return "back-to-center-" + safe + ".md";
  }

  if (els.exportBtn) els.exportBtn.addEventListener("click", function () {
    download("back-to-center-chats-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), conversations: convos }, null, 2), "application/json;charset=utf-8");
  });
  if (els.exportCurrentBtn) els.exportCurrentBtn.addEventListener("click", function () {
    var c = current();
    if (!c || !c.messages.length) { showResponseStatus("Open a chat with at least one message first.", true); return; }
    download(exportName(c), markdownForConversation(c), "text/markdown;charset=utf-8");
  });
  if (els.shareCurrentBtn) els.shareCurrentBtn.addEventListener("click", async function () {
    var c = current();
    if (!c || !c.messages.length) { showResponseStatus("Open a chat with at least one message first.", true); return; }
    var markdown = markdownForConversation(c);
    if (navigator.share) {
      try { await navigator.share({ title: titleFor(c), text: markdown }); showResponseStatus("Shared from this device.", false); }
      catch (err) { if (err && err.name !== "AbortError") showResponseStatus("Sharing was not available. You can download the chat instead.", true); }
    } else {
      download(exportName(c), markdown, "text/markdown;charset=utf-8");
      showResponseStatus("Your browser does not support native sharing, so a Markdown copy was downloaded.", false);
    }
  });
  if (els.copyLinkBtn) els.copyLinkBtn.addEventListener("click", async function () {
    if (!current() || typeof window === "undefined" || !window.location) { showResponseStatus("Open a chat first.", true); return; }
    var link = window.location.href;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(link);
      else throw new Error("clipboard");
      showResponseStatus("Local chat link copied. It works in this browser profile.", false);
    } catch (_) { showResponseStatus("Your browser could not copy the local link.", true); }
  });
  if (els.importBtn && els.importInput) els.importBtn.addEventListener("click", function () { els.importInput.click(); });
  if (els.importInput) els.importInput.addEventListener("change", function () {
    var file = els.importInput.files && els.importInput.files[0];
    if (!file || file.size > 2 * 1024 * 1024) { showStorageWarning("That backup is too large to import."); return; }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        var incoming = Array.isArray(parsed) ? parsed : parsed.conversations;
        if (!Array.isArray(incoming)) throw new Error("invalid");
        var clean = incoming.filter(function (c) { return c && typeof c.id === "string" && Array.isArray(c.messages) && c.messages.length <= 48 && c.messages.every(function (m) { return m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.length <= 4000; }); }).map(function (c) { return Object.assign({}, c, { id: uid(), messages: c.messages.slice() }); });
        if (!clean.length) throw new Error("empty");
        convos = clean.concat(convos); currentId = clean[0].id; save(); renderThread(); restoreDraft();
      } catch (_) { showStorageWarning("That file is not a valid Back to Center backup."); }
      els.importInput.value = "";
    };
    reader.readAsText(file);
  });
  if (els.historySearch) els.historySearch.addEventListener("input", renderHistory);
  if (els.clearSearchBtn) els.clearSearchBtn.addEventListener("click", function () { els.historySearch.value = ""; renderHistory(); els.historySearch.focus(); });
  if (els.historySearch) els.historySearch.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && els.historySearch.value) { els.historySearch.value = ""; renderHistory(); }
  });
  function syncHistoryFilters() {
    if (els.activeChatsBtn) els.activeChatsBtn.setAttribute("aria-pressed", (!pinnedOnly && !archivedOnly) ? "true" : "false");
    if (els.pinnedOnlyBtn) els.pinnedOnlyBtn.setAttribute("aria-pressed", pinnedOnly ? "true" : "false");
    if (els.archivedBtn) els.archivedBtn.setAttribute("aria-pressed", archivedOnly ? "true" : "false");
  }
  if (els.activeChatsBtn) els.activeChatsBtn.addEventListener("click", function () {
    pinnedOnly = false; archivedOnly = false; syncHistoryFilters(); renderHistory();
  });
  if (els.pinnedOnlyBtn) els.pinnedOnlyBtn.addEventListener("click", function () {
    pinnedOnly = true; archivedOnly = false; syncHistoryFilters(); renderHistory();
  });
  if (els.archivedBtn) els.archivedBtn.addEventListener("click", function () {
    archivedOnly = true; pinnedOnly = false; syncHistoryFilters(); renderHistory();
  });
  if (els.checkHealthBtn) els.checkHealthBtn.addEventListener("click", async function () {
    els.checkHealthBtn.disabled = true;
    if (els.healthResult) els.healthResult.classList.remove("health-ok", "health-error");
    if (els.healthResult) els.healthResult.textContent = "Checking local server...";
    try {
      var response = await fetch("/api/health", { headers: { "Accept": "application/json" } });
      var data = await response.json();
      if (!response.ok || !data || data.status !== "ok") throw new Error("unavailable");
      if (els.healthResult) { els.healthResult.textContent = data.providerConfigured ? "Local server is connected. DeepInfra is configured." : "Local server is connected. Local fallback replies will be used automatically."; els.healthResult.classList.add("health-ok"); }
    } catch (_) {
      if (els.healthResult) { els.healthResult.textContent = "The local server could not be reached. The browser fallback can still respond."; els.healthResult.classList.add("health-error"); }
    } finally { els.checkHealthBtn.disabled = false; }
  });
  function applyTextScale() { document.documentElement.style.fontSize = (16 * textScale) + "px"; }
  function saveTextScale() { try { localStorage.setItem("back_to_center_text_scale_v1", String(textScale)); } catch (_) {} }
  if (els.textSmallerBtn) els.textSmallerBtn.addEventListener("click", function () { textScale = Math.max(0.9, +(textScale - 0.1).toFixed(1)); applyTextScale(); saveTextScale(); });
  if (els.textLargerBtn) els.textLargerBtn.addEventListener("click", function () { textScale = Math.min(1.25, +(textScale + 0.1).toFixed(1)); applyTextScale(); saveTextScale(); });
  if (els.textResetBtn) els.textResetBtn.addEventListener("click", function () { textScale = 1; applyTextScale(); saveTextScale(); });
  if (els.timestampsBtn) els.timestampsBtn.addEventListener("click", function () {
    timestampsOn = !timestampsOn; document.body.classList.toggle("hide-timestamps", !timestampsOn);
    els.timestampsBtn.setAttribute("aria-pressed", timestampsOn ? "true" : "false"); els.timestampsBtn.textContent = timestampsOn ? "Times on" : "Times off";
    try { localStorage.setItem("back_to_center_timestamps_v1", timestampsOn ? "1" : "0"); } catch (_) {}
  });

  /* ---------- ambient motion ---------- */
  if (typeof window !== "undefined" && window.addEventListener && document.documentElement) {
    var motionReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!motionReduced) {
      var pointerFrame = null;
      window.addEventListener("pointermove", function (event) {
        if (pointerFrame) return;
        pointerFrame = window.requestAnimationFrame ? window.requestAnimationFrame(function () {
          pointerFrame = null;
          document.documentElement.style.setProperty("--cursor-x", ((event.clientX / Math.max(1, window.innerWidth)) * 100).toFixed(2));
          document.documentElement.style.setProperty("--cursor-y", ((event.clientY / Math.max(1, window.innerHeight)) * 100).toFixed(2));
        }) : setTimeout(function () {
          pointerFrame = null;
          document.documentElement.style.setProperty("--cursor-x", ((event.clientX / Math.max(1, window.innerWidth)) * 100).toFixed(2));
          document.documentElement.style.setProperty("--cursor-y", ((event.clientY / Math.max(1, window.innerHeight)) * 100).toFixed(2));
        }, 16);
      }, { passive: true });
    }
  }

  /* ---------- init ---------- */
  convos = loadConvos();
  // Open the most recent chat, or a blank thread.
  var hashChat = typeof window !== "undefined" && window.location && window.location.hash ? window.location.hash.match(/^#chat=([^&]+)/) : null;
  var hashId = hashChat ? decodeURIComponent(hashChat[1]) : null;
  if (hashId && convos.some(function (c) { return c.id === hashId; })) currentId = hashId;
  else if (convos.length) currentId = convos[0].id;
  if (hashId && currentId) showChatView(); else showHomeView();
  renderThread();
  renderHistory();
  renderAccount();
  try {
    var authHash = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
    if (authHash.get("type") === "recovery" && authHash.get("access_token")) setTimeout(function () { openAuth("set-password"); }, 0);
  } catch (_) {}
  if (typeof window !== "undefined" && window.location && window.location.origin) {
    authRequest("/api/auth/me").then(async function (data) {
      accountUser = data && data.authenticated ? data.user : null;
      renderAccount();
      if (accountUser) { await syncLocalChats({ automatic: true }); await loadAccountChats(); }
    }).catch(function () { renderAccount(); });
  }
  restoreDraft();
  updateCharCount();
  loadFocusTimer();
  renderFocus();
  startFocusLoop();
  setSidebar(false);
  try { localStorage.removeItem("back_to_center_offline_v1"); } catch (_) {}
  try {
    if (localStorage.getItem("back_to_center_theme_v1") === "night" && els.themeBtn) {
      document.body.setAttribute("data-theme", "night"); els.themeBtn.setAttribute("aria-pressed", "true"); els.themeBtn.textContent = "Day theme";
    }
  } catch (_) {}
  try {
    var storedScale = parseFloat(localStorage.getItem("back_to_center_text_scale_v1"));
    if (storedScale >= 0.9 && storedScale <= 1.25) { textScale = storedScale; if (document.documentElement) applyTextScale(); }
  } catch (_) {}
  try {
    if (localStorage.getItem("back_to_center_timestamps_v1") === "0" && els.timestampsBtn) {
      timestampsOn = false; document.body.classList.add("hide-timestamps"); els.timestampsBtn.setAttribute("aria-pressed", "false"); els.timestampsBtn.textContent = "Times off";
    }
  } catch (_) {}
  if (typeof navigator !== "undefined" && navigator.serviceWorker) {
    navigator.serviceWorker.register("/sw.js?v=20261039").catch(function () { /* installability is optional */ });
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault(); deferredInstall = event;
      if (els.installBtn) els.installBtn.hidden = false;
    });
    window.addEventListener("appinstalled", function () { deferredInstall = null; if (els.installBtn) els.installBtn.hidden = true; });
  }
  if (els.installBtn) els.installBtn.addEventListener("click", async function () {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (_) {}
    deferredInstall = null; els.installBtn.hidden = true;
  });
})();
