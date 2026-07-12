'use strict';
// Time-of-day awareness: map a local hour to a period and a short energy hint
// so replies feel appropriate to when the sender is actually texting.
// Pure function → deterministic and testable.

const PERIODS = [
  { period: 'late night', from: 22, to: 5,
    hint: "It's late at night for them — keep it low-key and calm, not peppy. A short reply is kinder." },
  { period: 'morning', from: 5, to: 12,
    hint: "It's morning for them — a little fresh energy is natural, and a brief greeting fits if you're starting the conversation." },
  { period: 'afternoon', from: 12, to: 17,
    hint: "It's afternoon for them — keep a steady, easy tone." },
  { period: 'evening', from: 17, to: 22,
    hint: "It's evening for them — relaxed and warm suits the hour." },
];

/** Classify an hour (0–23) into a period + energy hint. */
function periodFor(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  for (const p of PERIODS) {
    const inRange = p.from < p.to ? (h >= p.from && h < p.to) : (h >= p.from || h < p.to);
    if (inRange) return { period: p.period, hint: p.hint };
  }
  return { period: 'afternoon', hint: PERIODS[2].hint };
}

/** Local hour in a timezone, or the machine hour if the tz is invalid. */
function hourIn(tz, now = new Date()) {
  try {
    const s = now.toLocaleString('en-US', { timeZone: tz || 'UTC', hour: '2-digit', hour12: false });
    const h = parseInt(s.match(/\d{1,2}/)?.[0] ?? '', 10);
    return Number.isFinite(h) ? (h === 24 ? 0 : h) : now.getHours();
  } catch {
    return now.getHours();
  }
}

module.exports = { periodFor, hourIn };
