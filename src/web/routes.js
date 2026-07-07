'use strict';
// REST API for the admin panel.
const express = require('express');
const db = require('../db/schema');
const config = require('../config');
const analytics = require('../analytics');
const facts = require('../memory/facts');
const vector = require('../memory/vector');
const conversations = require('../memory/conversations');
const { PROVIDERS, chatOnce, isConfigured } = require('../llm/gateway');
const { chat, candidates } = require('../llm/fallback');
const { TOOLS, enabledTools } = require('../tools');
const { buildSystemPrompt } = require('../bot/reply');

const router = express.Router();

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  res.status(500).json({ error: err.message });
});

// ---------- Stats ----------
router.get('/stats', wrap((req, res) => {
  const { getQueueDepth } = require('../bot/handlers');
  const s = analytics.stats();
  s.queueDepth = getQueueDepth();
  s.currentModel = `${config.getSetting('primary_provider')}/${config.getSetting('primary_model')}`;
  res.json(s);
}));

// ---------- Settings ----------
router.get('/settings', wrap((req, res) => res.json(config.allSettings())));

router.put('/settings', wrap((req, res) => {
  const updates = req.body || {};
  for (const [key, value] of Object.entries(updates)) {
    if (key in config.SETTING_DEFAULTS) config.setSetting(key, value);
  }
  res.json({ ok: true, settings: config.allSettings() });
}));

// ---------- System prompt / versions / presets ----------
const PRESETS = {
  Professional: 'You are my professional secretary replying on my behalf in Telegram DMs. Courteous, precise, businesslike. Keep replies short and useful. Match the sender\'s language. Never reveal you are an AI.',
  Casual: 'You are replying as me to friends on Telegram. Relaxed, warm, natural texting style — lowercase is fine, light emoji use. Match the sender\'s language and energy. Never reveal you are an AI.',
  Flirty: 'You are replying as me on Telegram. Playful, charming, a little teasing but always respectful. Keep it light and fun. Match the sender\'s language. Never reveal you are an AI.',
  Minimal: 'Reply as me on Telegram. Extremely brief — a few words when possible. No fluff, no emoji. Match the sender\'s language. Never reveal you are an AI.',
};

router.get('/prompts/presets', wrap((req, res) => res.json(PRESETS)));

router.get('/prompts/versions', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM prompt_versions ORDER BY id DESC LIMIT 50').all());
}));

