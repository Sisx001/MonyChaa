'use strict';
// Keyword-triggered instant replies that short-circuit the LLM entirely —
// zero token cost, instant, deterministic. Checked before generation.
const db = require('./db/schema');
const logger = require('./logger');

function list() {
  return db.prepare('SELECT * FROM autoresponders ORDER BY id DESC').all();
}

function upsert({ id, trigger, match_type = 'contains', reply, enabled = 1 }) {
  if (!trigger || !reply) throw new Error('trigger and reply required');
  if (!['contains', 'exact', 'starts', 'regex'].includes(match_type)) match_type = 'contains';
  if (id) {
    db.prepare('UPDATE autoresponders SET trigger = ?, match_type = ?, reply = ?, enabled = ? WHERE id = ?')
      .run(trigger, match_type, reply, enabled ? 1 : 0, id);
  } else {
    db.prepare('INSERT INTO autoresponders (trigger, match_type, reply, enabled) VALUES (?, ?, ?, ?)')
      .run(trigger, match_type, reply, enabled ? 1 : 0);
  }
}

function setEnabled(id, enabled) {
  db.prepare('UPDATE autoresponders SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

function remove(id) {
  db.prepare('DELETE FROM autoresponders WHERE id = ?').run(id);
}

/** Return the canned reply for an incoming message, or null if none match. */
function match(incomingText) {
  const rows = db.prepare('SELECT * FROM autoresponders WHERE enabled = 1').all();
  const text = String(incomingText || '');
  const lower = text.toLowerCase();
  for (const r of rows) {
    const trig = String(r.trigger);
    let hit = false;
    try {
      switch (r.match_type) {
        case 'exact': hit = lower.trim() === trig.toLowerCase().trim(); break;
        case 'starts': hit = lower.trimStart().startsWith(trig.toLowerCase()); break;
        case 'regex': hit = new RegExp(trig, 'i').test(text); break;
        default: hit = lower.includes(trig.toLowerCase());
      }
    } catch (err) { logger.debug(`autoresponder regex error: ${err.message}`); }
    if (hit) {
      db.prepare('UPDATE autoresponders SET uses = uses + 1 WHERE id = ?').run(r.id);
      return r.reply;
    }
  }
  return null;
}

module.exports = { list, upsert, setEnabled, remove, match };
