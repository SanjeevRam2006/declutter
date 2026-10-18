/* Narrow, rule-based crisis check shared by server and offline browser fallback. */
(function (root) {
  "use strict";

  function explicitRisk(text) {
    var statements = String(text || "").split(/[.!?\n]+/).map(function (part) { return part.trim(); });
    return statements.some(function (part) {
      if (!/^i\b/i.test(part)) return false;
      return /\bi\s*(?:am|'m)\s*(?:going to|about to|ready to|planning to)\s*(?:kill myself|end my life|take my life|hurt myself|kill someone)\b/i.test(part) ||
        /\bi\s*(?:want|need|intend|plan)\s+to\s*(?:kill myself|end my life|take my life|hurt myself)\b/i.test(part) ||
        /\bi\s*(?:have|made)\s+(?:a\s+)?plan\s+to\s*(?:kill myself|end my life|take my life)\b/i.test(part) ||
        /\bi\s*(?:will|might)\s*(?:kill myself|end my life|take my life|hurt myself)\b/i.test(part) ||
        /\bi\s*(?:can't|cannot)\s+keep\s+myself\s+safe\b/i.test(part) ||
        /\bi\s*(?:just\s+)?(?:took|swallowed)\s+(?:a lot of\s+)?(?:pills|poison)\s+to\s+(?:die|kill myself)\b/i.test(part) ||
        /\bi\s*(?:am|'m)\s+being\s+attacked\s+(?:right now|now)\b/i.test(part);
    });
  }

  function statedRegion(messages) {
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user") continue;
      var text = messages[i].content;
      var match = text.match(/\b(?:i am|i'm|i live|i'm living|here)\s+in\s+(?:the\s+)?(india|united states|usa|u\.s\.a\.|us|u\.s\.)\b/i);
      if (match) return /india/i.test(match[1]) ? "india" : "us";
    }
    return null;
  }

  function safetyReply(messages) {
    if (!Array.isArray(messages) || !messages.length || !explicitRisk(messages[messages.length - 1].content)) return null;
    var region = statedRegion(messages);
    var latest = messages[messages.length - 1].content;
    var otherDanger = /\b(?:being\s+attacked|kill someone)\b/i.test(latest);
    var opening = /\bbeing\s+attacked\b/i.test(latest) ?
      "I'm concerned for your immediate safety. If you can, get to a safer place and contact someone nearby who can help. " :
      /\bkill someone\b/i.test(latest) ?
        "I'm concerned that someone could be hurt. Put distance between yourself and them, and contact emergency help now. " :
        "I'm concerned about your immediate safety. Please move away from anything you could use to hurt yourself, and contact a trusted person who can stay with you now. ";
    if (region === "india") return opening + "If you're in immediate danger in India, call 112." + (otherDanger ? "" : " For mental health support, Tele-MANAS is at 14416.");
    if (region === "us") return opening + "If you're in immediate danger in the US, call 911." + (otherDanger ? "" : " You can call or text 988 for crisis support.");
    if (otherDanger) return opening + "Call your local emergency number now.";
    return opening + "If you're in immediate danger, call your local emergency number now, or contact a local crisis line. If you tell someone nearby what's happening, they can help you make the call.";
  }

  var api = { explicitRisk: explicitRisk, statedRegion: statedRegion, safetyReply: safetyReply };
  root.BackToCenterSafety = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
