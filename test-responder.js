/* Back to Center — responder behaviour tests (Node, no dependencies).
 * Run: node test-responder.js
 * Asserts interaction QUALITY per the product vision, not exact wording. */
"use strict";

var mod = require("./responder.js");
var generateReply = mod.generateReply || globalThis.generateReply;

function countWords(s) {
  var m = String(s).trim().match(/\S+/g);
  return m ? m.length : 0;
}

var BANNED = [
  // rigid template / dashboard language
  "what's going on", "what matters right now", "known from your words",
  "uncertain / missing", "your next step",
  // productivity-tool defaults
  "10-minute focus", "set a timer", "make a list", "write every open loop",
  "start a timer",
  // therapy-speak / corporate / motivational clichés
  "hold space", "inner child", "reframe your mindset", "lean into",
  "leverage", "action items", "unlock your", "you've got this",
  "everything happens for a reason", "just believe in yourself",
  "good vibes", "journey of self-discovery",
  // diagnoses / invented facts
  "you have anxiety", "you have depression", "you have adhd", "diagnos"
];

var CASES = [
  {
    name: "practical problem gets a concrete move, no timer, no question",
    run: function (t) {
      var r = generateReply("The electricity bill is due tomorrow. I need to pay it online tonight.", {});
      t.ok(/pay|bill|tonight|tomorrow/i.test(r.text), "names the concrete move with its timing");
      t.ok(!/\?/.test(r.text), "no question when nothing decision-critical is missing");
    }
  },
  {
    name: "self-criticism is challenged, kindly and directly",
    run: function (t) {
      var r = generateReply("I messed up the presentation. I am such a failure, everyone else can handle this.", {});
      t.ok(/isn't a fact|not a fact/i.test(r.text), "pushes back on the label as fact");
      t.ok(!/you are a failure|you are lazy/i.test(r.text), "never agrees with the harsh label");
      t.ok(/two minutes|first line/i.test(r.text), "offers one tiny concrete move");
    }
  },
  {
    name: "relationship worry is not turned into a productivity task",
    run: function (t) {
      var r = generateReply("My friend left me on read after a long message. She is probably mad at me and thinks I am too much.", {});
      t.ok(/don't actually know|don't know yet/i.test(r.text), "challenges the mind-reading honestly");
      t.ok(!/timer|list|focus|deadline|triage/i.test(r.text), "no productivity framing for an emotional problem");
    }
  },
  {
    name: "ambiguous dump gets one focused question, not fake understanding",
    run: function (t) {
      var r = generateReply("Everything feels off lately. Work stuff, personal things, I do not know.", {});
      t.ok((r.text.match(/\?/g) || []).length === 1, "exactly one question");
      t.ok(r.questionKey, "question key tracked for follow-up memory");
    }
  },
  {
    name: "decision names the tradeoff plainly",
    run: function (t) {
      var r = generateReply("Should I quit my job and go freelance, or stay for the promotion? I keep going back and forth.", {});
      t.ok(/versus|vs\.|or/i.test(r.text), "both options visible");
      t.ok(!/pros and cons table|two columns/i.test(r.text), "no elaborate framework");
    }
  },
  {
    name: "follow-up acknowledges and does not repeat the question",
    run: function (t) {
      var first = generateReply("Everything feels off lately. Work stuff, I do not know.", {});
      t.ok(first.questionKey, "first turn asks (precondition)");
      var second = generateReply("It's mostly work — my report is due tomorrow.", {
        userTurns: ["Everything feels off lately. Work stuff, I do not know."],
        openQuestionKey: first.questionKey,
        askedKeys: [first.questionKey]
      });
      t.ok(/got it|thanks/i.test(second.text), "acknowledges the answer like a conversation");
      t.ok(second.questionKey !== first.questionKey, "does not ask the same question twice");
      t.ok(/tomorrow|report/i.test(second.text), "uses the new detail");
    }
  },
  {
    name: "gibberish is admitted, not invented around",
    run: function (t) {
      var r = generateReply("asdf qwerty zxcv blorp", {});
      t.ok(/can't make sense|don't understand/i.test(r.text), "admits uncertainty");
      t.ok(!/timer|list/i.test(r.text), "no generic prescription");
    }
  },
  {
    name: "thanks gets a brief close, not more advice",
    run: function (t) {
      var r = generateReply("Thanks, that actually helps.", { userTurns: ["I was stressed about work."] });
      t.ok(countWords(r.text) <= 30, "short close, got " + countWords(r.text) + " words");
      t.ok(!/\?/.test(r.text), "no follow-up question on the way out");
    }
  },
  {
    name: "casual mood statements are accepted without hidden distress",
    run: function (t) {
      ["im chill asl", "I'm fine."].forEach(function (input) {
        var r = generateReply(input, {});
        t.ok(/good to hear/i.test(r.text), "accepts " + input + " plainly");
        t.ok(!/hidden|admit|denial|not okay|overwhelm|sad|anxious|distress/i.test(r.text), "does not invent distress");
      });
    }
  },
  {
    name: "stated practical intent takes priority over mood language",
    run: function (t) {
      var r = generateReply("I'm fine, just help me understand this assignment.", {});
      t.ok(/send the assignment|part that is unclear|work through/i.test(r.text), "offers immediate assignment help");
      t.ok(!/feelings|bothering|wrong|upset|sad/i.test(r.text), "does not probe emotion");
    }
  },
  {
    name: "explicit concern gets practical reasoning, not generic reassurance",
    run: function (t) {
      var r = generateReply("I feel like I'm falling behind everyone and I don't know what to do.", {});
      t.ok(/area|consequence|action|today/i.test(r.text), "addresses the concrete concern");
      t.ok(!/everything will be okay|you've got this|here to listen/i.test(r.text), "avoids canned reassurance");
    }
  },
  {
    name: "correction is acknowledged without defending the assumption",
    run: function (t) {
      var r = generateReply("No, that's not what I meant.", {});
      t.ok(/misunderstood|got it/i.test(r.text), "acknowledges the mistake");
      t.ok(!/actually|you seem|sometimes it's hard|not okay/i.test(r.text), "does not double down");
    }
  },
  {
    name: "boredom gets a playful option instead of emotional probing",
    run: function (t) {
      var r = generateReply("I'm bored. Entertain me.", {});
      t.ok(/weird fact|quick game|creative challenge|debate/i.test(r.text), "offers something fun");
      t.ok(!/bothering|wrong|sad|upset|what's going on/i.test(r.text), "does not invent a problem");
    }
  }
];

var pass = 0, fail = 0;
CASES.forEach(function (c) {
  var errors = [];
  var t = { ok: function (cond, msg) { if (!cond) errors.push(msg); } };
  var r;
  try {
    // Global invariants for every reply.
    var sample = generateReply("I have a report due tomorrow and I am worried I will mess it up.", {});
    var text = sample.text;
    t.ok(countWords(text) <= 150, "global: concise (got " + countWords(text) + " words)");
    t.ok(!/#{1,3} /.test(text) && !/^\s*[-*] /m.test(text), "global: no headings or bullet frameworks");
    t.ok(!BANNED.some(function (p) { return text.toLowerCase().indexOf(p) !== -1; }), "global: no banned template/jargon/cliché language");
    c.run(t);
  } catch (e) { errors.push("threw: " + e.message); }
  if (!errors.length) { pass++; console.log("PASS " + c.name); }
  else { fail++; console.log("FAIL " + c.name); errors.forEach(function (e) { console.log("     - " + e); }); }
});
console.log("\n" + pass + " passed, " + fail + " failed.");
process.exit(fail ? 1 : 0);
