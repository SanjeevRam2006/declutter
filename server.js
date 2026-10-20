/* Back to Center — local HTTP server and DeepInfra bridge. Node 20+. */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { generateReply, conversationGuard, contradictsGuardrail } = require("./responder.js");
const { safetyReply } = require("./safety.js");

const ROOT = __dirname;
const ACCOUNT_FILE = path.join(ROOT, "data", "users.json");
const ENDPOINT = "https://api.deepinfra.com/v1/openai/chat/completions";
const STT_ENDPOINT = "https://api.deepinfra.com/v1/openai/audio/transcriptions";
const TTS_ENDPOINT = "https://api.deepinfra.com/v1/openai/audio/speech";
const DEFAULT_MODEL = "meta-llama/Llama-3.3-70B-Instruct-Turbo";
const DEFAULT_STT_MODEL = "openai/whisper-small";
const DEFAULT_TTS_MODEL = "hexgrad/Kokoro-82M";
const DEFAULT_TTS_VOICE = "af_bella";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 4000;
const MAX_CONTEXT_CHARS = 24000;
const PUBLIC_FILES = new Map([
  ["/index.html", "text/html; charset=utf-8"],
  ["/styles.css", "text/css; charset=utf-8"],
  ["/app.js", "text/javascript; charset=utf-8"],
  ["/responder.js", "text/javascript; charset=utf-8"],
  ["/safety.js", "text/javascript; charset=utf-8"],
  ["/voice.js", "text/javascript; charset=utf-8"],
  ["/manifest.json", "application/manifest+json; charset=utf-8"],
  ["/sw.js", "text/javascript; charset=utf-8"]
]);

const SYSTEM_PROMPT = [
  "You are Back to Center, a calm thinking companion. Help the person get clear about the actual worry, decision, frustration, or overloaded thought in front of them.",
  "Reply in natural prose, usually 2–5 short sentences. Be direct, grounded, and emotionally aware without sounding clinical or like a therapist. Do not diagnose, claim to provide therapy, invent facts, or offer empty reassurance.",
  "Treat the user's words as the source of truth about their own state. Never assume they are sad, anxious, overwhelmed, distressed, hiding feelings, or in denial without clear evidence in what they said. If they say they are fine, good, happy, calm, or not upset, accept that plainly and move on without probing or contradicting them.",
  "Do not turn short, casual, playful, sarcastic, ambiguous, or disagreement messages into emotional analysis. Do not initiate therapy-style probing or canned reassurance when no problem was expressed. Match the intent: be casual with casual conversation, practical with practical requests, and thoughtful with an actual worry or dilemma.",
  "For a simple greeting or casual opening, respond neutrally and naturally (for example, 'Hey. What's on your mind?'). Do not assume the person feels down, need advice, or wants emotional analysis. If they are venting, listen first and ask at most one thoughtful follow-up when it would genuinely help.",
  "If you make an incorrect assumption and the user corrects you, acknowledge it briefly, apologize if useful, and follow the correction. Never defend the assumption or treat disagreement as proof that it was right.",
  "Use the conversation so far. For a worry, identify a useful perspective and one realistic next step when appropriate. For a decision, clarify the real trade-off. For overload, name the core issue without prescribing a productivity system.",
  "Gently challenge an unsupported assumption when useful. Ask at most one focused question, and only if information is truly needed. Do not repeatedly ask questions, use headings or bullet lists, or turn every reply into a fixed template.",
  "If someone appears to be in danger, encourage immediate human help. Keep the response brief."
].join("\n");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com; img-src 'self' data:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com https://api.elevenlabs.io https://*.elevenlabs.io wss://*.elevenlabs.io; media-src 'self' blob:; font-src 'self' https://fonts.gstatic.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(body);
}

