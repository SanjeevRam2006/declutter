/* Declutter voice UI: ElevenLabs Conversational AI plus browser dictation. */
const elevenLabsModuleUrl = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.28.0/+esm";
const voiceEls = Object.fromEntries(["voiceBtn", "voiceView", "voiceBackBtn", "voiceStartBtn", "voiceMuteBtn", "voiceEndBtn", "voiceStatus", "voiceError", "voiceOrb", "dictationBtn", "dictationLabel", "homeView", "chatView", "focusScreen"].map((id) => [id, document.getElementById(id)]));
let voiceSession = null;
let voiceStarting = false;
let voiceEnding = false;
let dictation = null;
let dictating = false;
let dictationStopping = false;
let previousView = "home";

function setVoiceError(message) {
  if (!voiceEls.voiceError) return;
  voiceEls.voiceError.textContent = message || "";
  voiceEls.voiceError.hidden = !message;
}

function setVoiceStatus(message, state) {
  if (voiceEls.voiceStatus) voiceEls.voiceStatus.textContent = message;
  if (voiceEls.voiceView) voiceEls.voiceView.dataset.voiceState = state || "idle";
  if (voiceEls.voiceOrb) voiceEls.voiceOrb.classList.toggle("active", state === "speaking" || state === "listening");
}

function showVoicePage() {
  if (!voiceEls.voiceView) return;
  window.dispatchEvent(new Event("declutter:voice-open"));
  previousView = voiceEls.chatView && !voiceEls.chatView.hidden ? "chat" : "home";
  if (voiceEls.homeView) voiceEls.homeView.hidden = true;
  if (voiceEls.chatView) voiceEls.chatView.hidden = true;
  if (voiceEls.focusScreen) voiceEls.focusScreen.hidden = true;
  voiceEls.voiceView.hidden = false;
  document.body.classList.add("voice-view");
  document.body.classList.remove("chat-view", "focus-mode");
  setVoiceError("");
  setVoiceStatus(voiceSession ? "Budd is here." : "Ready when you are.", voiceSession ? "listening" : "idle");
}

function hideVoicePage() {
  if (!voiceEls.voiceView) return;
  voiceEls.voiceView.hidden = true;
  document.body.classList.remove("voice-view");
  if (previousView === "chat" && voiceEls.chatView) {
    voiceEls.chatView.hidden = false;
    document.body.classList.add("chat-view");
  } else if (voiceEls.homeView) {
    voiceEls.homeView.hidden = false;
  }
}

async function endVoiceSession() {
  if (voiceEnding) return;
  voiceEnding = true;
  const active = voiceSession;
  voiceSession = null;
  if (active && typeof active.endSession === "function") {
    try { await active.endSession(); } catch (_) { /* cleanup is best effort */ }
  }
  if (voiceEls.voiceStartBtn) voiceEls.voiceStartBtn.hidden = false;
  if (voiceEls.voiceMuteBtn) voiceEls.voiceMuteBtn.hidden = true;
  if (voiceEls.voiceEndBtn) voiceEls.voiceEndBtn.hidden = true;
  setVoiceStatus("Call ended. Your microphone is off.", "idle");
  voiceEnding = false;
}

async function startVoiceSession() {
  if (voiceStarting || voiceSession) return;
  voiceStarting = true;
  setVoiceError("");
  if (voiceEls.voiceStartBtn) voiceEls.voiceStartBtn.disabled = true;
  setVoiceStatus("Requesting microphone access...", "connecting");
  let permissionStream;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("This browser does not support microphone access.");
    permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    permissionStream.getTracks().forEach((track) => track.stop());
    const response = await fetch("/api/voice/signed-url", { headers: { Accept: "application/json" }, credentials: "same-origin" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.signedUrl) throw new Error(data.error || "Budd is unavailable right now.");
    const sdk = await import(elevenLabsModuleUrl);
    const Conversation = sdk.Conversation || sdk.default?.Conversation;
    if (!Conversation || typeof Conversation.startSession !== "function") throw new Error("The voice client could not load. Please refresh and try again.");
    voiceSession = await Conversation.startSession({
      signedUrl: data.signedUrl,
      overrides: { agent: { firstMessage: "Hey. What's on your mind?" } },
      onConnect: () => {
        if (voiceEls.voiceStartBtn) voiceEls.voiceStartBtn.hidden = true;
        if (voiceEls.voiceEndBtn) voiceEls.voiceEndBtn.hidden = false;
        if (voiceEls.voiceMuteBtn && (typeof voiceSession?.setMicMuted === "function" || typeof voiceSession?.setMuted === "function")) voiceEls.voiceMuteBtn.hidden = false;
        setVoiceStatus("Connected. Budd is listening.", "listening");
      },
      onDisconnect: () => { if (!voiceEnding) endVoiceSession(); },
      onError: (error) => { setVoiceError(error?.message || "The voice connection was interrupted."); setVoiceStatus("Connection problem", "error"); },
      onModeChange: (mode) => { const speaking = mode && mode.mode === "speaking"; setVoiceStatus(speaking ? "Budd is speaking..." : "Budd is listening...", speaking ? "speaking" : "listening"); },
    });
  } catch (error) {
    if (permissionStream) permissionStream.getTracks().forEach((track) => track.stop());
    voiceSession = null;
    if (error?.name === "NotAllowedError") setVoiceError("Microphone access was blocked. Allow microphone access in your browser, then try again.");
    else setVoiceError(error?.message || "Could not start voice chat.");
    setVoiceStatus("Not connected", "error");
    if (voiceEls.voiceStartBtn) voiceEls.voiceStartBtn.hidden = false;
  } finally {
    voiceStarting = false;
    if (voiceEls.voiceStartBtn) voiceEls.voiceStartBtn.disabled = false;
  }
}

