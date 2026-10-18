/* Back to Center — local conversational responder (no AI, no network).
 *
 * Honest scope: this is pattern matching over the user's own words. It cannot
 * truly understand, remember like a person, or reason about anything unstated.
 * What it CAN do: notice a few clearly-distinguishable situations, name the
 * central issue plainly, push back on obvious distortions, and offer one
 * concrete move or one question. Everything else it admits it doesn't know.
 *
 * DeepInfra handles normal AI replies. This responder is retained for times
 * when the provider or local server cannot be reached:
 * generateReply(userText, ctx) -> { text, questionKey }.
 */
(function (root) {
  "use strict";

  function normalize(text) {
    return (text || "").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
  }

  function words(text) {
    var m = (text || "").trim().match(/\S+/g);
    return m ? m.length : 0;
  }

  function has(lower, phrase) {
    return lower.indexOf(phrase) !== -1;
  }

  function hasAny(lower, list) {
    return list.some(function (p) { return lower.indexOf(p) !== -1; });
  }

  /* Small, narrow cue lists. Cues select a conversational stance — never a
     diagnosis, never a claim about motives, never an assumed emotion. */

  var SELF_CRIT = [
    "i'm a failure", "im a failure", "i am a failure", "i hate myself",
    "worthless", "useless", "pathetic", "i'm so lazy", "im so lazy",
    "i'm stupid", "im stupid", "what's wrong with me", "whats wrong with me",
    "i always mess", "can't do anything right", "cant do anything right",
    "everyone else can", "loser", "burden"
  ];

  var MINDREAD = [
    "left me on read", "hasn't replied", "hasnt replied", "ignoring me",
    "mad at me", "thinks i'm", "thinks im", "probably thinks",
    "dry reply", "short reply", "cancelled on me", "canceled on me", "ghost"
  ];

  var STUCK = [
    "putting off", "keep putting", "procrastinat", "can't start", "cant start",
    "don't know where to begin", "dont know where to begin", "blank page",
    "staring at", "dread starting", "avoiding", "keep scrolling",
    "scrolling instead", "no motivation", "know i should but"
  ];

  var DECISION = [
    "should i", "stay or", "quit", "resign", "between two", "which offer",
    "what to do with my life", "can't decide", "cant decide", "stuck between"
  ];

  var TASK = [
    "need to", "have to", "must ", "deadline", "due ", "email to", "reply to",
    "call back", "text back", "asked me to", "fix ", "book ", "send ",
    "finish ", "submit", "pay ", "reschedule", "appointment"
  ];

  var TIMING = ["today", "tonight", "tomorrow", "due ", "deadline", "by friday",
    "by monday", "by tuesday", "by wednesday", "by thursday", "this week", "next week"];

  var THANKS = ["thank", "that helps", "that helped", "makes sense", "feel better", "bye", "good night", "goodnight"];

  // These cues are deliberately non-diagnostic. They let the fallback accept
  // a user's stated mood instead of turning a casual check-in into probing.
  var CASUAL = ["i'm fine", "im fine", "i am fine", "i'm good", "im good", "i am good",
    "i'm okay", "im okay", "i am okay", "i'm ok", "im ok", "i am ok", "i'm chill",
    "im chill", "i am chill", "i'm happy", "im happy", "i am happy", "i'm calm", "im calm", "i am calm",
    "i'm great", "im great", "i am great", "all good", "doing fine", "doing good", "not upset",
    "not sad", "not stressed", "nothing's wrong", "nothings wrong"];
  var CORRECTION = ["that's not what i meant", "thats not what i meant", "not what i meant",
    "you misunderstood", "i meant", "no, i meant", "no i meant"];
  var BORED = ["i'm bored", "im bored", "i am bored", "entertain me", "make me laugh"];
  var DIRECT_HELP = ["help me understand", "help with", "how do i", "what does this mean",
    "assignment", "homework", "question about"];
  var EXPLICIT_CONCERN = ["falling behind", "don't know what to do", "dont know what to do",
    "feel stuck", "can't keep up", "cant keep up", "overwhelmed", "anxious", "worried"];

  var CONTRADICTORY_REPLY = /\b(?:hard to admit|trying to convince yourself|not really\s+(?:fine|okay|ok|happy|good)|deep down|in denial|hiding (?:how|what|your)|something(?:'s| is) wrong|even if you say|you seem\s+(?:sad|upset|overwhelmed|anxious|distressed)|not entirely okay)\b/i;

  var COMMON = ["i", "me", "my", "the", "and", "to", "of", "feel", "work", "job",
    "friend", "because", "when", "what", "about", "with", "have", "need"];

  function shortBit(s, n) {
    s = normalize(s).replace(/^[“"']+|[”"'.!?]+$/g, "").trim();
    n = n || 60;
    if (s.length <= n) return s;
    return s.slice(0, n).replace(/\s+\S*$/, "") + "…";
  }

  function firstSentence(text) {
    var parts = normalize(text).match(/[^.!?\n]+[.!?"”']?/g) || [text];
    return (parts[0] || "").trim();
  }

  // Pull one concrete handle (the thing to act on) from the user's words.
  function findHandle(text) {
    var m = normalize(text).match(/(?:need to|have to|must|should|going to|got to)\s+([^.,;!?]{3,55})/i);
    if (m) return shortBit(m[1], 45);
    return null;
  }

  function findTiming(text) {
    var l = text.toLowerCase();
    if (/\btonight\b/.test(l)) return "tonight";
    if (/\btomorrow\b/.test(l)) return "tomorrow";
    if (/\btoday\b/.test(l)) return "today";
    var m = l.match(/\b(?:by|before|due)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    if (m) return "by " + m[1];
    if (/\bthis week\b/.test(l)) return "this week";
    if (/\bnext week\b|\bsoon\b/.test(l)) return "soon";
    return null;
  }

  function findOptions(text) {
    var t = normalize(text);
    var m = t.match(/should i\s+([^?.!]{3,50}?)\s+or\s+([^?.!]{3,50}?)([?.!]|$)/i);
    if (m) return { a: shortBit(m[1], 40), b: shortBit(m[2], 40) };
    var b2 = t.match(/between\s+([^.,;!?]{3,40}?)\s+and\s+([^.,;!?]{3,40})/i);
    if (b2) return { a: shortBit(b2[1], 40), b: shortBit(b2[2].split(/\s+and\s+/i)[0], 40) };
    return null;
  }

  function readSituation(text) {
    var l = text.toLowerCase();
    return {
      selfCritic: hasAny(l, SELF_CRIT),
      mindread: hasAny(l, MINDREAD),
      stuck: hasAny(l, STUCK),
      decision: hasAny(l, DECISION),
      task: hasAny(l, TASK),
      timing: findTiming(text),
      handle: findHandle(text),
      options: findOptions(text),
      shortWords: words(text)
    };
  }

  function hasPositiveSelfReport(text) {
    var l = normalize(text).toLowerCase();
    if (!l || hasAny(l, EXPLICIT_CONCERN) || hasAny(l, SELF_CRIT)) return false;
    return hasAny(l, CASUAL) && !hasAny(l, DIRECT_HELP);
  }

  function conversationGuard(text) {
    var normalized = normalize(text);
    var lower = normalized.toLowerCase();
    if (hasAny(lower, CORRECTION)) return {
      kind: "correction",
      text: "Got it — I misunderstood you. What did you mean?",
      questionKey: "correction"
    };
    if (hasPositiveSelfReport(normalized)) return {
      kind: "self-report",
      text: "Good to hear. What do you feel like talking about?",
      questionKey: null
    };
    return null;
  }

  function contradictsGuardrail(reply, guard) {
    return Boolean(guard && guard.kind === "self-report" && CONTRADICTORY_REPLY.test(normalize(reply)));
  }

  /* ---------------- reply builders (plain prose, no template) ---------------- */

  var builders = {
    gibberish: function () {
      return {
        text: "I can't make sense of that, and I'd rather say so than guess.\n\nIf there's something on your mind, try one plain sentence — for example, what's been bothering you and when it got louder.",
        questionKey: null
      };
    },

    short: function () {
      return {
        text: "That's a real thread, but it's only a few words — I don't want to pretend I know the rest.\n\nWhat's one more detail? When it shows up, or what part of it weighs most.",
        questionKey: "more-detail"
      };
    },

    thanks: function () {
      return {
        text: "Glad that helped, even a little. If more comes up later, I'm here.",
        questionKey: null
      };
    },

    casual: function () {
      return {
        text: "Good to hear. What do you feel like talking about?",
        questionKey: null
      };
    },

    correction: function () {
      return {
        text: "Got it — I misunderstood you. What did you mean?",
        questionKey: "correction"
      };
    },

    boredom: function () {
      return {
        text: "Easy. Pick one: a weird fact, a quick game, a tiny creative challenge, or a debate topic.",
        questionKey: null
      };
    },

    directHelp: function () {
      return {
        text: "Sure — send the assignment or the part that is unclear, and I’ll help you work through it.",
        questionKey: null
      };
    },

    explicitConcern: function (s, text) {
      var l = text.toLowerCase();
      if (has(l, "falling behind") || has(l, "keep up")) {
        return {
          text: "Feeling behind usually gets worse when you compare the whole gap at once. Name the one area with the most immediate consequence, then choose one small action there today — not a plan to catch up on everything.",
          questionKey: null
        };
      }
      return {
        text: "There is a real problem here, not a character verdict. Separate what is actually happening from the story you are telling about it, then take the smallest useful action you can control today.",
        questionKey: null
      };
    },

    selfAttack: function (s, text) {
      var move = s.handle
        ? "One thing worth doing: give “" + s.handle + "” two minutes — open it and write one deliberately bad first line. That's the whole task."
        : "One thing worth doing: pick the smallest piece of what's in front of you and touch it for two minutes. Rough counts.";
      return {
        text: "That label — the “failure”, “lazy” kind of talk — isn't a fact. It's what you say to yourself when you're already down, and it makes everything harder to start.\n\nWhat actually happened is much smaller than that label. " + move,
        questionKey: null
      };
    },

    stuck: function (s) {
      var target = s.handle ? "“" + s.handle + "”" : "it";
      return {
        text: "Sounds like the block isn't the work itself, it's getting started — the blank page feels bigger than whatever comes after it.\n\nShrink the start until it's almost silly: open " + target + " and write one bad first line. Two minutes, then you're free to stop.",
        questionKey: null
      };
    },

    relationship: function (s, text) {
      var l = text.toLowerCase();
      var wants = /want|hope|wish|apolog|talk\b|break up|stay|space|clarity/.test(l);
      var base = "Here's the honest split: something happened — a message, a silence — and then your mind filled in what it means. The first part you know. The second part, that they're upset with you, you don't actually know yet.\n\n";
      if (wants) {
        return {
          text: base + "Since you know what you want from them, say it plainly in two sentences and send it — or decide you're done replaying it tonight. Either beats a third hour of re-reading.",
          questionKey: null
        };
      }
      return {
        text: base + "Replaying it won't settle which one is true. What would you actually want here — a reply, clarity, or just relief from thinking about it?",
        questionKey: "want-relationship"
      };
    },

    decision: function (s) {
      if (s.options) {
        return {
          text: "So it's roughly “" + s.options.a + "” versus “" + s.options.b + "”. No one can pick that for you — but here's what usually breaks the tie: which one would you want to hear more about from someone living it?\n\nAsk one person doing the foggier one what a normal week is actually like. One answer beats another week of going back and forth.",
          questionKey: null
        };
      }
      return {
        text: "Sounds like you're choosing without the one fact that would settle it. That's why it keeps looping.\n\nWhat's the single thing you don't know yet that would change your mind either way?",
        questionKey: "missing-fact"
      };
    },

    practical: function (s) {
      var when = s.timing ? " " + s.timing : "";
      var what = s.handle ? "“" + s.handle + "”" : "it";
      return {
        text: "This one's concrete, which is good news — it doesn't need untangling, just doing.\n\nDo " + what + when + ": open the site, the form, or the contact, and get the one message or booking sent. Drafting it counts if sending feels big.",
        questionKey: null
      };
    },

    overload: function (s, text) {
      var f = firstSentence(text);
      return {
        text: "That's a lot landing at once — and the pile itself is the problem, not any single item in it.\n\nDon't try to hold all of it. Which one has the nearest real consequence if it slips? Start there, and let the rest wait on purpose. If you tell me the two loudest, I'll help you pick.",
        questionKey: "which-loudest"
      };
    },

    ambiguous: function () {
      return {
        text: "I can tell something's been circling, but I can't see its shape yet — and I won't pretend otherwise.\n\nWhich feels closest: something due, a choice you're avoiding, or one concrete thing that's broken?",
        questionKey: "which-kind"
      };
    }
  };

  function classify(s, text) {
    var w = s.shortWords;
    var l = text.toLowerCase();
    var hasCommon = COMMON.some(function (cw) {
      return l === cw || (" " + l + " ").indexOf(" " + cw + " ") !== -1;
    });
    if (w === 0) return "empty";
    if (hasAny(l, CORRECTION)) return "correction";
    if (hasAny(l, DIRECT_HELP)) return "directHelp";
    if (hasAny(l, BORED)) return "boredom";
    if (hasAny(l, CASUAL)) return "casual";
    if (hasAny(l, EXPLICIT_CONCERN)) return "explicitConcern";
    if (hasAny(l, THANKS) && w < 20) return "thanks";
    if (w < 12 && !hasCommon) return "gibberish";
    if (s.selfCritic) return "selfAttack";
    if (s.mindread) return "relationship";
    if (s.decision) return "decision";
    if (s.stuck) return "stuck";
    if (s.task && s.timing) return "practical";
    if (w < 8) return "short";
    // Several demands at once?
    var demands = (l.match(/,/g) || []).length + (l.match(/\band\b/g) || []).length;
    if (s.task && demands >= 3) return "overload";
    if (s.task) return "practical";
    return "ambiguous";
  }

  /* ---------------- public entry point ---------------- */

  function generateReply(rawText, ctx) {
    ctx = ctx || {};
    var text = normalize(rawText);
    var userTurns = ctx.userTurns || [];
    var askedKeys = ctx.askedKeys || [];
    var s = readSituation(text);
    var kind = classify(s, text);
    var built;

    if (kind === "empty") {
      return { text: "", questionKey: null };
    }

    // Follow-up awareness: if they answered our question, say so briefly and
    // don't fire another question straight back unless genuinely needed.
    var answeredKey = ctx.openQuestionKey && words(text) > 0 && kind !== "gibberish"
      ? ctx.openQuestionKey : null;
    var ack = "";
    if (userTurns.length > 0 && answeredKey && builders[kind]) {
      if (kind === "ambiguous" || kind === "short") {
        ack = "Thanks — that gives me more to work with. ";
      } else {
        ack = "Got it. ";
      }
    }

    built = builders[kind](s, text);

    // Don't repeat a question they've already been asked.
    if (built.questionKey && askedKeys.indexOf(built.questionKey) !== -1) {
      built = {
        text: built.text.replace(/\n\n[^]*$/, ""),
        questionKey: null
      };
      if (!/\.$/.test(built.text)) built.text += ".";
      built.text += " Tell me whichever piece feels most alive and we'll go from there.";
    }

    var finalText = ack + built.text;

    // Hard caps: concise, no headings, no bullet frameworks, ever.
    var wCount = words(finalText);
    if (wCount > 150) {
      var sents = finalText.match(/[^.!?\n]+[.!?]/g) || [finalText];
      var cut = "";
      for (var i = 0; i < sents.length; i++) {
        if (words(cut + sents[i]) > 140) break;
        cut += sents[i] + " ";
      }
      finalText = cut.trim();
    }

    return { text: finalText, questionKey: built.questionKey };
  }

  var exposes = { generateReply: generateReply, readSituation: readSituation, conversationGuard: conversationGuard, contradictsGuardrail: contradictsGuardrail };
  root.generateReply = generateReply;
  root.BackToCenterResponder = exposes;
  if (typeof module !== "undefined" && module.exports) module.exports = exposes;
})(typeof window !== "undefined" ? window : globalThis);
