"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const responder = require("./responder.js");
const safety = require("./safety.js");

class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.handlers = {};
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.value = "";
    this.offsetWidth = 1;
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.selectors = {};
    this.content = "";
  }
  set textContent(value) { this.content = String(value); this.children = []; }
  get textContent() { return this.content + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(value) { this.html = String(value); this.children = []; this.selectors = {}; }
  get innerHTML() { return this.html || ""; }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  dispatch(type, event = {}) { return this.handlers[type]?.({ preventDefault() {}, target: this, ...event }); }
  querySelector(selector) { return this.selectors[selector] ||= new Element("button"); }
  setAttribute() {}
  getAttribute(name) { return this.attributes?.[name] || null; }
  focus() { this.focused = true; }
  setSelectionRange() {}
  scrollIntoView() {}
}

const ids = ["thread", "promptChips", "composer", "composerInput", "sendBtn", "emptyError",
  "storageWarning", "responseStatus", "retryBtn", "historyList", "historyCount", "emptyHistory",
  "deleteAllBtn", "newChatBtn", "brandHome", "accountNudge", "nudgeSignup", "nudgeDismiss",
  "authModal", "authModeLabel", "authTitle", "authCloseBtn", "authForm", "authUsername",
  "authPassword", "confirmPasswordRow", "authConfirmPassword", "authError", "authSubmitBtn", "authSwitchBtn"];

function makeApp(storage, fetchImpl) {
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  for (const id of ["emptyError", "storageWarning", "responseStatus", "retryBtn", "accountNudge", "authModal", "authError"]) elements[id].hidden = true;
  elements.composerInput.value = "";
  const find = (root, id) => root.id === id ? root : (root.children || []).map((child) => find(child, id)).find(Boolean);
  const document = {
    getElementById: (id) => elements[id] || find(elements.thread, id) || null,
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => ({ textContent: String(text) })
  };
  const context = { document, localStorage: storage, fetch: fetchImpl, confirm: () => true, setTimeout, clearTimeout,
    window: { generateReply: responder.generateReply, BackToCenterSafety: safety, scrollTo() {} } };
  vm.runInNewContext(fs.readFileSync("app.js", "utf8"), context, { filename: "app.js" });
  return elements;
}

function makeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key)
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const key = "back_to_center_conversations_v1";

test("chat creates, persists, reopens and deletes without rendering raw HTML", async () => {
  const storage = makeStorage();
  const calls = [];
  const provider = async (_, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ text: "One small next step is enough.", source: "deepinfra" }) };
  };
  let ui = makeApp(storage, provider);
  ui.composerInput.value = "<script>alert(1)</script> I am stuck.";
  ui.composer.dispatch("submit");
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(ui.historyCount.textContent, "1");
  assert.match(ui.thread.textContent, /One small next step/);
  assert.match(fs.readFileSync("styles.css", "utf8"), /\.msg-assistant \.message-actions\s*\{\s*display:\s*none/);
  assert.ok(!ui.thread.innerHTML.includes("<script>"));
  assert.match(ui.historyList.children[0].innerHTML, /&lt;script&gt;/);
  assert.equal(JSON.parse(storage.getItem(key))[0].messages.length, 2);

  ui.newChatBtn.dispatch("click");
  assert.match(ui.thread.textContent, /Start anywhere/);
  ui.historyList.children[0].querySelector('[data-act="open"]').dispatch("click");
  assert.match(ui.thread.textContent, /One small next step/);

  ui = makeApp(storage, provider);
  assert.match(ui.thread.textContent, /One small next step/);
  ui.historyList.children[0].querySelector('[data-act="delete"]').dispatch("click");
  assert.equal(ui.historyCount.textContent, "0");
  assert.equal(JSON.parse(storage.getItem(key)).length, 0);
});