function toggleVoiceMute() {
  if (!voiceSession) return;
  const button = voiceEls.voiceMuteBtn;
  const muted = button?.getAttribute("aria-pressed") === "true";
  const next = !muted;
  try {
    if (typeof voiceSession.setMicMuted === "function") voiceSession.setMicMuted(next);
    else if (typeof voiceSession.setMuted === "function") voiceSession.setMuted(next);
    else return;
    if (button) { button.setAttribute("aria-pressed", String(next)); button.textContent = next ? "Unmute mic" : "Mute mic"; }
    setVoiceStatus(next ? "Mic muted. Budd is waiting." : "Budd is listening.", next ? "muted" : "listening");
  } catch (_) { setVoiceError("Could not change microphone state."); }
}

function showDictationError(message) {
  const status = document.getElementById("responseStatus");
  if (status) { status.textContent = message; status.classList.add("error"); status.hidden = false; }
}

function finishDictation() {
  dictating = false;
  dictationStopping = false;
  if (voiceEls.dictationBtn) { voiceEls.dictationBtn.setAttribute("aria-pressed", "false"); voiceEls.dictationBtn.classList.remove("recording"); }
  if (voiceEls.dictationLabel) voiceEls.dictationLabel.textContent = "Dictate";
}

function toggleDictation() {
  if (dictating && dictation) {
    dictationStopping = true;
    try { if (typeof dictation.abort === "function") dictation.abort(); else dictation.stop(); } catch (_) {}
    finishDictation();
    dictation = null;
    return;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { showDictationError("Voice dictation is not supported in this browser. You can still type your message."); return; }
  dictation = new SpeechRecognition();
  dictation.lang = document.documentElement.lang || "en-US";
  dictation.continuous = false;
  dictation.interimResults = true;
  const input = document.getElementById("composerInput");
  const startingText = input ? input.value.trim() : "";
  dictating = true; dictationStopping = false;
  if (voiceEls.dictationBtn) { voiceEls.dictationBtn.setAttribute("aria-pressed", "true"); voiceEls.dictationBtn.classList.add("recording"); }
  if (voiceEls.dictationLabel) voiceEls.dictationLabel.textContent = "Stop dictation";
  dictation.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) transcript += event.results[i][0].transcript;
    if (input && transcript) { input.value = (startingText ? startingText + " " : "") + transcript.trim(); input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); }
  };
  dictation.onerror = (event) => {
    const reason = event.error;
    finishDictation();
    dictation = null;
    if (reason === "aborted") return;
    const messages = {
      "not-allowed": "Microphone access was blocked. Allow it for this site, then try again.",
      "service-not-allowed": "Speech recognition is unavailable in this browser. Try Chrome or type your message.",
      "no-speech": "No speech was detected. Speak closer to the microphone and try again.",
      "audio-capture": "No microphone was detected. Check your microphone and try again.",
      network: "Browser speech recognition could not reach its service. Check your connection and try again."
    };
    showDictationError(messages[reason] || "Dictation could not hear that. Check your microphone and try again.");
  };
  dictation.onend = () => { finishDictation(); dictation = null; };
  try { dictation.start(); } catch (_) { finishDictation(); showDictationError("Dictation could not start. Try again."); }
}

voiceEls.voiceBtn?.addEventListener("click", showVoicePage);
voiceEls.voiceBackBtn?.addEventListener("click", async () => { await endVoiceSession(); hideVoicePage(); });
voiceEls.voiceStartBtn?.addEventListener("click", startVoiceSession);
voiceEls.voiceMuteBtn?.addEventListener("click", toggleVoiceMute);
voiceEls.voiceEndBtn?.addEventListener("click", endVoiceSession);
voiceEls.dictationBtn?.addEventListener("click", toggleDictation);
window.addEventListener("declutter:focus-open", () => {
  if (!document.body.classList.contains("voice-view")) return;
  endVoiceSession();
  hideVoicePage();
});
window.addEventListener("declutter:chat-open", () => {
  if (!document.body.classList.contains("voice-view")) return;
  endVoiceSession();
  hideVoicePage();
});
window.addEventListener("pagehide", () => { if (voiceSession) endVoiceSession(); if (dictation) { try { dictation.stop(); } catch (_) {} } });
