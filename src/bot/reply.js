'use strict';
// Core reply pipeline: contact profile → history → memories → tools → LLM → send.
const db = require('../db/schema');
const logger = require('../logger');
const config = require('../config');
const conversations = require('../memory/conversations');
const facts = require('../memory/facts');
const vector = require('../memory/vector');
const { chat } = require('../llm/fallback');
const { maybeRunTool } = require('../tools');
const { delayPlan, splitBursts, sleep } = require('./human');

function getContact(chatId) {
  return db.prepare('SELECT * FROM contacts WHERE chat_id = ?').get(chatId);
}

function upsertContact(chatId, { username, name }) {
  const existing = getContact(chatId);
  if (existing) {
    if ((username && username !== existing.username) || (name && name !== existing.name)) {
      db.prepare("UPDATE contacts SET username = ?, name = ?, updated_at = datetime('now') WHERE chat_id = ?")
        .run(username || existing.username, name || existing.name, chatId);
    }
    return { contact: getContact(chatId), isNew: false };
  }
  db.prepare(
    'INSERT INTO contacts (chat_id, username, name, auto_reply) VALUES (?, ?, ?, ?)'
  ).run(chatId, username || null, name || null, config.getSetting('auto_reply_default') === 'on' ? 1 : 0);
  return { contact: getContact(chatId), isNew: true };
}

function fillTemplate(template, vars) {
  return template
    .replaceAll('{name}', vars.name || 'them')
    .replaceAll('{time}', vars.time)
    .replaceAll('{date}', vars.date)
    .replaceAll('{chat_history}', vars.chat_history || '')
    .replaceAll('{facts}', vars.facts || '')
    .replaceAll('{contact_notes}', vars.contact_notes || '');
}

