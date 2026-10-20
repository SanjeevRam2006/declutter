/* Optional real-browser smoke test. Requires local Chrome; makes no paid calls. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createServer } = require("./server.js");

const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath}. Set CHROME_PATH to its executable.`);
  const server = createServer({ config: { port: 0, timeoutMs: 1000, apiKey: "", model: "unused" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "btc-browser-"));
  const chrome = spawn(chromePath, [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"
  ], { stdio: "ignore", windowsHide: true });
  let socket;
  try {
    const activePort = path.join(profile, "DevToolsActivePort");
    await waitFor(() => fs.existsSync(activePort), "Chrome debugging port");
    const port = Number(fs.readFileSync(activePort, "utf8").split(/\r?\n/)[0]);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find((item) => item.type === "page");
    if (!page) throw new Error("Chrome did not open a page.");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const handlers = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) handlers.reject(new Error(message.error.message));
      else handlers.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const commandId = ++id;
      pending.set(commandId, { resolve, reject });
      socket.send(JSON.stringify({ id: commandId, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    await command("Page.enable");
    await command("Runtime.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 320, height: 900, deviceScaleFactor: 1, mobile: true });
    await command("Page.navigate", { url: base });
    await waitFor(() => evaluate("document.readyState === 'complete' && !!document.querySelector('#thread .thread-empty')"), "app load");

    await evaluate("document.querySelector('#signupBtn').click()");
    const authLayout = await evaluate("(() => { const backdrop = document.querySelector('#authModal'); const card = document.querySelector('.auth-modal').getBoundingClientRect(); return { hidden: backdrop.hidden, top: card.top, bottom: card.bottom, viewport: innerHeight, position: getComputedStyle(backdrop).position }; })()");
    assert.equal(authLayout.hidden, false);
    assert.equal(authLayout.position, "fixed");
    assert.ok(authLayout.top > 0 && authLayout.bottom < authLayout.viewport, "Auth dialog should be centered in the viewport");
    await evaluate("document.querySelector('#authCloseBtn').click()");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#authModal')).display"), "none", "Closed auth dialog should be visually hidden");
    await evaluate("document.querySelector('#privacyBtn').click()");
    assert.equal(await evaluate("document.querySelector('#privacyModal').hidden"), false, "Privacy dialog should open from the compact link");
    await evaluate("document.querySelector('#privacyCloseBtn').click()");
    assert.equal(await evaluate("document.querySelector('#privacyModal').hidden"), true, "Privacy dialog should close cleanly");

    for (const width of [320, 500, 768, 1024, 1440]) {
      await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width <= 500 });
      const size = await evaluate("({ viewport: innerWidth, page: document.documentElement.scrollWidth })");
      assert.equal(size.viewport, width);
      assert.ok(size.page <= width, `Horizontal overflow at ${width}px: ${size.page}px`);
    }

    await evaluate("document.querySelector('#composerInput').value = 'I have a report due tomorrow and keep avoiding it.'; document.querySelector('#composer').requestSubmit();");
    await waitFor(() => evaluate("document.querySelectorAll('#thread .msg-assistant:not(.typing)').length === 1"), "fallback reply");
    assert.doesNotMatch(await evaluate("document.querySelector('#thread').innerText"), /Basic offline reply|AI reply|Local response/);
    assert.equal(await evaluate("document.querySelector('#historyCount').innerText"), "1");

    await command("Page.reload", { ignoreCache: true });
    await waitFor(() => evaluate("document.readyState === 'complete' && document.querySelectorAll('#thread .msg').length === 2"), "saved chat reload");
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true }))");
    assert.match(await evaluate("document.querySelector('#thread').innerText"), /Start anywhere/);
    await evaluate("document.querySelector('[data-act=open]').click()");
    assert.match(await evaluate("document.querySelector('#thread').innerText"), /report due tomorrow/);
    await evaluate("document.querySelector('[data-act=delete]').click()");
    assert.equal(await evaluate("document.querySelector('#historyCount').innerText"), "0");
    assert.equal(await evaluate("document.activeElement.id"), "composerInput");

    await evaluate("document.querySelector('#focusBtn').click()");
    assert.equal(await evaluate("document.body.classList.contains('focus-mode')"), true);
    await evaluate("document.querySelector('#stopwatchModeBtn').click(); document.querySelector('#focusStartBtn').click()");
    await pause(1100);
    await evaluate("document.querySelector('#focusBackBtn').click()");
    const focusState = await evaluate("JSON.parse(localStorage.getItem('back_to_center_focus_timer_v1'))");
    assert.equal(focusState.running, true);
    assert.ok(focusState.elapsedMs >= 0);
    await evaluate("document.querySelector('#focusBtn').click(); document.querySelector('#focusStartBtn').click(); document.querySelector('#focusResetBtn').click()");
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('back_to_center_focus_timer_v1')).elapsedMs"), 0);

    await evaluate("document.querySelector('#voiceBtn').click()");
    assert.equal(await evaluate("document.body.classList.contains('voice-view') && !document.querySelector('#voiceView').hidden"), true, "Voice view should open by itself");
    await evaluate("document.querySelector('#focusBtn').click()");
    assert.equal(await evaluate("document.body.classList.contains('focus-mode') && !document.querySelector('#focusScreen').hidden && !document.body.classList.contains('voice-view')"), true, "Focus should replace Voice view");
    await evaluate("document.querySelector('#focusBtn').click(); document.querySelector('#voiceBtn').click()");
    assert.equal(await evaluate("document.body.classList.contains('voice-view') && !document.body.classList.contains('focus-mode')"), true, "Voice should replace Focus view");
    await evaluate("document.querySelector('#voiceBackBtn').click()");
    assert.equal(await evaluate("!document.body.classList.contains('voice-view') && !document.body.classList.contains('focus-mode')"), true, "Returning from Voice should restore the normal view");

    await evaluate("document.querySelector('#composerInput').value = 'A new thought'; document.querySelector('#composerInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));");
    assert.equal(await evaluate("document.querySelector('#historyCount').innerText"), "0");
    await evaluate("document.querySelector('#composerInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));");
    await waitFor(() => evaluate("document.querySelectorAll('#thread .msg-assistant:not(.typing)').length === 1"), "keyboard send");
    console.log("Browser smoke passed: responsive widths, fallback chat, refresh, reopen, delete, keyboard send.");
  } finally {
    if (socket) socket.close();
    chrome.kill();
    await new Promise((resolve) => server.close(resolve));
    await Promise.race([
      new Promise((resolve) => chrome.exitCode !== null ? resolve() : chrome.once("exit", resolve)),
      pause(2000)
    ]);
    const tempRoot = path.resolve(os.tmpdir());
    const target = path.resolve(profile);
    if (path.dirname(target) === tempRoot && path.basename(target).startsWith("btc-browser-")) {
      try { fs.rmSync(target, { recursive: true, force: true }); }
      catch (_) { /* Chrome may still hold a profile file on Windows. */ }
    }
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
