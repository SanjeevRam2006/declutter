/* Declutter voice UI: push-to-talk ElevenLabs STT -> DeepInfra -> ElevenLabs TTS. */
const voiceEls = Object.fromEntries(["voiceBtn", "voiceView", "voiceBackBtn", "voiceStartBtn", "voiceMuteBtn", "voiceEndBtn", "voiceStatus", "voiceError", "voiceOrb", "voiceTranscript", "voiceReply", "dictationBtn", "homeView", "chatView", "focusScreen"].map((id) => [id, document.getElementById(id)]));
let recordingStream = null;
let recorder = null;
let recordingChunks = [];
let recording = false;
let voiceBusy = false;
let voiceAudio = null;
let dictation = null;
let dictating = false;
let previousView = "home";
let voiceHistory = [];
let discardRecording = false;
let voiceRecognition = null;

function setVoiceError(message) { if (!voiceEls.voiceError) return; voiceEls.voiceError.textContent = message || ""; voiceEls.voiceError.hidden = !message; }
function setVoiceStatus(message, state) {
  const currentState = state || "idle";
  if (voiceEls.voiceStatus) voiceEls.voiceStatus.textContent = message;
  if (voiceEls.voiceView) voiceEls.voiceView.dataset.voiceState = currentState;
  if (voiceEls.voiceOrb) {
    voiceEls.voiceOrb.classList.toggle("active", ["speaking", "listening", "recording", "thinking"].includes(currentState));
    voiceEls.voiceOrb.classList.toggle("speaking", currentState === "speaking");
    voiceEls.voiceOrb.classList.toggle("thinking", currentState === "thinking");
  }
}

