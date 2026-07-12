'use strict';
// Detect whether an incoming message actually asks something that needs an
// answer — including implicit questions with no "?" ("let me know your
// availability", "wondering if you're free"). Complements intent classification
// by counting questions and flagging when a reply is genuinely expected.
// Pure function → deterministic and testable.

const IMPLICIT = /\b(let me know|wondering if|any idea|do you know|could you tell me|can you tell me|i(?:'| a)?m curious|would love to know|not sure (?:if|whether)|what'?s your (?:take|thoughts)|thoughts\?*$)\b/i;
const INTERROGATIVE = /^(what|why|how|when|where|who|which|whose|whom|can|could|would|will|do|does|did|is|are|was|were|should|may|might|shall)\b/i;

/** Returns { isQuestion, count, expectsAnswer }. */
function detect(text) {
  const s = String(text || '');
  if (!s.trim()) return { isQuestion: false, count: 0, expectsAnswer: false };

  const count = (s.match(/\?/g) || []).length;
  // Even without a "?", an interrogative opener or an implicit ask counts.
  const clauses = s.split(/[.!\n]+/).map(c => c.trim()).filter(Boolean);
  const opensInterrogative = clauses.some(c => INTERROGATIVE.test(c));
  const implicit = IMPLICIT.test(s);

  const isQuestion = count > 0 || opensInterrogative || implicit;
  return { isQuestion, count, expectsAnswer: isQuestion };
}

module.exports = { detect };
