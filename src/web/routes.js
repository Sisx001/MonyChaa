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

// ---------- Auto-responder rules ----------
const autoresponders = require('../autoresponders');
router.get('/autoresponders', wrap((req, res) => res.json(autoresponders.list())));
router.post('/autoresponders', wrap((req, res) => { autoresponders.upsert(req.body || {}); res.json({ ok: true }); }));
router.put('/autoresponders/:id/toggle', wrap((req, res) => { autoresponders.setEnabled(req.params.id, Number(req.body.enabled)); res.json({ ok: true }); }));
router.delete('/autoresponders/:id', wrap((req, res) => { autoresponders.remove(req.params.id); res.json({ ok: true }); }));

// ---------- Notes ----------
router.get('/notes', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC').all());
}));
router.post('/notes', wrap((req, res) => {
  const { id, title, body, pinned } = req.body || {};
  if (id) db.prepare("UPDATE notes SET title = ?, body = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?").run(title || '', body || '', pinned ? 1 : 0, id);
  else db.prepare('INSERT INTO notes (title, body, pinned) VALUES (?, ?, ?)').run(title || 'Note', body || '', pinned ? 1 : 0);
  res.json({ ok: true });
}));
router.delete('/notes/:id', wrap((req, res) => { db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id); res.json({ ok: true }); }));

// ---------- Broadcast (message multiple contacts) ----------
router.post('/broadcast', wrap(async (req, res) => {
  const { getBot, getBusinessConnectionId, logMsg } = require('../bot/handlers');
  const bot = getBot();
  if (!bot) return res.status(400).json({ error: 'bot not running' });
  const { message, filter, tag } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  const connId = getBusinessConnectionId();
  // Only contacts we've messaged within the 24h business window are reachable.
  let contacts = db.prepare(`
    SELECT DISTINCT c.chat_id, c.tags FROM contacts c
    WHERE c.assistant_id = 0 AND c.auto_reply = 1
      AND EXISTS (SELECT 1 FROM messages_log m WHERE m.chat_id = c.chat_id AND m.direction = 'incoming' AND m.created_at > datetime('now','-24 hours'))
      ${filter === 'vip' ? 'AND c.priority > 0' : ''}
  `).all();
  if (tag) {
    const t = tag.toLowerCase();
    contacts = contacts.filter(c => String(c.tags || '').toLowerCase().split(',').map(s => s.trim()).includes(t));
  }
  let sent = 0, failed = 0;
  for (const c of contacts) {
    try {
      await bot.api.sendMessage(c.chat_id, message, { business_connection_id: connId });
      logMsg(c.chat_id, 'outgoing', message, { model: 'broadcast' });
      sent++;
      await new Promise(r => setTimeout(r, 120)); // gentle pacing to avoid flood limits
    } catch { failed++; }
  }
  auth.audit(req, 'broadcast', `sent ${sent}, failed ${failed}`, req.user);
  res.json({ ok: true, sent, failed, eligible: contacts.length });
}));