function showVoicePage() {
  if (!voiceEls.voiceView) return;
  window.dispatchEvent(new Event("declutter:voice-open"));
  previousView = voiceEls.chatView && !voiceEls.chatView.hidden ? "chat" : "home";
  if (voiceEls.homeView) voiceEls.homeView.hidden = true;
  if (voiceEls.chatView) voiceEls.chatView.hidden = true;
  if (voiceEls.focusScreen) voiceEls.focusScreen.hidden = true;
  voiceEls.voiceView.hidden = false; document.body.classList.add("voice-view"); document.body.classList.remove("chat-view", "focus-mode");
  setVoiceError(""); setVoiceStatus("Ready when you are.", "idle");
}
function hideVoicePage() {
  if (!voiceEls.voiceView) return;
  voiceEls.voiceView.hidden = true; document.body.classList.remove("voice-view");
  if (previousView === "chat" && voiceEls.chatView) { voiceEls.chatView.hidden = false; document.body.classList.add("chat-view"); } else if (voiceEls.homeView) voiceEls.homeView.hidden = false;
}
function stopStream() { if (recordingStream) recordingStream.getTracks().forEach((track) => track.stop()); recordingStream = null; }
function stopAudio() { if (!voiceAudio) return; voiceAudio.pause(); voiceAudio.src = ""; voiceAudio = null; }
function resetVoiceControls() { if (voiceEls.voiceStartBtn) { voiceEls.voiceStartBtn.hidden = false; voiceEls.voiceStartBtn.disabled = false; voiceEls.voiceStartBtn.textContent = "● Start recording"; } if (voiceEls.voiceEndBtn) voiceEls.voiceEndBtn.hidden = true; if (voiceEls.voiceMuteBtn) voiceEls.voiceMuteBtn.hidden = true; }
async function endVoiceSession() { discardRecording = true; if (voiceRecognition) { try { voiceRecognition.abort(); } catch (_) {} voiceRecognition = null; } if (recorder && recorder.state !== "inactive") recorder.stop(); recorder = null; recording = false; stopStream(); stopAudio(); voiceBusy = false; resetVoiceControls(); setVoiceStatus("Ready when you are.", "idle"); }
function recordingType() { if (typeof MediaRecorder === "undefined") return ""; return MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm"; }

async function transcribe(blob) {
  const form = new FormData(); form.append("file", blob, "recording.webm");
  const response = await fetch("/api/voice/transcribe", { method: "POST", body: form, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.text !== "string") throw new Error(data.error || "Could not transcribe that recording.");
  return data.text.trim();
}
async function requestVoiceReply(text) {
  const messages = voiceHistory.concat([{ role: "user", content: text }]).slice(-24);
  const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }), credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.text !== "string") throw new Error(data.error || "Budd could not reply right now.");
  voiceHistory = messages.concat([{ role: "assistant", content: data.text }]).slice(-24); return data.text;
}
async function speak(text) {
  const response = await fetch("/api/voice/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), credentials: "same-origin" });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "Could not play Budd's response."); }
  const url = URL.createObjectURL(await response.blob()); stopAudio(); voiceAudio = new Audio(url);
  voiceAudio.onended = () => { URL.revokeObjectURL(url); voiceAudio = null; setVoiceStatus("Ready for your next thought.", "idle"); resetVoiceControls(); };
  await voiceAudio.play();
}
async function processRecording(blob) {
  voiceBusy = true; if (voiceEls.voiceStartBtn) voiceEls.voiceStartBtn.disabled = true;
  try {
    setVoiceStatus("Transcribing...", "thinking"); const text = await transcribe(blob);
    if (!text) throw new Error("No speech was detected. Try speaking a little closer to the microphone.");
    if (voiceEls.voiceTranscript) voiceEls.voiceTranscript.textContent = text;
    setVoiceStatus("Budd is thinking...", "thinking"); const reply = await requestVoiceReply(text);
    if (voiceEls.voiceReply) voiceEls.voiceReply.textContent = reply;
    setVoiceStatus("Budd is speaking...", "speaking"); await speak(reply);
  } catch (error) { setVoiceError(error?.message || "Voice chat could not complete that turn."); setVoiceStatus("Ready when you are.", "error"); resetVoiceControls(); }
  finally { voiceBusy = false; }
}
async function processTranscript(text) {
  voiceBusy = true; if (voiceEls.voiceStartBtn) voiceEls.voiceStartBtn.disabled = true;
  try {
    if (!text) throw new Error("No speech was detected. Try again.");
    if (voiceEls.voiceTranscript) voiceEls.voiceTranscript.textContent = text;
    setVoiceStatus("Budd is thinking...", "thinking"); const reply = await requestVoiceReply(text);
    if (voiceEls.voiceReply) voiceEls.voiceReply.textContent = reply;
    setVoiceStatus("Budd is speaking...", "speaking"); await speak(reply);
  } catch (error) { setVoiceError(error?.message || "Voice chat could not complete that turn."); setVoiceStatus("Ready when you are.", "error"); resetVoiceControls(); }
  finally { voiceBusy = false; }
}
async function startVoiceSession() {
  if (voiceBusy || recording) return; setVoiceError("");
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    voiceRecognition = new SpeechRecognition(); voiceRecognition.lang = document.documentElement.lang || "en-US"; voiceRecognition.continuous = false; voiceRecognition.interimResults = true;
    let transcript = "";
    voiceRecognition.onresult = (event) => {
      // Keep all final/interim segments instead of replacing the transcript on
      // every result event. Some browsers emit several chunks for one sentence.
      transcript = "";
      for (let i = 0; i < event.results.length; i += 1) transcript += event.results[i][0].transcript;
      if (voiceEls.voiceTranscript && transcript.trim()) voiceEls.voiceTranscript.textContent = transcript.trim();
    };
    voiceRecognition.onerror = (event) => {
      voiceRecognition = null; recording = false; resetVoiceControls();
      const messages = {
        "not-allowed": "Microphone access was blocked. Click the lock icon beside the address bar, allow Microphone, then reload.",
        "audio-capture": "No microphone was found. Connect a microphone and try again.",
        "no-speech": "I didn't hear speech. Speak for a moment after the button changes to Stop listening.",
        "network": "Your browser's speech service is unavailable. Try Chrome or Edge, disable VPN/ad-blocking, and try again.",
        "aborted": "Listening was cancelled."
      };
      setVoiceError(messages[event.error] || `Speech recognition failed (${event.error || "unknown error"}). Try Chrome or Edge.`);
      setVoiceStatus("Ready when you are.", "error");
    };
    voiceRecognition.onend = () => { voiceRecognition = null; recording = false; if (transcript.trim()) processTranscript(transcript.trim()); else { resetVoiceControls(); setVoiceStatus("Ready when you are.", "idle"); } };
    try { voiceRecognition.start(); recording = true; if (voiceEls.voiceStartBtn) voiceEls.voiceStartBtn.textContent = "■ Stop listening"; if (voiceEls.voiceEndBtn) voiceEls.voiceEndBtn.hidden = false; setVoiceStatus("Listening... tap stop when you're done.", "recording"); } catch (_) { voiceRecognition = null; setVoiceError("Could not start microphone input. Try again."); }
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setVoiceError("This browser cannot record audio. Try the latest Chrome or Edge."); return; }
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true }); const type = recordingType();
    recorder = new MediaRecorder(recordingStream, type ? { mimeType: type } : undefined); recordingChunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) recordingChunks.push(event.data); };
    discardRecording = false;
    recorder.onstop = () => { stopStream(); const blob = new Blob(recordingChunks, { type: type || "audio/webm" }); recordingChunks = []; if (!discardRecording && blob.size) processRecording(blob); discardRecording = false; };
    recorder.start(); recording = true;
    if (voiceEls.voiceStartBtn) { voiceEls.voiceStartBtn.textContent = "■ Stop recording"; voiceEls.voiceStartBtn.hidden = false; }
    if (voiceEls.voiceEndBtn) voiceEls.voiceEndBtn.hidden = false; setVoiceStatus("Listening... tap stop when you're done.", "recording");
  } catch (error) { stopStream(); setVoiceError(error?.name === "NotAllowedError" ? "Microphone access was blocked. Allow it for this site, then try again." : "Could not start recording."); setVoiceStatus("Ready when you are.", "error"); }
}
function toggleRecording() { if (recording) { recording = false; if (voiceRecognition) { try { voiceRecognition.stop(); } catch (_) {} setVoiceStatus("Preparing your message...", "thinking"); } else if (recorder && recorder.state !== "inactive") { recorder.stop(); setVoiceStatus("Preparing your message...", "thinking"); } } else startVoiceSession(); }
function toggleVoiceMute() { /* Push-to-talk has no open microphone session to mute. */ }