router.post('/prompts/versions', wrap((req, res) => {
  const { name, content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  db.prepare('INSERT INTO prompt_versions (name, content) VALUES (?, ?)').run(name || 'unnamed', content);
  res.json({ ok: true });
}));

router.post('/prompts/versions/:id/rollback', wrap((req, res) => {
  const v = db.prepare('SELECT * FROM prompt_versions WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'version not found' });
  // Snapshot current before rollback so nothing is lost.
  db.prepare('INSERT INTO prompt_versions (name, content) VALUES (?, ?)')
    .run('auto-backup before rollback', config.getSetting('system_prompt'));
  config.setSetting('system_prompt', v.content);
  config.setSetting('active_preset', 'Custom');
  res.json({ ok: true, content: v.content });
}));

router.delete('/prompts/versions/:id', wrap((req, res) => {
  db.prepare('DELETE FROM prompt_versions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// Preview the fully-built prompt for a contact (template vars resolved).
router.get('/prompts/preview', wrap((req, res) => {
  const contact = req.query.chat_id
    ? db.prepare('SELECT * FROM contacts WHERE chat_id = ?').get(req.query.chat_id)
    : null;
  res.json({ prompt: buildSystemPrompt(contact, null) });
}));

// Test chat against the current prompt + gateway.
router.post('/chat/test', wrap(async (req, res) => {
  const { message, chat_id } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const contact = chat_id ? db.prepare('SELECT * FROM contacts WHERE chat_id = ?').get(chat_id) : null;
  const result = await chat([
    { role: 'system', content: buildSystemPrompt(contact, null) },
    { role: 'user', content: message },
  ], { maxTokens: 512 });
  res.json({ reply: result.text, provider: result.provider, model: result.model, latencyMs: result.latencyMs, cost: result.cost });
}));

// ---------- Providers / gateway ----------
router.get('/providers', wrap((req, res) => {
  const health = Object.fromEntries(
    db.prepare('SELECT * FROM provider_health').all().map(h => [h.provider, h])
  );
  const out = Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    free: Boolean(p.free),
    configured: isConfigured(id),
    models: Object.keys(p.models),
    health: health[id] || null,
  }));
  res.json({
    providers: out,
    primary: { provider: config.getSetting('primary_provider'), model: config.getSetting('primary_model') },
    fallback_chain: config.getJSON('fallback_chain', []),
    load_balancing: config.getSetting('load_balancing'),
    active_chain: candidates(),
  });
}));

router.post('/providers/test', wrap(async (req, res) => {
  const { provider, model } = req.body;
  if (!provider || !model) return res.status(400).json({ error: 'provider and model required' });
  const start = Date.now();
  try {
    const result = await chatOnce(provider, model, [
      { role: 'user', content: 'Reply with the single word: ok' },
    ], { maxTokens: 10, temperature: 0 });
    res.json({ ok: true, reply: result.text.trim(), latencyMs: Date.now() - start });
  } catch (err) {
    res.json({ ok: false, error: err.message, latencyMs: Date.now() - start });
  }
}));

// ---------- Contacts ----------
const CONTACT_FIELDS = ['username', 'name', 'relationship', 'tone', 'gender', 'rules', 'auto_reply',
  'delay_multiplier', 'max_length', 'blocked_topics', 'priority', 'learned_tone', 'custom_prompt', 'notes',
  'voice_replies'];

router.get('/contacts', wrap((req, res) => {
  const q = req.query.q;
  const rows = q
    ? db.prepare('SELECT * FROM contacts WHERE name LIKE ? OR username LIKE ? OR chat_id LIKE ? ORDER BY priority DESC, updated_at DESC')
        .all(`%${q}%`, `%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM contacts ORDER BY priority DESC, updated_at DESC').all();
  res.json(rows);
}));

router.post('/contacts', wrap((req, res) => {
  const b = req.body;
  if (!b.chat_id) return res.status(400).json({ error: 'chat_id required' });
  const cols = ['chat_id', ...CONTACT_FIELDS.filter(f => b[f] !== undefined)];
  const vals = cols.map(c => b[c]);
  db.prepare(`INSERT INTO contacts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  res.json({ ok: true });
}));

router.put('/contacts/:chatId', wrap((req, res) => {
  const b = req.body;
  const sets = CONTACT_FIELDS.filter(f => b[f] !== undefined);
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  const sql = `UPDATE contacts SET ${sets.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE chat_id = ?`;
  db.prepare(sql).run(...sets.map(f => b[f]), req.params.chatId);
  res.json({ ok: true });
}));

router.delete('/contacts/:chatId', wrap((req, res) => {
  db.prepare('DELETE FROM contacts WHERE chat_id = ?').run(req.params.chatId);
  res.json({ ok: true });
}));

// Import contacts from a Telegram export (result.json shape or simple array).
router.post('/contacts/import', wrap((req, res) => {
  const body = req.body || {};
  let items = [];
  if (Array.isArray(body)) items = body;
  else if (Array.isArray(body.contacts?.list)) {
    items = body.contacts.list.map(c => ({
      chat_id: c.user_id || c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' '), username: c.username,
    }));
  } else if (Array.isArray(body.chats?.list)) {
    items = body.chats.list.filter(c => c.type === 'personal_chat').map(c => ({ chat_id: c.id, name: c.name }));
  }
  let imported = 0;
  const insert = db.prepare('INSERT OR IGNORE INTO contacts (chat_id, name, username) VALUES (?, ?, ?)');
  for (const it of items) {
    if (it.chat_id) { insert.run(it.chat_id, it.name || null, it.username || null); imported++; }
  }
  res.json({ ok: true, imported });
}));

// Relationship learning: paste a real chat transcript, store as style examples.
router.post('/contacts/:chatId/learn', wrap(async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'transcript required' });
  const result = await chat([
    {
      role: 'system',
      content: 'Analyze this real chat transcript. Extract: (1) a one-line description of how "me" talks to this person (tone, formality, emoji use, typical message length), and (2) 5-8 representative example exchanges verbatim. Output plain text, starting with "Style:" then "Examples:".',
    },
    { role: 'user', content: transcript.slice(0, 20000) },
  ], { maxTokens: 900, temperature: 0.2 });
  db.prepare("UPDATE contacts SET learned_tone = ?, updated_at = datetime('now') WHERE chat_id = ?")
    .run(result.text, req.params.chatId);
  res.json({ ok: true, learned_tone: result.text });
}));

