"use strict";

const COOKIE = "declutter_supabase_access";
const MAX_BODY = 256 * 1024;

function configFromEnv(env = process.env) {
  const rawUrl = String(env.SUPABASE_URL || "https://uvlabtixfujklzklfeaw.supabase.co").trim().replace(/^['"]|['"]$/g, "");
  const dashboardMatch = rawUrl.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)(?:[/?#].*)?$/i);
  const projectUrl = dashboardMatch ? `https://${dashboardMatch[1]}.supabase.co` : rawUrl;
  return {
    url: projectUrl.replace(/\/$/, ""),
    anon: String(env.SUPABASE_ANON_KEY || "").trim(),
    service: String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
  };
}

function json(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function cookieValue(req, name) {
  const raw = String(req.headers.cookie || "");
  const part = raw.split(";").map((item) => item.trim()).find((item) => item.startsWith(name + "="));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

function setCookie(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > MAX_BODY) {
        const error = new Error("Request too large.");
        error.status = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });
}

async function supabaseRequest(config, path, options = {}, key = config.anon) {
  if (!key) {
    const error = new Error("Supabase is not configured yet.");
    error.status = 503;
    error.code = "supabase_not_configured";
    throw error;
  }
  const response = await fetch(config.url + path, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${options.accessToken || key}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.msg || data.message || data.error_description || data.error || "Supabase request failed.");
    error.status = response.status;
    error.code = data.error_code || data.code || "supabase_error";
    throw error;
  }
  return data;
}

function normalizeRoute(req, prefix) {
  const url = new URL(req.url || "/", "http://localhost");
  const route = url.searchParams.get("route");
  return route ? `${prefix}/${route.replace(/^\/+/, "")}` : url.pathname;
}

function validateSignup(body) {
  if (!body || typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) return "Enter a valid email address.";
  if (typeof body.username !== "string" || !/^[a-zA-Z0-9_-]{3,32}$/.test(body.username.trim())) return "Username must be 3–32 letters, numbers, underscores, or hyphens.";
  if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 200) return "Password must be at least 8 characters.";
  if (body.password !== body.confirmPassword) return "Passwords do not match.";
  return "";
}

function validateLogin(body) {
  if (!body || typeof body.email !== "string" || !body.email.trim() || typeof body.password !== "string" || !body.password) return "Enter your email and password.";
  return "";
}

function validateResetRequest(body) {
  if (!body || typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) return "Enter a valid email address.";
  return "";
}

async function currentUser(config, token) {
  if (!token) return null;
  try { return await supabaseRequest(config, "/auth/v1/user", { method: "GET", accessToken: token }); }
  catch (_) { return null; }
}

async function handleAuth(req, res, route, config) {
  if (route === "/api/auth/me" && req.method === "GET") {
    const user = await currentUser(config, cookieValue(req, COOKIE));
    json(res, 200, { authenticated: Boolean(user), user: user ? { id: user.id, email: user.email, username: user.user_metadata?.username || "" } : null });
    return true;
  }
  if (route === "/api/auth/logout" && req.method === "POST") {
    json(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
    return true;
  }
  if ((route === "/api/auth/signup" || route === "/api/auth/login") && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (_) { json(res, 400, { error: "Invalid request." }); return true; }
    const issue = route.endsWith("signup") ? validateSignup(body) : validateLogin(body);
    if (issue) { json(res, 400, { error: issue }); return true; }
    try {
      const data = route.endsWith("signup")
        ? await supabaseRequest(config, "/auth/v1/signup", { method: "POST", body: JSON.stringify({ email: body.email.trim().toLowerCase(), password: body.password, data: { username: body.username.trim() } }) })
        : await supabaseRequest(config, "/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email: body.email.trim().toLowerCase(), password: body.password }) });
      if (!data.access_token) {
        json(res, 200, { authenticated: false, requiresEmailConfirmation: true, message: "Check your email to confirm your account." });
        return true;
      }
      const user = data.user || await currentUser(config, data.access_token);
      json(res, 200, { authenticated: true, user: { id: user.id, email: user.email, username: user.user_metadata?.username || body.username || "" } }, { "Set-Cookie": setCookie(data.access_token) });
    } catch (error) {
      const status = error.status === 400 || error.status === 401 ? 401 : error.status === 409 ? 409 : 502;
      const message = status === 401 ? "Email or password is incorrect." : error.code === "supabase_error" ? error.message : "Supabase is unavailable. Check the Supabase project URL and Vercel environment variables.";
      json(res, status, { error: message, code: error.code });
    }
    return true;
  }
  if (route === "/api/auth/reset-request" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (_) { json(res, 400, { error: "Invalid request." }); return true; }
    const issue = validateResetRequest(body);
    if (issue) { json(res, 400, { error: issue }); return true; }
    try {
      const redirectTo = String(process.env.PUBLIC_APP_URL || "https://declutter-fawn.vercel.app").replace(/\/$/, "");
      await supabaseRequest(config, "/auth/v1/recover", { method: "POST", body: JSON.stringify({ email: body.email.trim().toLowerCase(), redirect_to: redirectTo }) });
      json(res, 200, { ok: true, message: "If that email has an account, a reset link is on its way." });
    } catch (error) {
      // Do not reveal whether an email exists. Log-in configuration errors are
      // still actionable, while provider responses remain intentionally vague.
      const status = error.code === "supabase_not_configured" ? 503 : 502;
      json(res, status, { error: status === 503 ? "Supabase is unavailable. Check the project configuration." : "Could not send a reset link right now.", code: error.code });
    }
    return true;
  }
  if (route === "/api/auth/update-password" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (_) { json(res, 400, { error: "Invalid request." }); return true; }
    if (!body || typeof body.token !== "string" || !body.token || typeof body.password !== "string" || body.password.length < 8 || body.password.length > 200 || body.password !== body.confirmPassword) {
      json(res, 400, { error: body && body.password !== body.confirmPassword ? "Passwords do not match." : "Choose a password of at least 8 characters." });
      return true;
    }
    try {
      await supabaseRequest(config, "/auth/v1/user", { method: "PUT", accessToken: body.token, body: JSON.stringify({ password: body.password }) });
      json(res, 200, { ok: true, message: "Password updated. You can now log in." });
    } catch (error) {
      json(res, error.status === 401 ? 401 : 502, { error: error.status === 401 ? "That reset link is invalid or expired. Request a new one." : "Could not update the password right now.", code: error.code });
    }
    return true;
  }
  return false;
}

async function handleChats(req, res, route, config) {
  if (!(route === "/api/account/chats" || route.startsWith("/api/account/chats/"))) return false;
  const token = cookieValue(req, COOKIE);
  const user = await currentUser(config, token);
  if (!user) { json(res, 401, { error: "Log in to use account chats.", code: "authentication_required" }); return true; }
  const headers = { Prefer: "return=representation" };
  try {
    if (route === "/api/account/chats" && req.method === "GET") {
      const chats = await supabaseRequest(config, "/rest/v1/declutter_chats?user_id=eq." + encodeURIComponent(user.id) + "&select=chat_id,title,messages,saved_at&order=saved_at.desc", { method: "GET", headers }, config.service);
      json(res, 200, { chats: chats.map((chat) => ({ id: chat.chat_id, title: chat.title, messages: chat.messages, savedAt: chat.saved_at })) });
      return true;
    }
    if (route === "/api/account/chats" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const conversation = body && body.conversation;
      if (!conversation || typeof conversation.id !== "string" || !Array.isArray(conversation.messages)) { json(res, 400, { error: "Provide a valid conversation to save." }); return true; }
      const row = { user_id: user.id, chat_id: conversation.id, title: String(conversation.title || "Saved chat").slice(0, 120), messages: conversation.messages.slice(-24), saved_at: new Date().toISOString() };
      const saved = await supabaseRequest(config, "/rest/v1/declutter_chats?on_conflict=user_id,chat_id", { method: "POST", headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(row) }, config.service);
      json(res, 200, { saved: true, chat: saved[0] || row });
      return true;
    }
    if (route.startsWith("/api/account/chats/") && req.method === "DELETE") {
      const chatId = decodeURIComponent(route.slice("/api/account/chats/".length));
      if (!chatId || chatId.length > 200) { json(res, 400, { error: "Provide a valid chat id." }); return true; }
      await supabaseRequest(config, "/rest/v1/declutter_chats?user_id=eq." + encodeURIComponent(user.id) + "&chat_id=eq." + encodeURIComponent(chatId), { method: "DELETE", headers }, config.service);
      json(res, 200, { deleted: true });
      return true;
    }
    json(res, 405, { error: "Method not allowed." });
  } catch (error) {
    json(res, error.status === 401 ? 401 : 502, { error: error.message, code: error.code });
  }
  return true;
}

async function handleSupabase(req, res) {
  const config = configFromEnv();
  if (!config.anon) return false;
  const requestPath = new URL(req.url || "/", "http://localhost").pathname;
  if (requestPath === "/api/health" && req.method === "GET") {
    let host = "invalid";
    try { host = new URL(config.url).host; } catch (_) {}
    json(res, 200, { ok: true, aiConfigured: Boolean(process.env.DEEPINFRA_API_KEY), supabaseConfigured: true, supabaseHost: host, supabaseServiceConfigured: Boolean(config.service) });
    return true;
  }
  const authRoute = normalizeRoute(req, "/api/auth");
  const accountRoute = normalizeRoute(req, "/api/account");
  if (authRoute === "/api/auth/me" || authRoute === "/api/auth/logout" || authRoute.includes("/api/auth/")) return handleAuth(req, res, authRoute, config);
  return handleChats(req, res, accountRoute, config);
}

module.exports = { handleSupabase, configFromEnv };