function createAuthStore(file = ACCOUNT_FILE) {
  let users = {};
  const sessions = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.users && typeof parsed.users === "object") users = parsed.users;
  } catch (_) { /* first run or unavailable file */ }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify({ version: 1, users }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
  }
  function validPassword(password, record) {
    try {
      const actual = crypto.scryptSync(password, record.salt, 64);
      const expected = Buffer.from(record.hash, "hex");
      return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
    } catch (_) { return false; }
  }
  function normalizeUsername(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
  }
  function publicUser(user) { return { id: user.id, username: user.username, createdAt: user.createdAt }; }
  function createUser(username, password) {
    const key = normalizeUsername(username);
    if (!/^[a-z0-9_-]{3,32}$/.test(key)) return { error: "invalid_username" };
    if (typeof password !== "string" || password.length < 8 || password.length > 200) return { error: "invalid_password" };
    if (users[key]) return { error: "username_taken" };
    const hashed = hashPassword(password);
    const user = { id: "u_" + crypto.randomBytes(12).toString("hex"), username: key, salt: hashed.salt, hash: hashed.hash, createdAt: Date.now(), chats: [] };
    users[key] = user;
    persist();
    return { user };
  }
  function authenticate(username, password) {
    const user = users[normalizeUsername(username)];
    return user && validPassword(password, user) ? user : null;
  }
  function session(user) {
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, user.id);
    return token;
  }
  function userFromToken(token) {
    if (!token) return null;
    const userId = sessions.get(token);
    if (!userId) return null;
    return Object.values(users).find((user) => user.id === userId) || null;
  }
  function removeSession(token) { if (token) sessions.delete(token); }
  return { users, normalizeUsername, createUser, authenticate, session, userFromToken, removeSession, publicUser, persist };
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((part) => part.trim().split("=")).filter((part) => part[0]).map(([key, ...value]) => [key, decodeURIComponent(value.join("="))]));
}

function sessionCookie(token) { return `declutter_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`; }
function clearSessionCookie() { return "declutter_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"; }

function validLocalOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || (req.socket && req.socket.encrypted ? "https" : "http");
  if (host && origin === `${protocol}://${host}`) return true;
  const port = req.socket && req.socket.localPort;
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

function validateAccountInput(body, requireConfirmation) {
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") return "invalid_credentials";
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(body.username.trim())) return "invalid_username";
  if (body.password.length < 8 || body.password.length > 200) return "invalid_password";
  if (requireConfirmation && body.password !== body.confirmPassword) return "password_mismatch";
  return null;
}

function validateSavedConversation(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.messages) || value.messages.length > 48 || value.messages.length === 0) return null;
  const messages = value.messages.map((message) => {
    if (!message || (message.role !== "user" && message.role !== "assistant") || typeof message.text !== "string" || !message.text.trim() || message.text.length > MAX_MESSAGE_CHARS) return null;
    return { role: message.role, text: message.text.trim(), at: Number.isFinite(message.at) ? message.at : Date.now() };
  });
  if (messages.some((message) => !message)) return null;
  return { id: typeof value.id === "string" ? value.id.slice(0, 100) : "", title: typeof value.title === "string" ? value.title.slice(0, 80) : "", messages, savedAt: Date.now() };
}

function error(res, status, code, message) {
  sendJson(res, status, { error: message, code });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject({ status: 413, code: "payload_too_large", message: "The request is too large." });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => {
      if (!settled) reject({ status: 400, code: "request_error", message: "Could not read the request." });
    });
  });
}

function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject({ status: 413, code: "payload_too_large", message: "The audio recording is too large." });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!settled) resolve(Buffer.concat(chunks)); });
    req.on("error", () => { if (!settled) reject({ status: 400, code: "request_error", message: "Could not read the audio recording." }); });
  });
}