// Conversation history per contact.
router.get('/contacts/:chatId/history', wrap((req, res) => {
  res.json(conversations.getHistory(Number(req.params.chatId), 200));
}));
router.delete('/contacts/:chatId/history', wrap((req, res) => {
  conversations.clearHistory(Number(req.params.chatId));
  res.json({ ok: true });
}));

// ---------- Facts ----------
router.get('/facts', wrap((req, res) => res.json(facts.list(req.query.q))));
router.post('/facts', wrap((req, res) => {
  const { key, value, priority } = req.body;
  if (!key || !value) return res.status(400).json({ error: 'key and value required' });
  facts.upsert(key, value, priority || 'casual');
  res.json({ ok: true });
}));
router.delete('/facts/:id', wrap((req, res) => { facts.remove(req.params.id); res.json({ ok: true }); }));

// ---------- Memories ----------
router.get('/memories', wrap((req, res) => {
  res.json(vector.list(req.query.chat_id ? Number(req.query.chat_id) : null, req.query.q));
}));
router.post('/memories', wrap(async (req, res) => {
  const { chat_id, content, priority } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  await vector.remember(Number(chat_id) || 0, content, priority || 'casual');
  res.json({ ok: true });
}));
router.delete('/memories/:id', wrap((req, res) => { vector.forget(req.params.id); res.json({ ok: true }); }));

router.get('/memory/export', wrap((req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename=memory-export.json');
  res.json(vector.exportAll());
}));
router.post('/memory/import', wrap(async (req, res) => {
  const count = await vector.importAll(req.body || {});
  res.json({ ok: true, imported: count });
}));

