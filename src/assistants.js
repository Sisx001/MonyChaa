'use strict';
// Multi-assistant manager: each assistant is an isolated bot with its own
// token, owner, prompt and brain (assistant_id-scoped conversations/memory/logs).
const db = require('./db/schema');
const logger = require('./logger');
const { buildBot, bots, ALLOWED_UPDATES } = require('./bot/handlers');

function list() {
  return db.prepare('SELECT id, name, owner_user_id, admin_user_id, enabled, status, username, last_error, created_at FROM assistants ORDER BY id').all()
    .map(a => ({ ...a, running: bots.has(a.id) }));
}

function descriptor(row) {
  return { id: row.id, name: row.name, token: row.bot_token, ownerId: row.owner_user_id, systemPrompt: row.system_prompt || null };
}

async function start(id) {
  const row = db.prepare('SELECT * FROM assistants WHERE id = ?').get(id);
  if (!row) throw new Error('assistant not found');
  if (!row.bot_token) throw new Error('assistant has no bot token');
  if (bots.has(id)) await stop(id);
  const bot = buildBot(descriptor(row));
  if (!bot) throw new Error('failed to build bot');
  try {
    // grammy start() resolves only when the bot stops; kick it off in the background.
    bot.start({
      allowed_updates: ALLOWED_UPDATES,
      onStart: info => {
        db.prepare("UPDATE assistants SET status = 'running', username = ?, last_error = NULL WHERE id = ?").run(info.username, id);
        logger.info(`Assistant "${row.name}" @${info.username} polling`);
      },
    }).catch(err => {
      db.prepare("UPDATE assistants SET status = 'error', last_error = ? WHERE id = ?").run(err.message.slice(0, 300), id);
      logger.warn(`Assistant "${row.name}" stopped: ${err.message}`);
    });
    return true;
  } catch (err) {
    db.prepare("UPDATE assistants SET status = 'error', last_error = ? WHERE id = ?").run(err.message.slice(0, 300), id);
    throw err;
  }
}

async function stop(id) {
  const entry = bots.get(id);
  if (entry) {
    try { await entry.bot.stop(); } catch { /* already stopped */ }
    bots.delete(id);
  }
  db.prepare("UPDATE assistants SET status = 'stopped' WHERE id = ?").run(id);
}

function create({ name, bot_token, owner_user_id, admin_user_id, system_prompt }) {
  const info = db.prepare(`INSERT INTO assistants (name, bot_token, owner_user_id, admin_user_id, system_prompt)
    VALUES (?, ?, ?, ?, ?)`).run(name || 'Assistant', bot_token || null, owner_user_id || null, admin_user_id || null, system_prompt || null);
  return info.lastInsertRowid;
}

function update(id, fields) {
  const allowed = ['name', 'bot_token', 'owner_user_id', 'admin_user_id', 'system_prompt', 'enabled'];
  const sets = allowed.filter(f => fields[f] !== undefined);
  if (!sets.length) return;
  db.prepare(`UPDATE assistants SET ${sets.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...sets.map(f => fields[f]), id);
}

async function remove(id) {
  await stop(id);
  db.prepare('DELETE FROM assistants WHERE id = ?').run(id);
  // Its brain (assistant_id-scoped rows) is left in place unless explicitly purged.
}

function purgeData(id) {
  for (const t of ['conversations', 'memories', 'messages_log', 'scheduled_messages', 'contacts', 'facts']) {
    db.prepare(`DELETE FROM ${t} WHERE assistant_id = ?`).run(id);
  }
}

/** On boot, start every enabled assistant that has a token. */
async function startAll() {
  const rows = db.prepare('SELECT * FROM assistants WHERE enabled = 1 AND bot_token IS NOT NULL').all();
  for (const row of rows) {
    try { await start(row.id); }
    catch (err) { logger.warn(`Could not start assistant ${row.id}: ${err.message}`); }
  }
  if (rows.length) logger.info(`Started ${rows.length} additional assistant(s)`);
}

module.exports = { list, start, stop, create, update, remove, purgeData, startAll };