function parseAudioMultipart(body, contentType) {
  const match = String(contentType || "").match(/boundary=([^;]+)/i);
  if (!match) return null;
  const boundary = Buffer.from("--" + match[1].replace(/^"|"$/g, ""));
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"));
  if (headerEnd < 0) return null;
  const dataStart = headerEnd + 4;
  const dataEnd = body.indexOf(Buffer.from("\r\n"), dataStart);
  const nextBoundary = body.indexOf(Buffer.from("\r\n"), dataStart);
  const boundaryStart = body.indexOf(boundary, dataStart);
  if (boundaryStart < 0) return null;
  const headers = body.slice(0, headerEnd).toString("utf8");
  if (!/name="file"/i.test(headers)) return null;
  const filename = (headers.match(/filename="([^"]*)"/i) || [])[1] || "recording.webm";
  const type = (headers.match(/content-type:\s*([^\r\n]+)/i) || [])[1] || "audio/webm";
  const end = boundaryStart >= dataStart ? boundaryStart : dataEnd;
  if (end <= dataStart) return null;
  return { data: body.slice(dataStart, end), filename, type: type.trim() };
}

function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return null;
  const messages = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        (item.role !== "user" && item.role !== "assistant") ||
        typeof item.content !== "string" || !item.content.trim() ||
        item.content.length > MAX_MESSAGE_CHARS) return null;
    messages.push({ role: item.role, content: item.content.trim() });
  }
  if (messages.at(-1).role !== "user") return null;
  return messages;
}

function boundedContext(messages) {
  const selected = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const remaining = MAX_CONTEXT_CHARS - size;
    if (remaining <= 0) break;
    const message = messages[i];
    selected.unshift({ role: message.role, content: message.content.slice(-remaining) });
    size += selected[0].content.length;
  }
  return selected;
}

function fallback(messages, reason) {
  const last = messages.at(-1).content;
  const result = generateReply(last, {
    userTurns: messages.filter((m) => m.role === "user").slice(0, -1).map((m) => m.content)
  });
  if (!result || !result.text) return null;
  return { text: result.text, source: "fallback", reason, questionKey: result.questionKey || null };
}

async function callDeepInfra(messages, config, fetchImpl) {
  const signal = AbortSignal.timeout(config.timeoutMs);
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        temperature: 0.5,
        max_tokens: 300,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...boundedContext(messages)]
      }),
      redirect: "error",
      signal
    });
  } catch (cause) {
    return { reason: signal.aborted || cause?.name === "TimeoutError" ? "timeout" : "network_error" };
  }
  if (!response.ok) {
    return { reason: response.status === 401 || response.status === 403 ? "auth_error" :
      response.status === 429 ? "rate_limited" : "provider_error" };
  }
  try {
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return { reason: "invalid_response" };
    return { text: text.trim(), source: "deepinfra" };
  } catch (_) {
    return { reason: "invalid_response" };
  }
}

function configFromEnv(env = process.env) {
  const port = Number(env.PORT);
  const timeout = Number(env.AI_TIMEOUT_MS);
  return {
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 8080,
    timeoutMs: Number.isInteger(timeout) && timeout >= 1000 && timeout <= 120000 ? timeout : 30000,
    model: env.DEEPINFRA_MODEL?.trim() || DEFAULT_MODEL,
    sttModel: env.DEEPINFRA_STT_MODEL?.trim() || DEFAULT_STT_MODEL,
    ttsModel: env.DEEPINFRA_TTS_MODEL?.trim() || DEFAULT_TTS_MODEL,
    ttsVoice: env.DEEPINFRA_TTS_VOICE?.trim() || DEFAULT_TTS_VOICE,
    apiKey: env.DEEPINFRA_API_KEY?.trim() || "",
    elevenLabsApiKey: env.ELEVENLABS_API_KEY?.trim() || "",
    elevenLabsAgentId: env.ELEVENLABS_AGENT_ID?.trim() || "",
    elevenLabsVoiceId: env.ELEVENLABS_TTS_VOICE_ID?.trim() || "21m00Tcm4TlvDq8ikWAM",
    accountFile: env.AUTH_FILE?.trim() || ACCOUNT_FILE
  };
}

