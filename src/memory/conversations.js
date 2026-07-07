'use strict';
// Per-chat conversation history in SQLite, with auto-summarization.
const db = require('../db/schema');
const logger = require('../logger');
const config = require('../config');

function addMessage(chatId, role, content, tokens = 0) {
  db.prepare('INSERT INTO conversations (chat_id, role, content, tokens) VALUES (?, ?, ?, ?)')
    .run(chatId, role, content, tokens);
}

function getHistory(chatId, limit) {
  const n = limit || Number(config.getSetting('history_limit')) || 30;
  const rows = db.prepare(
    'SELECT role, content FROM conversations WHERE chat_id = ? ORDER BY id DESC LIMIT ?'
  ).all(chatId, n);
  return rows.reverse();
}

function countMessages(chatId) {
  return db.prepare('SELECT COUNT(*) AS c FROM conversations WHERE chat_id = ?').get(chatId).c;
}

function clearHistory(chatId) {
  db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(chatId);
}

/**
 * When a conversation grows past the threshold, compress the oldest messages
 * into a single summary row so context stays bounded but nothing is lost.
 */
async function maybeSummarize(chatId) {
  const threshold = Number(config.getSetting('auto_summarize_threshold')) || 120;
  if (threshold <= 0) return;
  const count = countMessages(chatId);
  if (count < threshold) return;

  const keep = Number(config.getSetting('history_limit')) || 30;
  const excess = count - keep;
  // A negative LIMIT means "no limit" in SQLite and would swallow recent messages.
  if (excess < 10) return;
  const old = db.prepare(
    'SELECT id, role, content FROM conversations WHERE chat_id = ? ORDER BY id ASC LIMIT ?'
  ).all(chatId, excess);
  if (old.length < 10) return;

  try {
    const { chat } = require('../llm/fallback');
    const transcript = old.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 24000);
    const result = await chat([
      { role: 'system', content: 'Summarize this conversation into a compact brief preserving all important facts, commitments, names, dates, and emotional context. Output only the summary.' },
      { role: 'user', content: transcript },
    ], { maxTokens: 500, temperature: 0.2 });

    const tx = db.transaction(() => {
      const del = db.prepare('DELETE FROM conversations WHERE id = ?');
      for (const m of old) del.run(m.id);
      db.prepare(
        "INSERT INTO conversations (chat_id, role, content) VALUES (?, 'system', ?)"
      ).run(chatId, `[Summary of earlier conversation] ${result.text}`);
    });
    tx();
    logger.info(`Summarized ${old.length} old messages for chat ${chatId}`);
  } catch (err) {
    logger.warn(`Auto-summarize failed for chat ${chatId}: ${err.message}`);
  }
}

module.exports = { addMessage, getHistory, countMessages, clearHistory, maybeSummarize };
