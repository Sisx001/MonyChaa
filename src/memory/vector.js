'use strict';
// Lightweight vector memory: embeddings stored in SQLite, cosine similarity in JS.
// No external vector DB required (ChromaDB/LanceDB can be swapped in later).
const db = require('../db/schema');
const logger = require('../logger');
const config = require('../config');
const { chat } = require('../llm/fallback');
const { embed } = require('../llm/gateway');

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

async function remember(chatId, content, priority = 'casual') {
  const vec = await embed(content);
  db.prepare('INSERT INTO memories (chat_id, content, priority, embedding) VALUES (?, ?, ?, ?)')
    .run(chatId, content, priority, vec ? JSON.stringify(vec) : null);
}

/**
 * Semantic recall. With memory_isolation=on only this chat's memories are searched;
 * off shares memories across all contacts.
 */
async function recall(chatId, query, limit) {
  if (config.getSetting('vector_memory') !== 'on') return [];
  limit = limit || Number(config.getSetting('recall_count')) || 5;
  const threshold = Number(config.getSetting('similarity_threshold')) || 0.45;
  const isolated = config.getSetting('memory_isolation') === 'on';
  const rows = isolated
    ? db.prepare('SELECT * FROM memories WHERE chat_id = ?').all(chatId)
    : db.prepare('SELECT * FROM memories').all();
  if (!rows.length) return [];

  const qvec = await embed(query);
  if (!qvec) {
    // No embedding available — fall back to keyword scoring.
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    return rows
      .map(r => ({ ...r, score: words.filter(w => r.content.toLowerCase().includes(w)).length }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  return rows
    .filter(r => r.embedding)
    .map(r => ({ ...r, score: cosine(qvec, JSON.parse(r.embedding)) }))
    .filter(r => r.score > threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function list(chatId, filter) {
  let sql = 'SELECT id, chat_id, content, priority, created_at FROM memories';
  const params = [];
  const where = [];
  if (chatId) { where.push('chat_id = ?'); params.push(chatId); }
  if (filter) { where.push('content LIKE ?'); params.push(`%${filter}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT 500';
  return db.prepare(sql).all(...params);
}

function forget(id) {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

/** Auto-extract durable facts from a recent exchange (fire-and-forget). */
async function extractFacts(chatId, userText, assistantText) {
  if (config.getSetting('auto_extract_facts') !== 'on') return;
  // Only bother for substantive messages.
  if (userText.length < 40) return;
  try {
    const result = await chat([
      {
        role: 'system',
        content: 'Extract durable personal facts worth remembering from this exchange (preferences, plans, relationships, dates, commitments). ' +
          'Reply with a JSON array of objects: [{"fact": "...", "priority": "critical|important|casual"}]. ' +
          'Reply [] if nothing is worth remembering. JSON only, no markdown.',
      },
      { role: 'user', content: `Them: ${userText}\nMe: ${assistantText}` },
    ], { maxTokens: 300, temperature: 0 });
    const cleaned = result.text.replace(/```json|```/g, '').trim();
    const facts = JSON.parse(cleaned);
    if (!Array.isArray(facts)) return;
    for (const f of facts.slice(0, 5)) {
      if (f && f.fact) await remember(chatId, f.fact, ['critical', 'important', 'casual'].includes(f.priority) ? f.priority : 'casual');
    }
  } catch (err) {
    logger.debug(`extractFacts skipped: ${err.message}`);
  }
}

function exportAll() {
  return {
    memories: db.prepare('SELECT chat_id, content, priority, created_at FROM memories').all(),
    facts: db.prepare('SELECT key, value, priority FROM facts').all(),
  };
}

async function importAll(payload) {
  const factsStore = require('./facts');
  let count = 0;
  for (const f of payload.facts || []) {
    if (f.key && f.value) { factsStore.upsert(f.key, f.value, f.priority || 'casual'); count++; }
  }
  for (const m of payload.memories || []) {
    if (m.content) { await remember(m.chat_id || 0, m.content, m.priority || 'casual'); count++; }
  }
  return count;
}

module.exports = { remember, recall, list, forget, extractFacts, exportAll, importAll };