function showDictationError(message) { const status = document.getElementById("responseStatus"); if (status) { status.textContent = message; status.classList.add("error"); status.hidden = false; } }
function finishDictation() { dictating = false; if (voiceEls.dictationBtn) { voiceEls.dictationBtn.setAttribute("aria-pressed", "false"); voiceEls.dictationBtn.setAttribute("aria-label", "Start dictation"); voiceEls.dictationBtn.title = "Start dictation"; voiceEls.dictationBtn.classList.remove("recording"); } }
function toggleDictation() {
  if (dictating && dictation) { try { dictation.abort(); } catch (_) {} finishDictation(); dictation = null; return; }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { showDictationError("Voice dictation is not supported in this browser. You can still type your message."); return; }
  dictation = new SpeechRecognition(); dictation.lang = document.documentElement.lang || "en-US"; dictation.continuous = false; dictation.interimResults = true;
  const input = document.getElementById("composerInput"); const startingText = input ? input.value.trim() : ""; dictating = true;
  if (voiceEls.dictationBtn) { voiceEls.dictationBtn.setAttribute("aria-pressed", "true"); voiceEls.dictationBtn.setAttribute("aria-label", "Stop dictation"); voiceEls.dictationBtn.title = "Stop dictation"; voiceEls.dictationBtn.classList.add("recording"); }
  dictation.onresult = (event) => { let transcript = ""; for (let i = event.resultIndex; i < event.results.length; i += 1) transcript += event.results[i][0].transcript; if (input && transcript) { input.value = (startingText ? startingText + " " : "") + transcript.trim(); input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); } };
  dictation.onerror = (event) => { const reason = event.error; finishDictation(); dictation = null; if (reason === "aborted") return; showDictationError(reason === "not-allowed" ? "Microphone access was blocked. Allow it for this site, then try again." : reason === "no-speech" ? "No speech was detected. Try again." : "Dictation could not hear that. Check your microphone and try again."); };
  dictation.onend = () => { finishDictation(); dictation = null; }; try { dictation.start(); } catch (_) { finishDictation(); showDictationError("Dictation could not start. Try again."); }
}

voiceEls.voiceBtn?.addEventListener("click", showVoicePage);
voiceEls.voiceBackBtn?.addEventListener("click", async () => { await endVoiceSession(); hideVoicePage(); });
voiceEls.voiceStartBtn?.addEventListener("click", toggleRecording);
voiceEls.voiceMuteBtn?.addEventListener("click", toggleVoiceMute);
voiceEls.voiceEndBtn?.addEventListener("click", endVoiceSession);
voiceEls.dictationBtn?.addEventListener("click", toggleDictation);
window.addEventListener("declutter:focus-open", () => { if (document.body.classList.contains("voice-view")) { endVoiceSession(); hideVoicePage(); } });
window.addEventListener("declutter:chat-open", () => { if (document.body.classList.contains("voice-view")) { endVoiceSession(); hideVoicePage(); } });
window.addEventListener("pagehide", () => { endVoiceSession(); if (dictation) { try { dictation.stop(); } catch (_) {} } });
