'use strict';
// Per-chat conversation history in SQLite, with auto-summarization.
// All operations are scoped by assistant_id (0 = primary bot) so every
// assistant keeps a fully separate brain.
const db = require('../db/schema');
const logger = require('../logger');
const config = require('../config');

function addMessage(chatId, role, content, tokens = 0, assistantId = 0) {
  db.prepare('INSERT INTO conversations (chat_id, role, content, tokens, assistant_id) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, role, content, tokens, assistantId);
}

function getHistory(chatId, limit, assistantId = 0) {
  const n = limit || Number(config.getSetting('history_limit')) || 30;
  const rows = db.prepare(
    'SELECT role, content FROM conversations WHERE chat_id = ? AND assistant_id = ? ORDER BY id DESC LIMIT ?'
  ).all(chatId, assistantId, n);
  return rows.reverse();
}

function countMessages(chatId, assistantId = 0) {
  return db.prepare('SELECT COUNT(*) AS c FROM conversations WHERE chat_id = ? AND assistant_id = ?').get(chatId, assistantId).c;
}

function clearHistory(chatId, assistantId = 0) {
  db.prepare('DELETE FROM conversations WHERE chat_id = ? AND assistant_id = ?').run(chatId, assistantId);
}

/**
 * When a conversation grows past the threshold, compress the oldest messages
 * into a single summary row so context stays bounded but nothing is lost.
 */
async function maybeSummarize(chatId, assistantId = 0) {
  const threshold = Number(config.getSetting('auto_summarize_threshold')) || 120;
  if (threshold <= 0) return;
  const count = countMessages(chatId, assistantId);
  if (count < threshold) return;

  const keep = Number(config.getSetting('history_limit')) || 30;
  const excess = count - keep;
  // A negative LIMIT means "no limit" in SQLite and would swallow recent messages.
  if (excess < 10) return;
  const old = db.prepare(
    'SELECT id, role, content FROM conversations WHERE chat_id = ? AND assistant_id = ? ORDER BY id ASC LIMIT ?'
  ).all(chatId, assistantId, excess);
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
        "INSERT INTO conversations (chat_id, role, content, assistant_id) VALUES (?, 'system', ?, ?)"
      ).run(chatId, `[Summary of earlier conversation] ${result.text}`, assistantId);
    });
    tx();
    logger.info(`Summarized ${old.length} old messages for chat ${chatId} (assistant ${assistantId})`);
  } catch (err) {
    logger.warn(`Auto-summarize failed for chat ${chatId}: ${err.message}`);
  }
}

module.exports = { addMessage, getHistory, countMessages, clearHistory, maybeSummarize };