function createServer({ config = configFromEnv(), fetchImpl = fetch, authStore = createAuthStore(config.accountFile) } = {}) {
  return http.createServer(async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; }
    catch (_) { error(res, 400, "bad_path", "Invalid request path."); return; }

    if (pathname === "/api/health") {
      if (req.method !== "GET") { error(res, 405, "method_not_allowed", "Method not allowed."); return; }
      sendJson(res, 200, { ok: true, aiConfigured: Boolean(config.apiKey) });
      return;
    }

    if (pathname === "/api/voice/signed-url") {
      if (req.method !== "GET") { error(res, 405, "method_not_allowed", "Method not allowed."); return; }
      if (!validLocalOrigin(req)) { error(res, 403, "origin_not_allowed", "Request origin is not allowed."); return; }
      if (!config.elevenLabsAgentId) { error(res, 503, "voice_not_configured", "Voice chat is not configured yet."); return; }
      if (!config.elevenLabsApiKey) { sendJson(res, 200, { agentId: config.elevenLabsAgentId, mode: "public" }); return; }
      try {
        const response = await fetchImpl("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=" + encodeURIComponent(config.elevenLabsAgentId), { headers: { "xi-api-key": config.elevenLabsApiKey, Accept: "application/json" } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.signed_url) {
          const message = response.status === 401
            ? "ElevenLabs rejected the API key. Check that it is active and belongs to this workspace."
            : response.status === 403
              ? "ElevenLabs denied access. Enable ElevenAgents access for this API key."
              : response.status === 404
                ? "The configured Budd agent ID was not found in this ElevenLabs workspace."
                : "Could not start voice chat right now.";
          error(res, 503, "voice_provider_error", message);
          return;
        }
        sendJson(res, 200, { signedUrl: data.signed_url });
      } catch (_) { error(res, 503, "voice_provider_unavailable", "Could not reach the voice service right now."); }
      return;
    }

    if (pathname === "/api/voice/transcribe") {
      if (req.method !== "POST") { error(res, 405, "method_not_allowed", "Method not allowed."); return; }
      if (!validLocalOrigin(req)) { error(res, 403, "origin_not_allowed", "Request origin is not allowed."); return; }
      if (!config.apiKey) { error(res, 503, "voice_not_configured", "Voice transcription is not configured yet."); return; }
      const contentType = req.headers["content-type"] || "";
      if (!/^multipart\/form-data/i.test(contentType)) { error(res, 415, "invalid_content_type", "Send an audio recording."); return; }
      try {
        const recording = parseAudioMultipart(await readRawBody(req, MAX_AUDIO_BYTES), contentType);
        if (!recording || !recording.data.length) { error(res, 400, "invalid_audio", "The audio recording was empty or invalid."); return; }
        const form = new FormData();
        form.append("file", new Blob([recording.data], { type: recording.type }), recording.filename);
        form.append("model", config.sttModel);
        const response = await fetchImpl(STT_ENDPOINT, { method: "POST", headers: { "Authorization": `Bearer ${config.apiKey}` }, body: form });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || typeof data.text !== "string") {
          const message = response.status === 401 || response.status === 403 ? "DeepInfra rejected the API key for Speech-to-Text." : "Could not transcribe the recording.";
          error(res, 503, "voice_transcription_error", message); return;
        }
        sendJson(res, 200, { text: data.text.trim() });
      } catch (cause) { error(res, cause?.status || 503, cause?.code || "voice_transcription_unavailable", cause?.message || "Could not transcribe the recording."); }
      return;
    }

    if (pathname === "/api/voice/speak") {
      if (req.method !== "POST") { error(res, 405, "method_not_allowed", "Method not allowed."); return; }
      if (!validLocalOrigin(req)) { error(res, 403, "origin_not_allowed", "Request origin is not allowed."); return; }
      if (!config.apiKey) { error(res, 503, "voice_not_configured", "Voice playback is not configured yet."); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) { error(res, 415, "invalid_content_type", "Use application/json."); return; }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (cause) { error(res, cause?.status || 400, cause?.code || "invalid_json", cause?.message || "Invalid JSON body."); return; }
      const text = typeof body?.text === "string" ? body.text.trim().slice(0, MAX_MESSAGE_CHARS) : "";
      if (!text) { error(res, 400, "invalid_text", "Provide text to speak."); return; }
      try {
        const response = await fetchImpl(TTS_ENDPOINT, {
          method: "POST",
          headers: { "Authorization": `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ model: config.ttsModel, input: text, voice: config.ttsVoice, response_format: "mp3" })
        });
        if (!response.ok) { error(res, 503, "voice_synthesis_error", response.status === 401 || response.status === 403 ? "DeepInfra rejected the API key for Text-to-Speech." : "Could not create voice playback."); return; }
        const audio = Buffer.from(await response.arrayBuffer());
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store" });
        res.end(audio);
      } catch (_) { error(res, 503, "voice_synthesis_unavailable", "Could not reach the voice service right now."); }
      return;
    }

    if (pathname.startsWith("/api/auth")) {
      if (!validLocalOrigin(req)) { error(res, 403, "origin_not_allowed", "Request origin is not allowed."); return; }
      const token = cookies(req).declutter_session;
      const currentUser = authStore.userFromToken(token);
      if (pathname === "/api/auth/me" && req.method === "GET") {
        sendJson(res, 200, { authenticated: Boolean(currentUser), user: currentUser ? authStore.publicUser(currentUser) : null });
        return;
      }
      if (pathname === "/api/auth/logout" && req.method === "POST") {
        authStore.removeSession(token);
        sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
        return;
      }
      if ((pathname === "/api/auth/signup" || pathname === "/api/auth/login") && req.method === "POST") {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) { error(res, 415, "invalid_content_type", "Use application/json."); return; }
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (cause) { error(res, cause?.status || 400, cause?.code || "invalid_json", cause?.message || "Invalid JSON body."); return; }
        const issue = validateAccountInput(body, pathname.endsWith("signup"));
        if (issue) { error(res, 400, issue, issue === "password_mismatch" ? "Passwords do not match." : "Check your username and password."); return; }
        const user = pathname.endsWith("signup") ? authStore.createUser(body.username, body.password) : { user: authStore.authenticate(body.username, body.password) };
        if (user.error) { error(res, user.error === "username_taken" ? 409 : 400, user.error, user.error === "username_taken" ? "That username is already taken." : "Check your username and password."); return; }
        if (!user.user) { error(res, 401, "invalid_login", "Username or password is incorrect."); return; }
        const session = authStore.session(user.user);
        sendJson(res, 200, { authenticated: true, user: authStore.publicUser(user.user) }, { "Set-Cookie": sessionCookie(session) });
        return;
      }
      error(res, 405, "method_not_allowed", "Method not allowed.");
      return;
    }

    if (pathname === "/api/account/chats" || pathname.startsWith("/api/account/chats/")) {
      if (!validLocalOrigin(req)) { error(res, 403, "origin_not_allowed", "Request origin is not allowed."); return; }
      const currentUser = authStore.userFromToken(cookies(req).declutter_session);
      if (!currentUser) { error(res, 401, "authentication_required", "Log in to use account chats."); return; }
      if (pathname === "/api/account/chats" && req.method === "GET") {
        sendJson(res, 200, { chats: currentUser.chats || [] });
        return;
      }
      if (pathname === "/api/account/chats" && req.method === "POST") {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) { error(res, 415, "invalid_content_type", "Use application/json."); return; }
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (cause) { error(res, cause?.status || 400, cause?.code || "invalid_json", cause?.message || "Invalid JSON body."); return; }
        const chat = validateSavedConversation(body?.conversation);
        if (!chat) { error(res, 400, "invalid_conversation", "Provide a valid conversation to save."); return; }
        currentUser.chats = (currentUser.chats || []).filter((item) => item.id !== chat.id);
        currentUser.chats.unshift(chat);
        currentUser.chats = currentUser.chats.slice(0, 100);
        authStore.persist();
        sendJson(res, 200, { saved: true, chat });
        return;
      }
      if (pathname.startsWith("/api/account/chats/") && req.method === "DELETE") {
        const id = decodeURIComponent(pathname.slice("/api/account/chats/".length));
        currentUser.chats = (currentUser.chats || []).filter((item) => item.id !== id);
        authStore.persist();
        sendJson(res, 200, { deleted: true });
        return;
      }
      error(res, 405, "method_not_allowed", "Method not allowed.");
      return;
    }

    if (pathname === "/api/chat") {
      if (req.method !== "POST") { error(res, 405, "method_not_allowed", "Method not allowed."); return; }
      if (!validLocalOrigin(req)) { error(res, 403, "origin_not_allowed", "Request origin is not allowed."); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
        error(res, 415, "invalid_content_type", "Use application/json."); return;
      }
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (cause) {
        error(res, cause?.status || 400, cause?.code || "invalid_json", cause?.message || "Invalid JSON body."); return;
      }
      const messages = validateMessages(body?.messages);
      if (!messages) { error(res, 400, "invalid_messages", "Provide 1–24 user and assistant messages with text under 4,000 characters each, ending in a user message."); return; }

      const safety = safetyReply(messages);
      if (safety) { sendJson(res, 200, { text: safety, source: "safety" }); return; }

      // Respect clear self-reports and corrections before asking a model to
      // interpret a conversation. Earlier assistant messages must not overrule
      // what the user just said about their own state.
      const guardrail = conversationGuard(messages.at(-1).content);
      if (guardrail) {
        sendJson(res, 200, { text: guardrail.text, source: "guardrail", reason: guardrail.kind, questionKey: guardrail.questionKey || null });
        return;
      }

      if (!config.apiKey) {
        const reply = fallback(messages, "unconfigured");
        if (reply) sendJson(res, 200, reply);
        else error(res, 503, "reply_unavailable", "A reply is unavailable right now. Please retry.");
        return;
      }
      const result = await callDeepInfra(messages, config, fetchImpl);
      if (result.text) {
        // Defense in depth for future routing changes or detector misses: a
        // provider reply cannot contradict a clear positive self-report.
        if (guardrail && contradictsGuardrail(result.text, guardrail)) {
          sendJson(res, 200, { text: guardrail.text, source: "guardrail", reason: "provider_contradiction", questionKey: guardrail.questionKey || null });
        } else sendJson(res, 200, result);
        return;
      }
      const reply = fallback(messages, result.reason);
      if (reply) sendJson(res, 200, reply);
      else error(res, 503, "reply_unavailable", "A reply is unavailable right now. Please retry.");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      error(res, 405, "method_not_allowed", "Method not allowed."); return;
    }
    if (pathname === "/") pathname = "/index.html";
    const mime = PUBLIC_FILES.get(pathname);
    if (!mime) { error(res, 404, "not_found", "Not found."); return; }
    const file = path.join(ROOT, pathname.slice(1));
    try {
      const stat = await fs.promises.stat(file);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": mime,
        "Content-Length": stat.size,
        "Cache-Control": "no-cache"
      });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file).pipe(res);
    } catch (_) { error(res, 404, "not_found", "Not found."); }
  });
}

if (require.main === module) {
  const config = configFromEnv();
  createServer({ config }).listen(config.port, "127.0.0.1", () => {
    console.log(`Back to Center running at http://localhost:${config.port}`);
    console.log(`DeepInfra ${config.apiKey ? "configured" : "not configured; automatic local fallback active"}.`);
  });
}

module.exports = { createServer, createAuthStore, configFromEnv, validateMessages, validateSavedConversation, boundedContext, SYSTEM_PROMPT };
