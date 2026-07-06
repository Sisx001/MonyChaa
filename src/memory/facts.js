'use strict';
// Global facts/FAQ knowledge base.
const db = require('../db/schema');

function list(filter) {
  if (filter) {
    return db.prepare(
      "SELECT * FROM facts WHERE key LIKE ? OR value LIKE ? ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, updated_at DESC"
    ).all(`%${filter}%`, `%${filter}%`);
  }
  return db.prepare(
    "SELECT * FROM facts ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, updated_at DESC"
  ).all();
}

function upsert(key, value, priority = 'casual') {
  db.prepare(`
    INSERT INTO facts (key, value, priority) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, priority = excluded.priority, updated_at = datetime('now')
  `).run(key, value, priority);
}

function remove(id) {
  db.prepare('DELETE FROM facts WHERE id = ?').run(id);
}

/** Facts formatted for prompt injection, critical first. */
function forPrompt(maxChars = 2000) {
  const rows = list();
  let out = '';
  for (const f of rows) {
    const line = `- ${f.key}: ${f.value}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out.trim();
}

module.exports = { list, upsert, remove, forPrompt };
