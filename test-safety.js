"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { explicitRisk, safetyReply } = require("./safety.js");

test("clear current self-harm and imminent danger bypass normal replies", () => {
  for (const text of [
    "I am going to kill myself tonight.",
    "I have a plan to end my life.",
    "I want to hurt myself.",
    "I can't keep myself safe.",
    "I took pills to die.",
    "I'm being attacked right now.",
    "I am going to kill someone."
  ]) assert.equal(explicitRisk(text), true, text);
});

test("stress, figurative speech, negation, history and quotations do not trigger", () => {
  for (const text of [
    "I am stressed and exhausted.",
    "This report is killing me.",
    "I don't want to kill myself.",
    "I used to want to die years ago.",
    "My friend said 'I want to kill myself' in a story."
  ]) assert.equal(explicitRisk(text), false, text);
});

test("location-specific contacts require an explicit location statement", () => {
  const india = safetyReply([{ role: "user", content: "I live in India." }, { role: "user", content: "I have a plan to end my life." }]);
  assert.match(india, /112/);
  assert.match(india, /14416/);
  const us = safetyReply([{ role: "user", content: "I'm in the United States. I might kill myself tonight." }]);
  assert.match(us, /911/);
  assert.match(us, /988/);
  const unknown = safetyReply([{ role: "user", content: "I might kill myself tonight." }]);
  assert.match(unknown, /local emergency number/);
  assert.doesNotMatch(unknown, /\b(?:112|911|988)\b/);
  const attacked = safetyReply([{ role: "user", content: "I am in India. I'm being attacked right now." }]);
  assert.match(attacked, /112/);
  assert.doesNotMatch(attacked, /14416/);
});