function parseJsonArray(text) {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Build the full system prompt for a contact. */
function buildSystemPrompt(contact, extraContext) {
  const tz = config.getSetting('timezone') || 'UTC';
  const now = new Date();
  const vars = {
    name: contact?.name || contact?.username || 'them',
    time: now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit' }),
    date: now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    facts: facts.forPrompt(),
    contact_notes: contact?.notes || '',
  };

  let prompt = fillTemplate(contact?.custom_prompt || config.getSetting('system_prompt'), vars);

  prompt += `\n\nCurrent date/time: ${vars.date}, ${vars.time} (${tz}).`;
  if (vars.facts) prompt += `\n\nThings I know (use naturally, never dump):\n${vars.facts}`;

  if (contact) {
    const profile = [];
    if (contact.name) profile.push(`Name: ${contact.name}`);
    if (contact.relationship) profile.push(`Relationship to me: ${contact.relationship}`);
    if (contact.tone) profile.push(`Tone to use: ${contact.tone}`);
    if (contact.gender) profile.push(`Gender (for pronouns): ${contact.gender}`);
    if (contact.notes) profile.push(`Notes: ${contact.notes}`);
    const rules = parseJsonArray(contact.rules);
    if (rules.length) profile.push(`Rules: ${rules.join('; ')}`);
    const blocked = parseJsonArray(contact.blocked_topics);
    if (blocked.length) profile.push(`NEVER discuss: ${blocked.join(', ')}. Deflect politely if raised.`);
    if (profile.length) prompt += `\n\nAbout this contact:\n${profile.map(l => `- ${l}`).join('\n')}`;
    if (contact.learned_tone) {
      prompt += `\n\nExamples of how I actually talk to this person (match this style exactly):\n${contact.learned_tone.slice(0, 3000)}`;
    }
  }

  const lang = config.getSetting('language');
  prompt += lang === 'auto'
    ? `\n\nAlways reply in the same language the sender writes in.`
    : `\n\nAlways reply in ${lang}.`;

  const maxLen = contact?.max_length || Number(config.getSetting('max_response_length')) || 800;
  prompt += `\nKeep replies under ${maxLen} characters. Write like a real person texting — no markdown formatting.`;

  if (extraContext) prompt += `\n\nLive context you may use:\n${extraContext}`;
  return prompt;
}

function isAway() {
  if (config.getSetting('away_mode') === 'on') return true;
  const start = config.getSetting('away_schedule_start');
  const end = config.getSetting('away_schedule_end');
  if (!start || !end) return false;
  const tz = config.getSetting('timezone') || 'UTC';
  const now = new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  // Handles overnight ranges like 23:00–07:00.
  return start <= end ? (now >= start && now <= end) : (now >= start || now <= end);
}

// Custom context blocks (weather / news / calendar) injected into the prompt,
// refreshed at most every 10 minutes.
let contextCache = { at: 0, text: '' };
async function injectedContext() {
  const wantWeather = config.getSetting('inject_weather_city');
  const wantNews = config.getSetting('inject_news') === 'on';
  const wantCalendar = config.getSetting('inject_calendar') === 'on';
  if (!wantWeather && !wantNews && !wantCalendar) return '';
  if (Date.now() - contextCache.at < 10 * 60000) return contextCache.text;

  const { TOOLS } = require('../tools');
  const parts = await Promise.all([
    wantWeather ? TOOLS.weather.run({ location: wantWeather }).then(t => `Weather: ${t}`).catch(() => '') : '',
    wantNews && TOOLS.news.enabled() ? TOOLS.news.run({}).then(t => `Headlines:\n${t}`).catch(() => '') : '',
    wantCalendar && TOOLS.calendar.enabled() ? TOOLS.calendar.run({ days: 2 }).then(t => `My schedule:\n${t}`).catch(() => '') : '',
  ]);
  contextCache = { at: Date.now(), text: parts.filter(Boolean).join('\n\n') };
  return contextCache.text;
}

/** Momentum: fraction of the last 6 messages that happened within 5 minutes. */
function conversationMomentum(chatId) {
  const rows = db.prepare(
    'SELECT created_at FROM conversations WHERE chat_id = ? ORDER BY id DESC LIMIT 6'
  ).all(chatId);
  if (rows.length < 2) return 0;
  const recent = rows.filter(r => (Date.now() - new Date(r.created_at + 'Z').getTime()) < 5 * 60000);
  return recent.length / rows.length;
}

/**
 * Generate a reply for an incoming message. Returns
 * { bursts, plan, result, contact } or null when auto-reply is off.
 */
async function generateReply(chatId, incomingText, { attachments = [] } = {}) {
  const contact = getContact(chatId);
  const start = Date.now();

  // Away mode: canned response, once per 4 hours per contact.
  if (isAway()) {
    const last = db.prepare(
      "SELECT created_at FROM messages_log WHERE chat_id = ? AND direction = 'outgoing' AND content = ? ORDER BY id DESC LIMIT 1"
    ).get(chatId, config.getSetting('away_message'));
    const recentlySent = last && (Date.now() - new Date(last.created_at + 'Z').getTime()) < 4 * 3600000;
    if (!recentlySent) {
      return {
        bursts: [config.getSetting('away_message')],
        plan: { thinkMs: 1500, typeMs: 1200 },
        result: { provider: 'away-mode', model: '-', tokensIn: 0, tokensOut: 0, cost: 0 },
        contact,
      };
    }
    return null;
  }

  if (contact && !contact.auto_reply) return null;

  conversations.addMessage(chatId, 'user', incomingText);

  // Gather context: semantic memories + tool output + injected blocks (all best-effort).
  const [memories, toolResult, injected] = await Promise.all([
    vector.recall(chatId, incomingText).catch(() => []),
    maybeRunTool(incomingText).catch(() => null),
    injectedContext().catch(() => ''),
  ]);
  let extraContext = '';
  if (injected) extraContext += injected;
  if (memories.length) {
    extraContext += (extraContext ? '\n\n' : '') + 'Relevant memories:\n' + memories.map(m => `- ${m.content}`).join('\n');
  }
  if (toolResult) extraContext += (extraContext ? '\n\n' : '') + toolResult.context;

  const history = conversations.getHistory(chatId);
  const messages = [{ role: 'system', content: buildSystemPrompt(contact, extraContext) }];
  for (const h of history) {
    messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content });
  }
  // Attach media (images) to the latest user message for vision models.
  if (attachments.length && messages.length > 1) {
    const lastMsg = messages[messages.length - 1];
    lastMsg.content = [{ type: 'text', text: typeof lastMsg.content === 'string' ? lastMsg.content : incomingText }, ...attachments];
  }

  const maxLen = contact?.max_length || Number(config.getSetting('max_response_length')) || 800;
  const result = await chat(messages, {
    maxTokens: Math.min(2048, Math.ceil(maxLen / 2.5)),
    needsVision: attachments.some(a => a.type === 'image'),
  });

  let replyText = result.text.trim();
  if (!replyText) throw new Error('LLM returned empty reply');
  if (replyText.length > maxLen * 1.5) replyText = replyText.slice(0, maxLen * 1.5).replace(/\s+\S*$/, '');

  conversations.addMessage(chatId, 'assistant', replyText, result.tokensOut);

  const plan = delayPlan(incomingText, replyText, {
    delayMultiplier: contact?.delay_multiplier ?? 1,
    momentum: conversationMomentum(chatId),
    priority: contact?.priority ?? 0,
  });

  // Background housekeeping (never blocks the reply).
  setImmediate(() => {
    vector.extractFacts(chatId, incomingText, replyText).catch(() => {});
    conversations.maybeSummarize(chatId).catch(() => {});
  });

  logger.info(`Reply for ${chatId} via ${result.provider}/${result.model} in ${Date.now() - start}ms`);
  return {
    bursts: splitBursts(replyText),
    plan,
    result,
    contact,
    photoUrl: toolResult?.photoUrl || null,
    voiceReply: Boolean(contact?.voice_replies),
  };
}

module.exports = { generateReply, getContact, upsertContact, buildSystemPrompt, isAway, sleep };
