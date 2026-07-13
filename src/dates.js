'use strict';
// Important dates per contact — birthdays, anniversaries, renewals. Stored as
// month/day (+ optional year for age math) and surfaced when they're coming up.
const db = require('./db/schema');

function list(chatId, assistantId = 0) {
  return db.prepare('SELECT * FROM contact_dates WHERE chat_id = ? AND assistant_id = ? ORDER BY month, day')
    .all(chatId, assistantId);
}

function add(chatId, { label, month, day, year = null }, assistantId = 0) {
  const m = Number(month), d = Number(day);
  if (!label || !Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(d) || d < 1 || d > 31) {
    throw new Error('label, month (1-12) and day (1-31) are required');
  }
  const info = db.prepare('INSERT INTO contact_dates (chat_id, assistant_id, label, month, day, year) VALUES (?, ?, ?, ?, ?, ?)')
    .run(chatId, assistantId, String(label).slice(0, 80), m, d, year ? Number(year) : null);
  return info.lastInsertRowid;
}

function remove(id) {
  return db.prepare('DELETE FROM contact_dates WHERE id = ?').run(id).changes;
}

/** Days from `from` until the next occurrence of month/day (year wraps). */
function daysUntil(month, day, from = new Date()) {
  const base = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  let next = Date.UTC(from.getUTCFullYear(), month - 1, day);
  if (next < base) next = Date.UTC(from.getUTCFullYear() + 1, month - 1, day);
  return Math.round((next - base) / 86400000);
}

/** All dates coming up within `windowDays`, joined with contact names. */
function upcoming(windowDays = 30, assistantId = 0, from = new Date()) {
  const rows = db.prepare(`SELECT cd.*, c.name, c.username FROM contact_dates cd
    LEFT JOIN contacts c ON c.chat_id = cd.chat_id AND c.assistant_id = cd.assistant_id
    WHERE cd.assistant_id = ?`).all(assistantId);
  return rows
    .map(r => ({ ...r, inDays: daysUntil(r.month, r.day, from) }))
    .filter(r => r.inDays <= windowDays)
    .sort((a, b) => a.inDays - b.inDays)
    .map(r => ({
      ...r,
      // Age they turn at the next occurrence, when a birth year is known.
      age: r.year ? (new Date(from.getTime() + r.inDays * 86400000).getUTCFullYear() - r.year) : null,
    }));
}

module.exports = { list, add, remove, daysUntil, upcoming };
