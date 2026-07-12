'use strict';
// Human typing simulation: bursty timing, variable delays, momentum-aware.
const config = require('../config');

const SPEED = {
  slow: { cps: 4, readWpm: 180, jitter: 0.5 },
  medium: { cps: 7, readWpm: 260, jitter: 0.35 },
  fast: { cps: 12, readWpm: 400, jitter: 0.2 },
};

function rand(min, max) { return min + Math.random() * (max - min); }

/**
 * Compute a human-like delay plan for replying to `incoming` with `reply`.
 * Momentum: rapid back-and-forth conversations get faster responses.
 */
function delayPlan(incoming, reply, { delayMultiplier = 1, momentum = 0, priority = 0 } = {}) {
  if (config.getSetting('typing_simulation') !== 'on') {
    return { thinkMs: 0, typeMs: 0, totalMs: 0 };
  }
  const speed = SPEED[config.getSetting('typing_speed')] || SPEED.medium;

  // Reading time for the incoming message.
  const words = String(incoming || '').split(/\s+/).length;
  let readMs = (words / speed.readWpm) * 60000;

  // "Thinking" pause — bursty: usually short, occasionally longer.
  let thinkMs = Math.random() < 0.8 ? rand(600, 2500) : rand(2500, 7000);

  // Typing time proportional to reply length.
  let typeMs = (String(reply || '').length / speed.cps) * 1000;
  typeMs *= rand(1 - speed.jitter, 1 + speed.jitter);

  // Momentum: 0..1, higher = mid-conversation flow, respond faster.
  const momentumFactor = 1 - 0.6 * Math.min(1, Math.max(0, momentum));
  // VIP priority contacts get faster responses.
  const priorityFactor = priority > 0 ? 0.6 : 1;

  const mult = Math.max(0.1, delayMultiplier) * momentumFactor * priorityFactor;
  readMs *= mult; thinkMs *= mult; typeMs *= mult;

  // Clamp to sane bounds.
  const totalPre = Math.min(readMs + thinkMs, 20000);
  typeMs = Math.min(typeMs, 25000);
  return { thinkMs: Math.round(totalPre), typeMs: Math.round(typeMs), totalMs: Math.round(totalPre + typeMs) };
}

/**
 * Split a long reply into message bursts like a human sending several messages.
 * Keeps paragraphs together; only splits when there are natural breaks.
 */
function splitBursts(text) {
  if (config.getSetting('double_text') !== 'on') return [String(text).trim()];
  const maxBursts = Math.max(1, Number(config.getSetting('max_bursts')) || 3);
  const parts = String(text).split(/\n\n+/).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1 || text.length < 240 || maxBursts === 1) return [text.trim()];
  // Merge tiny fragments into neighbors, cap at max_bursts.
  const bursts = [];
  for (const p of parts) {
    if (bursts.length && (bursts[bursts.length - 1].length < 60 || bursts.length >= maxBursts)) {
      bursts[bursts.length - 1] += '\n\n' + p;
    } else {
      bursts.push(p);
    }
  }
  return bursts;
}

// Intensity of output roughening for each humanize level.
const IMPERFECTION = {
  subtle:  { dropPeriod: 0.30, lowerStart: 0.0,  softEllipsis: 0.2 },
  natural: { dropPeriod: 0.55, lowerStart: 0.40, softEllipsis: 0.4 },
};

/**
 * Roughen an LLM reply so it reads like a person texting rather than an
 * assistant: occasionally drop a trailing period, lowercase the start of a
 * short casual line, relax "..." spacing. Pure + deterministic when given an
 * `rng`, so it's testable. Never touches links, questions, or exclamations.
 * `level`: 'off' | 'subtle' | 'natural'.
 */
function humanize(text, level = 'off', rng = Math.random) {
  const cfg = IMPERFECTION[level];
  if (!cfg || !text) return text;
  const lines = String(text).split('\n');
  const out = lines.map(line => {
    let s = line;
    const trimmed = s.trimEnd();
    // Lowercase the first letter of a short, single-clause casual line.
    if (cfg.lowerStart && rng() < cfg.lowerStart &&
        trimmed.length > 0 && trimmed.length < 60 && !/[.!?].+[.!?]/.test(trimmed) &&
        /^[A-Z][a-z]/.test(trimmed) && !/^I\b/.test(trimmed)) {
      s = s[0].toLowerCase() + s.slice(1);
    }
    // Drop a single trailing period (not ?, !, or an ellipsis) — but not on
    // lines that end in a URL.
    if (cfg.dropPeriod && rng() < cfg.dropPeriod &&
        /[A-Za-z0-9)\]"']\.$/.test(s.trimEnd()) && !/\.\.\.$/.test(s.trimEnd()) &&
        !/https?:\/\/\S+$/.test(s.trimEnd())) {
      s = s.replace(/\.(\s*)$/, '$1');
    }
    // Relax a spaced-out ellipsis into a natural trailing one.
    if (cfg.softEllipsis && rng() < cfg.softEllipsis) {
      s = s.replace(/\s*\.\s*\.\s*\.\s*$/, '...');
    }
    return s;
  });
  return out.join('\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { delayPlan, splitBursts, humanize, sleep };