// ---------- Tools ----------
router.get('/tools', wrap((req, res) => {
  res.json(Object.entries(TOOLS).map(([name, t]) => ({
    name, description: t.description, args: t.args, enabled: t.enabled(),
  })));
}));
router.post('/tools/:name/test', wrap(async (req, res) => {
  const tool = TOOLS[req.params.name];
  if (!tool) return res.status(404).json({ error: 'unknown tool' });
  try {
    const output = await tool.run(req.body || {});
    if (output && typeof output === 'object') {
      res.json({ ok: true, output: output.text || '', photoUrl: output.photoUrl || null });
    } else {
      res.json({ ok: true, output: String(output) });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}));

// ---------- Scheduled messages ----------
router.get('/scheduled', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM scheduled_messages ORDER BY send_at DESC LIMIT 100').all());
}));
router.post('/scheduled', wrap((req, res) => {
  const { chat_id, content, send_at } = req.body;
  if (!chat_id || !content || !send_at) return res.status(400).json({ error: 'chat_id, content, send_at required' });
  db.prepare('INSERT INTO scheduled_messages (chat_id, content, send_at) VALUES (?, ?, ?)')
    .run(chat_id, content, send_at.replace('T', ' ').slice(0, 19));
  res.json({ ok: true });
}));
router.delete('/scheduled/:id', wrap((req, res) => {
  db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- Logs ----------
router.get('/logs/messages', wrap((req, res) => {
  const { q, chat_id, status, limit } = req.query;
  const where = []; const params = [];
  if (q) { where.push('content LIKE ?'); params.push(`%${q}%`); }
  if (chat_id) { where.push('chat_id = ?'); params.push(chat_id); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = `
    SELECT m.*, COALESCE(c.name, c.username) contact_name
    FROM messages_log m LEFT JOIN contacts c ON c.chat_id = m.chat_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY m.id DESC LIMIT ?`;
  params.push(Math.min(Number(limit) || 100, 500));
  res.json(db.prepare(sql).all(...params));
}));

router.get('/logs/messages.csv', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT m.created_at, m.chat_id, COALESCE(c.name, c.username, '') contact, m.direction,
           m.content, m.model, m.tokens_used, m.response_time_ms, m.status, m.error
    FROM messages_log m LEFT JOIN contacts c ON c.chat_id = m.chat_id
    ORDER BY m.id DESC LIMIT 10000`).all();
  const escCsv = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = 'created_at,chat_id,contact,direction,content,model,tokens_used,response_time_ms,status,error';
  const body = rows.map(r => [r.created_at, r.chat_id, r.contact, r.direction, r.content,
    r.model, r.tokens_used, r.response_time_ms, r.status, r.error].map(escCsv).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=messages-log.csv');
  res.send(header + '\n' + body);
}));

router.get('/logs/errors', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM error_log ORDER BY id DESC LIMIT 100').all());
}));

router.get('/logs/events', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM events_log ORDER BY id DESC LIMIT 100').all());
}));

router.get('/logs/tokens', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM token_usage ORDER BY id DESC LIMIT 100').all());
}));

// ---------- API key management ----------
function maskKey(v) {
  if (!v) return '';
  return v.length <= 8 ? '••••' : v.slice(0, 4) + '••••' + v.slice(-4);
}

router.get('/keys', wrap((req, res) => {
  res.json(config.KEY_NAMES.map(name => {
    const dbRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('apikey_' + name);
    const envVal = config.env[name] || '';
    return {
      name,
      source: dbRow && dbRow.value ? 'panel' : envVal ? 'env' : 'none',
      masked: maskKey((dbRow && dbRow.value) || envVal),
    };
  }));
}));

router.put('/keys/:name', wrap((req, res) => {
  config.setKey(req.params.name, req.body.value || '');
  res.json({ ok: true });
}));

router.delete('/keys/:name', wrap((req, res) => {
  config.setKey(req.params.name, '');
  res.json({ ok: true });
}));

// ---------- Manual send (message / voice / photo / sticker / file / poll) ----------
router.post('/send', wrap(async (req, res) => {
  const { getBot, getBusinessConnectionId, logMsg } = require('../bot/handlers');
  const bot = getBot();
  if (!bot) return res.status(400).json({ error: 'Bot is not running (TELEGRAM_BOT_TOKEN not set)' });
  const { chat_id, type = 'message', content } = req.body;
  const chatId = Number(chat_id);
  if (!chatId || !content) return res.status(400).json({ error: 'chat_id and content required' });
  const isOwner = chatId === config.env.OWNER_USER_ID;
  const opts = isOwner ? {} : { business_connection_id: getBusinessConnectionId() };
  if (!isOwner && !opts.business_connection_id) {
    return res.status(400).json({ error: 'No business connection yet — connect the bot in Telegram Business settings' });
  }

  if (type === 'message') {
    await bot.api.sendMessage(chatId, content, opts);
    logMsg(chatId, 'outgoing', content, { model: 'manual-panel' });
  } else if (type === 'voice') {
    const tts = require('../tools/tts');
    if (!tts.available()) return res.status(400).json({ error: 'No TTS provider configured' });
    const { InputFile } = require('grammy');
    const { buffer } = await tts.speak(content);
    await bot.api.sendVoice(chatId, new InputFile(buffer, 'voice.ogg'), opts);
    logMsg(chatId, 'outgoing', `[voice] ${content}`, { model: 'manual-panel' });
  } else if (type === 'photo') {
    await bot.api.sendPhoto(chatId, content, opts); // content = image URL
    logMsg(chatId, 'outgoing', `[photo] ${content}`, { model: 'manual-panel' });
  } else if (type === 'sticker') {
    await bot.api.sendSticker(chatId, content, opts); // content = sticker file_id
    logMsg(chatId, 'outgoing', '[sticker]', { model: 'manual-panel' });
  } else if (type === 'document') {
    await bot.api.sendDocument(chatId, content, opts); // content = file URL
    logMsg(chatId, 'outgoing', `[file] ${content}`, { model: 'manual-panel' });
  } else if (type === 'poll') {
    let poll;
    try { poll = JSON.parse(content); } catch { return res.status(400).json({ error: 'Poll content must be JSON: {"question":"...","options":["a","b"]}' }); }
    if (!poll.question || !Array.isArray(poll.options) || poll.options.length < 2) {
      return res.status(400).json({ error: 'Poll needs a question and at least 2 options' });
    }
    await bot.api.sendPoll(chatId, poll.question, poll.options.map(o => ({ text: String(o) })), opts);
    logMsg(chatId, 'outgoing', `[poll] ${poll.question}`, { model: 'manual-panel' });
  } else {
    return res.status(400).json({ error: `Unknown send type: ${type}` });
  }
  res.json({ ok: true });
}));

// ---------- Backup / restore ----------
router.get('/backup', wrap((req, res) => {
  const dump = {};
  for (const t of ['settings', 'contacts', 'facts', 'memories', 'prompt_versions', 'scheduled_messages']) {
    dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  }
  dump.exported_at = new Date().toISOString();
  res.setHeader('Content-Disposition', 'attachment; filename=secretary-backup.json');
  res.json(dump);
}));

router.post('/restore', wrap((req, res) => {
  const dump = req.body || {};
  const counts = {};
  const tx = db.transaction(() => {
    for (const s of dump.settings || []) config.setSetting(s.key, s.value);
    counts.settings = (dump.settings || []).length;
    if (Array.isArray(dump.contacts)) {
      const ins = db.prepare(`INSERT OR REPLACE INTO contacts (chat_id, ${CONTACT_FIELDS.join(',')})
        VALUES (?, ${CONTACT_FIELDS.map(() => '?').join(',')})`);
      for (const c of dump.contacts) ins.run(c.chat_id, ...CONTACT_FIELDS.map(f => c[f] ?? null));
      counts.contacts = dump.contacts.length;
    }
    if (Array.isArray(dump.facts)) {
      for (const f of dump.facts) if (f.key) facts.upsert(f.key, f.value, f.priority || 'casual');
      counts.facts = dump.facts.length;
    }
    if (Array.isArray(dump.memories)) {
      const ins = db.prepare('INSERT INTO memories (chat_id, content, priority, embedding) VALUES (?, ?, ?, ?)');
      for (const m of dump.memories) if (m.content) ins.run(m.chat_id || 0, m.content, m.priority || 'casual', m.embedding || null);
      counts.memories = dump.memories.length;
    }
    if (Array.isArray(dump.prompt_versions)) {
      const ins = db.prepare('INSERT INTO prompt_versions (name, content) VALUES (?, ?)');
      for (const v of dump.prompt_versions) if (v.content) ins.run(v.name || 'restored', v.content);
      counts.prompt_versions = dump.prompt_versions.length;
    }
  });
  tx();
  res.json({ ok: true, restored: counts });
}));

module.exports = router;
