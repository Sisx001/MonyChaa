'use strict';
// Adaptive reply length: scale the target character cap to the incoming
// message's size/complexity, so a one-word "ok" doesn't get a paragraph and a
// detailed multi-question message isn't answered in a clause. Never exceeds the
// configured base cap. Pure function → deterministic and testable.

/** Suggest a character cap for the reply, given the incoming text + base cap. */
function suggest(incoming, baseMax) {
  const base = Math.max(80, Number(baseMax) || 800);
  const s = String(incoming || '');
  const words = (s.trim().match(/\S+/g) || []).length;
  const questions = (s.match(/\?/g) || []).length;

  let frac;
  if (words <= 3) frac = 0.25;
  else if (words <= 12) frac = 0.5;
  else if (words <= 40) frac = 0.8;
  else frac = 1;

  // People who ask several things deserve a fuller answer.
  if (questions >= 2) frac = Math.max(frac, 0.8);

  const target = Math.round(base * frac);
  // Keep a sensible floor so replies never get absurdly clipped.
  return Math.max(120, Math.min(base, target));
}

module.exports = { suggest };