test("fallback remains retryable without exposing provider labels, and duplicate sends are blocked", async () => {
  const storage = makeStorage();
  let answer;
  let calls = 0;
  const provider = async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { answer = resolve; });
    return { ok: true, json: async () => ({ text: "Here is the fuller response.", source: "deepinfra" }) };
  };
  const ui = makeApp(storage, provider);
  ui.composerInput.value = "I have a report due tomorrow.";
  ui.composer.dispatch("submit");
  ui.composer.dispatch("submit");
  assert.equal(calls, 1);
  assert.equal(ui.sendBtn.disabled, true);
  answer({ ok: true, json: async () => ({ text: "Start with the first paragraph.", source: "fallback", reason: "rate_limited" }) });
  await settle();
  assert.equal(ui.sendBtn.disabled, false);
  assert.doesNotMatch(ui.thread.textContent, /Basic offline reply|AI reply|Local response/);
  assert.equal(ui.retryBtn.hidden, false);
  ui.retryBtn.dispatch("click");
  await settle();
  const messages = JSON.parse(storage.getItem(key))[0].messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[1].source, "deepinfra");
  assert.equal(ui.retryBtn.hidden, true);
});

test("browser fallback handles server loss and safety takes precedence", async () => {
  const storage = makeStorage();
  const ui = makeApp(storage, async () => { throw Error("offline"); });
  ui.composerInput.value = "I am in India. I have a plan to end my life tonight.";
  ui.composer.dispatch("submit");
  await settle();
  assert.doesNotMatch(ui.thread.textContent, /Safety guidance|Local response/);
  assert.match(ui.thread.textContent, /112/);
  assert.equal(JSON.parse(storage.getItem(key))[0].messages[1].source, "safety");
});

test("account prompt waits for ten user turns and resets for a new chat", async () => {
  const storage = makeStorage();
  const provider = async () => ({ ok: true, json: async () => ({ text: "A concise reply.", source: "deepinfra" }) });
  const ui = makeApp(storage, provider);

  assert.equal(ui.authModal.hidden, true);
  assert.equal(ui.accountNudge.hidden, true);

  for (let turn = 1; turn <= 9; turn++) {
    ui.composerInput.value = `Message ${turn}`;
    ui.composer.dispatch("submit");
    await settle();
    assert.equal(ui.authModal.hidden, true);
  }

  ui.composerInput.value = "Message 10";
  ui.composer.dispatch("submit");
  await settle();
  assert.equal(ui.authModal.hidden, false);

  ui.authCloseBtn.dispatch("click");
  assert.equal(ui.authModal.hidden, true);
  ui.newChatBtn.dispatch("click");
  assert.equal(ui.authModal.hidden, true);
  assert.equal(ui.accountNudge.hidden, true);
});

test("opening an existing ten-turn chat does not auto-open the account prompt", () => {
  const storage = makeStorage();
  storage.setItem(key, JSON.stringify([{
    id: "existing",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      { role: "user", text: "One", at: Date.now() }, { role: "assistant", text: "Reply", at: Date.now() },
      { role: "user", text: "Two", at: Date.now() }, { role: "assistant", text: "Reply", at: Date.now() },
      { role: "user", text: "Three", at: Date.now() }, { role: "assistant", text: "Reply", at: Date.now() },
      { role: "user", text: "Four", at: Date.now() }, { role: "assistant", text: "Reply", at: Date.now() },
      { role: "user", text: "Five", at: Date.now() }, { role: "assistant", text: "Reply", at: Date.now() },
      { role: "user", text: "Six", at: Date.now() }, { role: "assistant", text: "Reply", at: Date.now() },
      { role: "user", text: "Seven", at: Date.now() }, { role: "assistant", text: "Reply", at: Date.now() },
      { role: "user", text: "Eight", at: Date.now() }, { role: "assistant", text: "Reply", at: Date.now() },
      { role: "user", text: "Nine", at: Date.now() }, { role: "assistant", text: "Reply", at: Date.now() },
      { role: "user", text: "Ten", at: Date.now() }, { role: "assistant", text: "Reply", at: Date.now() }
    ]
  }]));
  const ui = makeApp(storage, async () => ({ ok: true, json: async () => ({ text: "Reply", source: "deepinfra" }) }));
  assert.equal(ui.authModal.hidden, true);
});
