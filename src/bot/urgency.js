'use strict';
// Score how time-sensitive an incoming message feels, 0–100, from wording,
// punctuation and shouting. Used to prioritize replies and (later) to alert.
// Pure function → deterministic and testable.

/** Returns { score (0–100), level: 'low'|'medium'|'high' }. */
function score(text) {
  const s = String(text || '');
  if (!s.trim()) return { score: 0, level: 'low' };
  const lower = s.toLowerCase();
  let pts = 0;

  // Strong urgency vocabulary.
  if (/\b(urgent|asap|emergency|immediately|right now|right away|can'?t wait|need (it|this) now)\b/.test(lower)) pts += 40;
  // Time pressure / deadlines.
  if (/\b(today|tonight|this (morning|afternoon)|by (noon|eod|cob|\d)|deadline|due (today|now|soon)|before \d)\b/.test(lower)) pts += 25;
  // Nudges for a fast response.
  if (/\b(please respond|reply asap|get back to me|waiting on you|any update|still waiting)\b/.test(lower)) pts += 15;

  // Punctuation intensity: runs of exclamation marks.
  const bangs = (s.match(/!/g) || []).length;
  if (bangs >= 3) pts += 15; else if (bangs >= 1) pts += 8;

  // Shouting: a decent run of all-caps letters.
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 6 && letters === letters.toUpperCase()) pts += 15;

  pts = Math.max(0, Math.min(100, pts));
  const level = pts >= 60 ? 'high' : pts >= 30 ? 'medium' : 'low';
  return { score: pts, level };
}

module.exports = { score };
