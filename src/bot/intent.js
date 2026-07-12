'use strict';
// Classify the intent of an incoming message so the bot (and the panel) knows
// what kind of thing it's answering: greeting, smalltalk, complaint, feedback,
// question, request, or a plain statement. Heuristic + ordered → the first
// matching category wins. Pure function → deterministic and testable.

const RULES = [
  { intent: 'greeting', test: s => /^(hi|hey+|hello+|yo|howdy|greetings|good (morning|afternoon|evening)|hiya|sup)\b/i.test(s.trim()) && s.split(/\s+/).length <= 5 },
  { intent: 'smalltalk', test: s => /\b(how are you|how(?:'|’| a)re ya|what'?s up|how'?s it going|how have you been|nice weather|how was your (day|weekend))\b/i.test(s) },
  { intent: 'complaint', test: s => /\b(broken|not working|doesn'?t work|isn'?t working|refund|complaint|terrible|awful|worst|useless|disappointed|unacceptable|ridiculous|angry|furious)\b/i.test(s) },
  { intent: 'feedback', test: s => /\b(thank you|thanks|thx|love (it|this)|great (job|work|service)|amazing|awesome|well done|appreciate|you'?re the best|much appreciated)\b/i.test(s) },
  { intent: 'question', test: s => /\?/.test(s) || /^(what|why|how|when|where|who|which|whose|can|could|would|do|does|did|is|are|was|were|will|should|may)\b/i.test(s.trim()) },
  { intent: 'request', test: s => /\b(please|can you|could you|would you|will you|i need|i'?d like|i want|send me|help me|let me know|make sure|set up|schedule|book)\b/i.test(s) },
];

/** Classify a message. Returns { intent } — one of the categories or 'statement'. */
function classify(text) {
  const s = String(text || '');
  if (!s.trim()) return { intent: 'unknown' };
  for (const r of RULES) if (r.test(s)) return { intent: r.intent };
  return { intent: 'statement' };
}

module.exports = { classify };
