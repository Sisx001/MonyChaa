'use strict';
// Offline quick-reply suggestions: given an incoming message, produce a few
// short, ready-to-send candidate replies based on its detected intent (and a
// nudge for urgency). No LLM call — instant, free, and usable from the panel
// today and Telegram later. Pure function → deterministic and testable.

const { classify } = require('./intent');
const { score } = require('./urgency');

const TEMPLATES = {
  greeting:  ['Hey! How can I help?', 'Hi there 👋', 'Hello! What can I do for you?'],
  smalltalk: ['Doing well, thanks — how about you?', 'Pretty good! You?', 'All good here 🙂'],
  complaint: ["I'm really sorry about that — let me look into it right away.", "That shouldn't have happened. Can you share a bit more so I can fix it?", 'Apologies for the trouble, I\'ll get this sorted.'],
  feedback:  ['Thank you, that means a lot! 🙏', 'So glad to hear it!', 'Really appreciate you saying that.'],
  question:  ['Good question — let me check and get right back to you.', 'Happy to help with that.', 'Sure! Give me one sec.'],
  request:   ["On it — I'll take care of that.", 'Sure thing, I\'ll get that sorted.', 'Consider it done 👍'],
  statement: ['Got it, thanks for letting me know.', 'Understood 👍', 'Noted!'],
  unknown:   ['Got it!', 'Thanks!', '👍'],
};

/** Returns { intent, urgent, suggestions: string[] } — up to 3 candidates. */
function suggest(text) {
  const s = String(text || '');
  const { intent } = classify(s);
  const urgent = score(s).level === 'high';
  let list = (TEMPLATES[intent] || TEMPLATES.unknown).slice();
  // For urgent messages, lead with a fast acknowledgement.
  if (urgent) list = ['On it right now — give me a moment.', ...list].slice(0, 3);
  return { intent, urgent, suggestions: list.slice(0, 3) };
}

module.exports = { suggest };