// ---------- Prompt snippets (reusable prompt building blocks) ----------
router.get('/snippets', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM snippets ORDER BY id DESC').all());
}));
router.post('/snippets', wrap((req, res) => {
  const { title, content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  db.prepare('INSERT INTO snippets (title, content) VALUES (?, ?)').run(title || 'Snippet', content);
  res.json({ ok: true });
}));
router.delete('/snippets/:id', wrap((req, res) => {
  db.prepare('DELETE FROM snippets WHERE id = ?').run(req.params.id);
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

// Multi-turn playground chat (ChatGPT-style panel chat).
router.post('/chat/playground', wrap(async (req, res) => {
  const { messages, provider, model, temperature, max_tokens, top_p, use_persona, system } = req.body;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });
  const msgs = [];
  if (use_persona) msgs.push({ role: 'system', content: buildSystemPrompt(null, null) });
  else if (system) msgs.push({ role: 'system', content: String(system).slice(0, 8000) });
  msgs.push(...messages
    .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-40)
    .map(m => ({ role: m.role, content: m.content.slice(0, 16000) })));
  const opts = {
    temperature: temperature !== undefined ? Number(temperature) : undefined,
    topP: top_p !== undefined ? Number(top_p) : undefined,
    maxTokens: Math.min(4096, Number(max_tokens) || 1024),
  };
  const result = provider && model
    ? await chatOnce(provider, model, msgs, opts)
    : await chat(msgs, opts);
  res.json({
    reply: result.text, provider: result.provider, model: result.model,
    tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    cost: result.cost, latencyMs: result.latencyMs,
  });
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
  'voice_replies', 'tags'];

router.get('/contacts', wrap((req, res) => {
  const q = req.query.q;
  const tag = req.query.tag;
  const aid = Number(req.query.assistant_id) || 0;
  let rows = q
    ? db.prepare('SELECT * FROM contacts WHERE assistant_id = ? AND (name LIKE ? OR username LIKE ? OR chat_id LIKE ?) ORDER BY priority DESC, updated_at DESC')
        .all(aid, `%${q}%`, `%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM contacts WHERE assistant_id = ? ORDER BY priority DESC, updated_at DESC').all(aid);
  if (tag) {
    const t = tag.toLowerCase();
    rows = rows.filter(c => String(c.tags || '').toLowerCase().split(',').map(s => s.trim()).includes(t));
  }
  res.json(rows);
}));

// Distinct tags across contacts, with counts.
router.get('/contacts/tags', wrap((req, res) => {
  const aid = Number(req.query.assistant_id) || 0;
  const counts = {};
  for (const row of db.prepare('SELECT tags FROM contacts WHERE assistant_id = ?').all(aid)) {
    for (const t of String(row.tags || '').split(',').map(s => s.trim()).filter(Boolean)) {
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  res.json(Object.entries(counts).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count));
}));

router.post('/contacts', wrap((req, res) => {
  const b = req.body;
  if (!b.chat_id) return res.status(400).json({ error: 'chat_id required' });
  const aid = Number(b.assistant_id) || 0;
  const cols = ['chat_id', 'assistant_id', ...CONTACT_FIELDS.filter(f => b[f] !== undefined)];
  const vals = cols.map(c => (c === 'assistant_id' ? aid : b[c]));
  db.prepare(`INSERT INTO contacts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  res.json({ ok: true });
}));

router.put('/contacts/:chatId', wrap((req, res) => {
  const b = req.body;
  const aid = Number(b.assistant_id) || 0;
  const sets = CONTACT_FIELDS.filter(f => b[f] !== undefined);
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  const sql = `UPDATE contacts SET ${sets.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE chat_id = ? AND assistant_id = ?`;
  db.prepare(sql).run(...sets.map(f => b[f]), req.params.chatId, aid);
  res.json({ ok: true });
}));

router.delete('/contacts/:chatId', wrap((req, res) => {
  const aid = Number(req.query.assistant_id) || 0;
  db.prepare('DELETE FROM contacts WHERE chat_id = ? AND assistant_id = ?').run(req.params.chatId, aid);
  res.json({ ok: true });
}));

// Export contacts as CSV.
router.get('/contacts.csv', wrap((req, res) => {
  const aid = Number(req.query.assistant_id) || 0;
  const rows = db.prepare('SELECT chat_id, name, username, relationship, tone, priority, auto_reply, tags, notes FROM contacts WHERE assistant_id = ? ORDER BY priority DESC, name').all(aid);
  const escCsv = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = 'chat_id,name,username,relationship,tone,priority,auto_reply,tags,notes';
  const body = rows.map(r => [r.chat_id, r.name, r.username, r.relationship, r.tone, r.priority, r.auto_reply, r.tags, r.notes].map(escCsv).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=contacts.csv');
  res.send(header + '\n' + body);
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
  res.json(conversations.getHistory(Number(req.params.chatId), 200, Number(req.query.assistant_id) || 0));
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
  const builtin = Object.entries(TOOLS).map(([name, t]) => ({
    name, description: t.description, args: t.args, enabled: t.enabled(),
  }));
  const mcpTools = require('../mcp').allTools().map(t => ({
    name: t.qualified, description: t.description, args: t.args, enabled: true, mcp: true,
  }));
  res.json([...builtin, ...mcpTools]);
}));
router.post('/tools/:name/test', wrap(async (req, res) => {
  if (req.params.name.startsWith('mcp:')) {
    try {
      const output = await require('../mcp').callQualified(req.params.name, req.body || {});
      return res.json({ ok: true, output: output.slice(0, 4000) });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  }
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
  const { q, chat_id, status, assistant_id, limit } = req.query;
  const where = []; const params = [];
  if (q) { where.push('m.content LIKE ?'); params.push(`%${q}%`); }
  if (chat_id) { where.push('m.chat_id = ?'); params.push(chat_id); }
  if (status) { where.push('m.status = ?'); params.push(status); }
  if (assistant_id !== undefined && assistant_id !== '') { where.push('m.assistant_id = ?'); params.push(Number(assistant_id)); }
  // Join on both keys so the composite-key contacts table doesn't duplicate rows.
  const sql = `
    SELECT m.*, COALESCE(c.name, c.username) contact_name
    FROM messages_log m LEFT JOIN contacts c ON c.chat_id = m.chat_id AND c.assistant_id = m.assistant_id
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

// ---------- Assistants (multi-tenancy) ----------
const assistants = require('../assistants');
const auth = require('./auth');

router.get('/assistants', wrap((req, res) => res.json(assistants.list())));
router.post('/assistants', wrap(async (req, res) => {
  const { name, bot_token, owner_user_id, system_prompt, settings_json } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (settings_json) { try { JSON.parse(settings_json); } catch { return res.status(400).json({ error: 'settings_json must be valid JSON' }); } }
  const id = assistants.create({
    name, bot_token: bot_token || null,
    owner_user_id: owner_user_id ? Number(owner_user_id) : null,
    admin_user_id: req.user?.id || null, system_prompt: system_prompt || null,
  });
  if (settings_json) assistants.update(id, { settings_json });
  if (bot_token) { try { await assistants.start(id); } catch { /* reported via status */ } }
  auth.audit(req, 'create_assistant', name, req.user);
  res.json({ ok: true, id });
}));
router.put('/assistants/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if (b.settings_json) { try { JSON.parse(b.settings_json); } catch { return res.status(400).json({ error: 'settings_json must be valid JSON' }); } }
  const fields = {};
  for (const f of ['name', 'bot_token', 'owner_user_id', 'system_prompt', 'settings_json', 'enabled']) {
    if (b[f] !== undefined) fields[f] = f === 'owner_user_id' && b[f] ? Number(b[f]) : b[f];
  }
  assistants.update(id, fields);
  // Restart to apply token/prompt/settings changes if it has a token.
  const row = db.prepare('SELECT bot_token, enabled FROM assistants WHERE id = ?').get(id);
  if (row?.bot_token) {
    try { await assistants.stop(id); if (row.enabled) await assistants.start(id); } catch { /* status reflects it */ }
  }
  auth.audit(req, 'update_assistant', String(id), req.user);
  res.json({ ok: true });
}));
router.post('/assistants/:id/start', wrap(async (req, res) => {
  try { await assistants.start(Number(req.params.id)); res.json({ ok: true }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
}));
router.post('/assistants/:id/stop', wrap(async (req, res) => {
  await assistants.stop(Number(req.params.id)); res.json({ ok: true });
}));
router.delete('/assistants/:id', wrap(async (req, res) => {
  if (req.query.purge === '1') assistants.purgeData(Number(req.params.id));
  await assistants.remove(Number(req.params.id));
  auth.audit(req, 'delete_assistant', req.params.id, req.user);
  res.json({ ok: true });
}));

// ---------- Live model catalog ----------
const models = require('../llm/models');
router.get('/models', wrap(async (req, res) => res.json(await models.listAll())));
router.get('/models/:provider', wrap(async (req, res) => {
  try { res.json(await models.listModels(req.params.provider)); }
  catch (err) { res.status(500).json({ error: err.message }); }
}));

// ---------- System monitoring ----------
const systemMon = require('../system');

router.get('/system', wrap((req, res) => {
  res.json({ metrics: systemMon.metrics(), diagnostics: systemMon.diagnostics() });
}));
router.post('/system/autofix', wrap((req, res) => {
  const msg = systemMon.autofix(req.body.action || 'fix_all');
  auth.audit(req, 'autofix', req.body.action, req.user);
  res.json({ ok: true, message: msg });
}));
router.post('/system/restart', wrap((req, res) => {
  if (req.user && req.user.role === 'viewer') return res.status(403).json({ error: 'read-only' });
  auth.audit(req, 'restart', null, req.user);
  res.json({ ok: true, message: systemMon.restart('panel') });
}));

// ---------- Characters ----------
const characters = require('../characters');
router.get('/characters', wrap((req, res) => res.json(characters.list())));
router.post('/characters/apply', wrap((req, res) => {
  const c = characters.apply(req.body.id);
  auth.audit(req, 'apply_character', c.name, req.user);
  res.json({ ok: true, character: c.name, prompt: c.prompt });
}));

// ---------- Admin users ----------
router.get('/users', wrap((req, res) => {
  if (req.user && req.user.role === 'viewer') return res.status(403).json({ error: 'read-only' });
  res.json(db.prepare('SELECT id, username, role, enabled, created_at, last_login, last_ip FROM admin_users ORDER BY id').all());
}));
router.post('/users', wrap((req, res) => {
  if (req.user && !['owner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  if (!/^[\w.-]{3,32}$/.test(username)) return res.status(400).json({ error: 'invalid username' });
  try {
    db.prepare('INSERT INTO admin_users (username, pass_hash, role) VALUES (?, ?, ?)')
      .run(username, auth.hashPassword(password), ['owner', 'admin', 'viewer'].includes(role) ? role : 'admin');
  } catch { return res.status(409).json({ error: 'username already exists' }); }
  auth.audit(req, 'create_user', username, req.user);
  res.json({ ok: true });
}));
router.put('/users/:id', wrap((req, res) => {
  if (req.user && !['owner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
  const { password, role, enabled } = req.body;
  const target = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not found' });
  if (password) db.prepare('UPDATE admin_users SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(password), target.id);
  if (role && ['owner', 'admin', 'viewer'].includes(role)) db.prepare('UPDATE admin_users SET role = ? WHERE id = ?').run(role, target.id);
  if (enabled !== undefined) db.prepare('UPDATE admin_users SET enabled = ? WHERE id = ?').run(Number(enabled), target.id);
  auth.audit(req, 'update_user', target.username, req.user);
  res.json({ ok: true });
}));
router.delete('/users/:id', wrap((req, res) => {
  if (req.user && req.user.role !== 'owner') return res.status(403).json({ error: 'only the owner can delete accounts' });
  const total = db.prepare('SELECT COUNT(*) c FROM admin_users').get().c;
  if (total <= 1) return res.status(400).json({ error: 'cannot delete the last account' });
  const target = db.prepare('SELECT username FROM admin_users WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM admin_users WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  auth.audit(req, 'delete_user', target?.username, req.user);
  res.json({ ok: true });
}));

// ---------- Two-factor auth (TOTP) ----------
const totp = require('./totp');

// Begin setup: returns a fresh secret + otpauth URL (not yet enabled).
router.post('/2fa/setup', wrap((req, res) => {
  if (!req.user) return res.status(400).json({ error: '2FA needs an account (set ADMIN_PASSWORD)' });
  const secret = totp.generateSecret();
  // Stash the pending secret on the session row until confirmed.
  db.prepare('UPDATE admin_users SET totp_secret = ? WHERE id = ? AND totp_secret IS NULL').run('pending:' + secret, req.user.id);
  res.json({ secret, otpauth: totp.otpauthUrl(secret, req.user.username) });
}));

// Confirm setup with a valid code → activates 2FA.
router.post('/2fa/enable', wrap((req, res) => {
  if (!req.user) return res.status(400).json({ error: 'no account' });
  const row = db.prepare('SELECT totp_secret FROM admin_users WHERE id = ?').get(req.user.id);
  const pending = row?.totp_secret?.startsWith('pending:') ? row.totp_secret.slice(8) : null;
  if (!pending) return res.status(400).json({ error: 'start setup first' });
  if (!totp.verify(pending, req.body?.totp)) return res.status(400).json({ error: 'code did not match — try again' });
  db.prepare('UPDATE admin_users SET totp_secret = ? WHERE id = ?').run(pending, req.user.id);
  auth.audit(req, '2fa_enable', req.user.username, req.user);
  res.json({ ok: true });
}));

router.post('/2fa/disable', wrap((req, res) => {
  if (!req.user) return res.status(400).json({ error: 'no account' });
  const row = db.prepare('SELECT pass_hash FROM admin_users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(req.body?.password || '', row.pass_hash)) return res.status(401).json({ error: 'password required to disable 2FA' });
  db.prepare('UPDATE admin_users SET totp_secret = NULL WHERE id = ?').run(req.user.id);
  auth.audit(req, '2fa_disable', req.user.username, req.user);
  res.json({ ok: true });
}));

router.get('/2fa/status', wrap((req, res) => {
  if (!req.user) return res.json({ enabled: false, available: false });
  const row = db.prepare('SELECT totp_secret FROM admin_users WHERE id = ?').get(req.user.id);
  res.json({ available: true, enabled: Boolean(row?.totp_secret) && !row.totp_secret.startsWith('pending:') });
}));

// ---------- Security: login attempts, sessions, IP bans, audit ----------
const geoip = require('./geoip');

async function withGeo(rows) {
  const uniqueIps = [...new Set(rows.map(r => r.ip).filter(Boolean))];
  const geo = {};
  await Promise.all(uniqueIps.map(async ip => { geo[ip] = await geoip.lookup(ip); }));
  return rows.map(r => {
    const g = geo[r.ip] || { code: '', country: '' };
    return { ...r, country: g.country, countryCode: g.code, flag: geoip.flag(g.code) };
  });
}

router.get('/security/attempts', wrap(async (req, res) => {
  res.json(await withGeo(db.prepare('SELECT * FROM login_attempts ORDER BY id DESC LIMIT 100').all()));
}));
router.get('/security/sessions', wrap(async (req, res) => {
  const rows = db.prepare(`SELECT s.token, u.username, s.ip, s.user_agent, s.created_at, s.last_seen, s.expires_at
    FROM sessions s JOIN admin_users u ON u.id = s.user_id WHERE s.expires_at > datetime('now') ORDER BY s.last_seen DESC`).all()
    .map(s => ({ ...s, current: req.user && s.token.startsWith(req.user.token?.slice(0, 8) || '\0'), token: s.token.slice(0, 8) + '…' }));
  res.json(await withGeo(rows));
}));
router.get('/security/audit', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 150').all());
}));
router.get('/security/bans', wrap(async (req, res) => {
  res.json(await withGeo(db.prepare('SELECT * FROM banned_ips ORDER BY created_at DESC').all()));
}));
router.post('/security/bans', wrap((req, res) => {
  const ip = String(req.body.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'ip required' });
  db.prepare('INSERT OR REPLACE INTO banned_ips (ip, reason) VALUES (?, ?)').run(ip, req.body.reason || 'manual');
  db.prepare('DELETE FROM sessions WHERE ip = ?').run(ip); // kick active sessions from that IP
  auth.audit(req, 'ban_ip', ip, req.user);
  res.json({ ok: true });
}));
router.delete('/security/bans/:ip', wrap((req, res) => {
  db.prepare('DELETE FROM banned_ips WHERE ip = ?').run(req.params.ip);
  auth.audit(req, 'unban_ip', req.params.ip, req.user);
  res.json({ ok: true });
}));

// ---------- Skills ----------
const skills = require('../skills');

router.get('/skills', wrap((req, res) => res.json(skills.list())));
router.post('/skills', wrap((req, res) => {
  const { name, description, triggers, content, enabled } = req.body;
  skills.upsert({
    name, description: description || '',
    triggers: Array.isArray(triggers) ? triggers : String(triggers || '').split(',').map(s => s.trim()).filter(Boolean),
    content, enabled: enabled === undefined ? 1 : Number(enabled),
  });
  res.json({ ok: true });
}));
router.put('/skills/:id/toggle', wrap((req, res) => {
  skills.setEnabled(req.params.id, Number(req.body.enabled));
  res.json({ ok: true });
}));
router.delete('/skills/:id', wrap((req, res) => { skills.remove(req.params.id); res.json({ ok: true }); }));

router.get('/skills/catalog', wrap((req, res) => {
  const installed = new Set(skills.list().map(s => s.name));
  res.json(skills.CATALOG.map(c => ({ ...c, installed: installed.has(c.name) })));
}));
router.post('/skills/catalog/install', wrap((req, res) => {
  const item = skills.installFromCatalog(req.body.name);
  res.json({ ok: true, installed: item.name });
}));
router.post('/skills/learn', wrap(async (req, res) => {
  const created = await skills.learnFromConversations();
  res.json({ ok: true, created });
}));

// GitHub skill library: search + one-click install.
router.get('/library/github', wrap(async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'q required' });
  res.json(await skills.githubSearch(req.query.q));
}));
router.post('/library/github/install', wrap(async (req, res) => {
  if (!req.body.repo) return res.status(400).json({ error: 'repo required' });
  res.json({ ok: true, ...(await skills.githubInstall(req.body.repo)) });
}));

// ---------- MCP servers ----------
const mcp = require('../mcp');

router.get('/mcp', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM mcp_servers ORDER BY id').all().map(s => ({
    ...s, tools: JSON.parse(s.tools_json || '[]'), headers: undefined, has_headers: s.headers !== '{}',
  })));
}));
router.post('/mcp', wrap((req, res) => {
  const { name, url, headers } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  if (!/^[\w-]+$/.test(name)) return res.status(400).json({ error: 'name must be alphanumeric/dashes (used as tool prefix)' });
  if (headers) JSON.parse(headers); // validate
  db.prepare('INSERT INTO mcp_servers (name, url, headers) VALUES (?, ?, ?)')
    .run(name, url, headers || '{}');
  res.json({ ok: true });
}));
router.put('/mcp/:id/toggle', wrap((req, res) => {
  db.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(Number(req.body.enabled), req.params.id);
  res.json({ ok: true });
}));
router.delete('/mcp/:id', wrap((req, res) => {
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));
router.post('/mcp/:id/connect', wrap(async (req, res) => {
  try {
    const tools = await mcp.connect(Number(req.params.id));
    res.json({ ok: true, tools: tools.length });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}));
router.post('/mcp/:id/call', wrap(async (req, res) => {
  try {
    const output = await mcp.callTool(Number(req.params.id), req.body.tool, req.body.args || {});
    res.json({ ok: true, output: output.slice(0, 4000) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}));

// ---------- Telegram username → id resolver ----------
router.get('/resolve', wrap(async (req, res) => {
  const raw = String(req.query.username || '').trim().replace(/^@/, '');
  if (!raw) return res.status(400).json({ error: 'username required' });
  // 1. Local contact database.
  const local = db.prepare('SELECT chat_id, name, username FROM contacts WHERE username = ? COLLATE NOCASE').get(raw);
  if (local) return res.json({ source: 'contacts', id: local.chat_id, name: local.name, username: local.username });
  // 2. Ask Telegram (works for public usernames the bot can see).
  const { getBot } = require('../bot/handlers');
  const bot = getBot();
  if (!bot) return res.status(404).json({ error: 'Not in contacts, and bot is not running to ask Telegram' });
  try {
    const chatInfo = await bot.api.getChat('@' + raw);
    return res.json({
      source: 'telegram', id: chatInfo.id, type: chatInfo.type,
      name: chatInfo.title || [chatInfo.first_name, chatInfo.last_name].filter(Boolean).join(' '),
      username: chatInfo.username,
    });
  } catch (err) {
    return res.status(404).json({
      error: `Not found. Telegram only resolves users the bot has seen — ask them to message you once, or forward one of their messages to the bot and use /id.`,
    });
  }
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
  // Secrets (API keys, bot tokens, MCP auth headers) are excluded unless
  // ?secrets=1 is passed — keeps the default export safe to store/share.
  const withSecrets = req.query.secrets === '1';
  const dump = { exported_at: new Date().toISOString(), includes_secrets: withSecrets };
  const settings = db.prepare('SELECT key, value FROM settings').all()
    .filter(s => withSecrets || !s.key.startsWith('apikey_'));
  dump.settings = settings;
  for (const t of ['contacts', 'facts', 'memories', 'prompt_versions', 'scheduled_messages', 'skills', 'snippets', 'autoresponders', 'notes']) {
    dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  }
  dump.mcp_servers = db.prepare('SELECT * FROM mcp_servers').all()
    .map(s => withSecrets ? s : { ...s, headers: '{}' });
  dump.assistants = db.prepare('SELECT * FROM assistants').all()
    .map(a => withSecrets ? a : { ...a, bot_token: null });
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
      const cols = ['chat_id', 'assistant_id', ...CONTACT_FIELDS];
      const ins = db.prepare(`INSERT OR REPLACE INTO contacts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const c of dump.contacts) ins.run(c.chat_id, c.assistant_id || 0, ...CONTACT_FIELDS.map(f => c[f] ?? null));
      counts.contacts = dump.contacts.length;
    }
    if (Array.isArray(dump.facts)) {
      for (const f of dump.facts) if (f.key) facts.upsert(f.key, f.value, f.priority || 'casual');
      counts.facts = dump.facts.length;
    }
    if (Array.isArray(dump.memories)) {
      const ins = db.prepare('INSERT INTO memories (chat_id, content, priority, embedding, assistant_id) VALUES (?, ?, ?, ?, ?)');
      for (const m of dump.memories) if (m.content) ins.run(m.chat_id || 0, m.content, m.priority || 'casual', m.embedding || null, m.assistant_id || 0);
      counts.memories = dump.memories.length;
    }
    if (Array.isArray(dump.prompt_versions)) {
      const ins = db.prepare('INSERT INTO prompt_versions (name, content) VALUES (?, ?)');
      for (const v of dump.prompt_versions) if (v.content) ins.run(v.name || 'restored', v.content);
      counts.prompt_versions = dump.prompt_versions.length;
    }
    if (Array.isArray(dump.skills)) {
      const ins = db.prepare(`INSERT OR REPLACE INTO skills (name, description, triggers, content, enabled, source)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const s of dump.skills) if (s.name && s.content) ins.run(s.name, s.description || '', s.triggers || '[]', s.content, s.enabled ?? 1, s.source || 'manual');
      counts.skills = dump.skills.length;
    }
    if (Array.isArray(dump.mcp_servers)) {
      const ins = db.prepare('INSERT OR REPLACE INTO mcp_servers (name, url, headers, enabled) VALUES (?, ?, ?, ?)');
      for (const s of dump.mcp_servers) if (s.name && s.url) ins.run(s.name, s.url, s.headers || '{}', s.enabled ?? 1);
      counts.mcp_servers = dump.mcp_servers.length;
    }
    if (Array.isArray(dump.assistants)) {
      const ins = db.prepare('INSERT INTO assistants (name, bot_token, owner_user_id, system_prompt, settings_json, enabled) VALUES (?, ?, ?, ?, ?, ?)');
      for (const a of dump.assistants) if (a.name) ins.run(a.name, a.bot_token || null, a.owner_user_id || null, a.system_prompt || null, a.settings_json || '{}', a.enabled ?? 1);
      counts.assistants = dump.assistants.length;
    }
    if (Array.isArray(dump.snippets)) {
      const ins = db.prepare('INSERT INTO snippets (title, content) VALUES (?, ?)');
      for (const s of dump.snippets) if (s.content) ins.run(s.title || 'Snippet', s.content);
      counts.snippets = dump.snippets.length;
    }
    if (Array.isArray(dump.autoresponders)) {
      const ins = db.prepare('INSERT INTO autoresponders (trigger, match_type, reply, enabled) VALUES (?, ?, ?, ?)');
      for (const a of dump.autoresponders) if (a.trigger && a.reply) ins.run(a.trigger, a.match_type || 'contains', a.reply, a.enabled ?? 1);
      counts.autoresponders = dump.autoresponders.length;
    }
    if (Array.isArray(dump.notes)) {
      const ins = db.prepare('INSERT INTO notes (title, body, pinned) VALUES (?, ?, ?)');
      for (const n of dump.notes) if (n.title || n.body) ins.run(n.title || '', n.body || '', n.pinned ?? 0);
      counts.notes = dump.notes.length;
    }
  });
  tx();
  res.json({ ok: true, restored: counts });
}));

module.exports = router;
