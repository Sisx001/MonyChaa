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

function getContact(chatId, assistantId = 0) {
  return db.prepare('SELECT * FROM contacts WHERE chat_id = ? AND assistant_id = ?').get(chatId, assistantId);
}

function upsertContact(chatId, { username, name }, assistantId = 0) {
  const existing = getContact(chatId, assistantId);
  if (existing) {
    if ((username && username !== existing.username) || (name && name !== existing.name)) {
      db.prepare("UPDATE contacts SET username = ?, name = ?, updated_at = datetime('now') WHERE chat_id = ? AND assistant_id = ?")
        .run(username || existing.username, name || existing.name, chatId, assistantId);
    }
    return { contact: getContact(chatId, assistantId), isNew: false };
  }
  db.prepare(
    'INSERT INTO contacts (chat_id, assistant_id, username, name, auto_reply) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, assistantId, username || null, name || null, config.getSetting('auto_reply_default') === 'on' ? 1 : 0);
  return { contact: getContact(chatId, assistantId), isNew: true };
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

/** Build the full system prompt. `promptOverride` (per-assistant) wins over the
 * global prompt; `S` is an optional per-assistant setting getter. */
function buildSystemPrompt(contact, extraContext, promptOverride = null, S = null, maxLenOverride = null) {
  const get = S || config.getSetting;
  const tz = get('timezone') || 'UTC';
  const now = new Date();
  const template = contact?.custom_prompt || promptOverride || get('system_prompt');
  const vars = {
    name: contact?.name || contact?.username || 'them',
    time: now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit' }),
    date: now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    facts: facts.forPrompt(),
    contact_notes: contact?.notes || '',
    chat_history: '',
  };
  // {chat_history} is filled only when the template asks for it — history is
  // normally passed as proper chat turns, not prompt text.
  if (contact && template.includes('{chat_history}')) {
    vars.chat_history = conversations.getHistory(contact.chat_id, 10)
      .map(m => `${m.role === 'assistant' ? 'Me' : 'Them'}: ${m.content}`).join('\n');
  }

  let prompt = fillTemplate(template, vars);

  prompt += `\n\nCurrent date/time: ${vars.date}, ${vars.time} (${tz}).`;
  if (get('time_awareness') === 'on') {
    const tod = require('./timeofday');
    const { hint } = tod.periodFor(tod.hourIn(tz, now));
    if (hint) prompt += `\n${hint}`;
  }
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
    // Standing emotional baseline: how this person usually reaches out.
    if (get('mood_adaptation') === 'on' && contact.chat_id) {
      try {
        const { dominant } = require('../analytics').contactMoodProfile(contact.chat_id, contact.assistant_id || 0);
        const BASE = {
          upset: 'This person often reaches out frustrated — lead with patience.',
          sad: 'This person often reaches out low — be gentle and warm with them.',
          anxious: 'This person often reaches out anxious — be reassuring and clear.',
          grateful: 'This person is often warm and appreciative — match that warmth.',
          confused: 'This person often needs things spelled out — be extra clear.',
          excited: 'This person is usually upbeat — meet their energy.',
        };
        if (dominant && BASE[dominant]) prompt += `\n${BASE[dominant]}`;
      } catch { /* baseline is best-effort */ }
    }
  }

  const lang = get('language');
  prompt += lang === 'auto'
    ? `\n\nAlways reply in the same language the sender writes in.`
    : `\n\nAlways reply in ${lang}.`;

  // Style directives from settings.
  const personaName = get('persona_name');
  if (personaName) prompt += `\nYou are replying as ${personaName}.`;
  const styleMap = {
    concise: 'Keep replies very short — one or two sentences max.',
    detailed: 'Give thorough, complete answers when the topic calls for it.',
  };
  if (styleMap[get('reply_style')]) prompt += `\n${styleMap[get('reply_style')]}`;
  const emojiMap = {
    none: 'Never use emoji.',
    light: 'Use emoji very sparingly — at most one occasionally.',
    heavy: 'Use emoji freely and expressively.',
  };
  if (emojiMap[get('emoji_usage')]) prompt += `\n${emojiMap[get('emoji_usage')]}`;
  const writingStyle = get('writing_style');
  if (writingStyle) prompt += `\nStyle notes: ${writingStyle}`;

  const maxLen = maxLenOverride || contact?.max_length || Number(get('max_response_length')) || 800;
  prompt += `\nKeep replies under ${maxLen} characters. Write like a real person texting — no markdown formatting.`;

  // Human-behavior directives — kept in lockstep with the code-level humanizer
  // so what the prompt promises is also what postProcess delivers.
  if (get('humanize') === 'on') {
    prompt += `\n\nText like a real person, not an assistant: use contractions, vary sentence length, ` +
      `let punctuation be casual, and don't over-explain. A short, natural reply beats a polished one. ` +
      `Never mention being an AI, a model, or a bot.`;
  }
  if (get('human_filler_ban') === 'on') {
    prompt += `\nNever use assistant filler like "I hope this helps", "feel free to", "as an AI", ` +
      `"certainly!", "of course!", "let me know if you need anything else", or "is there anything else".`;
  }

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
/** Silent no-reply window (unlike away mode, sends nothing at all). */
function inQuietHours() {
  const start = config.getSetting('quiet_hours_start');
  const end = config.getSetting('quiet_hours_end');
  if (!start || !end) return false;
  const tz = config.getSetting('timezone') || 'UTC';
  const now = new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  return start <= end ? (now >= start && now <= end) : (now >= start || now <= end);
}

function inBusinessHours() {
  if (config.getSetting('business_hours_only') !== 'on') return true;
  const start = config.getSetting('business_hours_start');
  const end = config.getSetting('business_hours_end');
  if (!start || !end) return true;
  const tz = config.getSetting('timezone') || 'UTC';
  const now = new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  return start <= end ? (now >= start && now <= end) : (now >= start || now <= end);
}

/** Reply-policy gates: returns a skip reason or null to proceed. */
function replyPolicyBlock(incomingText, chatId, aid = 0) {
  if (inQuietHours()) return 'quiet_hours';
  if (!inBusinessHours()) return 'after_hours';
  if (incomingText.length < (Number(config.getSetting('min_message_length')) || 0)) return 'too_short';
  const blacklist = config.getJSON('blacklist_words', []);
  const lower = incomingText.toLowerCase();
  if (blacklist.some(w => w && lower.includes(String(w).toLowerCase()))) return 'blacklisted_word';

  // Cooldown between replies to the same contact.
  const cooldown = Number(config.getSetting('cooldown_seconds')) || 0;
  if (cooldown > 0 && chatId) {
    const last = db.prepare("SELECT created_at FROM messages_log WHERE chat_id = ? AND assistant_id = ? AND direction = 'outgoing' ORDER BY id DESC LIMIT 1").get(chatId, aid);
    if (last && (Date.now() - new Date(last.created_at + 'Z').getTime()) < cooldown * 1000) return 'cooldown';
  }
  // Daily reply cap per contact.
  const cap = Number(config.getSetting('max_daily_replies_per_contact')) || 0;
  if (cap > 0 && chatId) {
    const count = db.prepare("SELECT COUNT(*) c FROM messages_log WHERE chat_id = ? AND assistant_id = ? AND direction = 'outgoing' AND created_at >= date('now')").get(chatId, aid).c;
    if (count >= cap) return 'daily_cap';
  }

  const probability = Number(config.getSetting('reply_probability'));
  if (Number.isFinite(probability) && probability < 100 && Math.random() * 100 >= probability) return 'probability_skip';
  return null;
}

/** Post-process the generated reply per content-control settings. */
function postProcess(text, aid = 0) {
  let out = text;
  if (config.getSetting('strip_markdown') === 'on') {
    out = out.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, '')).replace(/[*_`#>]/g, '');
  }
  if (config.getSetting('redact_phone_numbers') === 'on') {
    out = out.replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[redacted]');
  }
  if (config.getSetting('profanity_filter') === 'on') {
    out = out.replace(/\b(fuck|shit|bitch|asshole|cunt|dick)\w*\b/gi, m => m[0] + '*'.repeat(Math.max(1, m.length - 1)));
  }
  const maxLinks = Number(config.getSetting('max_links_per_reply'));
  if (Number.isFinite(maxLinks) && maxLinks >= 0) {
    let seen = 0;
    out = out.replace(/https?:\/\/\S+/g, url => (++seen > maxLinks ? '' : url));
  }
  // Human roughening — make replies read like texting, not an assistant.
  const level = config.getSetting('human_imperfections');
  if (level && level !== 'off') out = require('./human').humanize(out, level);
  const sig = config.getSetting('signature_name');
  if (sig) out += `\n— ${sig}`;
  return out.trim();
}

async function generateReply(chatId, incomingText, { attachments = [], assistant = null } = {}) {
  const aid = assistant?.id || 0;
  const promptOverride = assistant?.systemPrompt || null;
  // Per-assistant settings overlay: assistant.settings wins over globals.
  const S = key => (assistant?.settings && assistant.settings[key] !== undefined && assistant.settings[key] !== '')
    ? assistant.settings[key] : config.getSetting(key);
  const contact = getContact(chatId, aid);
  const start = Date.now();

  const blocked = replyPolicyBlock(incomingText, chatId, aid);
  if (blocked) {
    conversations.addMessage(chatId, 'user', incomingText, 0, aid);
    logger.info(`Reply skipped for ${chatId}: ${blocked}`);
    // After-hours auto-reply, throttled once per window.
    if (blocked === 'after_hours') {
      const msg = config.getSetting('after_hours_message');
      if (msg) return { bursts: [msg], plan: { thinkMs: 1000, typeMs: 800 }, result: { provider: 'after-hours', model: '-', tokensIn: 0, tokensOut: 0, cost: 0 }, contact };
    }
    return null;
  }

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

  // Auto-responder rules short-circuit the LLM entirely (0 cost, instant).
  const canned = require('../autoresponders').match(incomingText);
  if (canned) {
    conversations.addMessage(chatId, 'user', incomingText, 0, aid);
    conversations.addMessage(chatId, 'assistant', canned, 0, aid);
    logger.info(`Auto-responder matched for ${chatId}`);
    return {
      bursts: splitBursts(canned),
      plan: delayPlan(incomingText, canned, { delayMultiplier: contact?.delay_multiplier ?? 1, momentum: conversationMomentum(chatId), priority: contact?.priority ?? 0 }),
      result: { provider: 'autoresponder', model: '-', tokensIn: 0, tokensOut: 0, cost: 0 },
      contact,
    };
  }

  conversations.addMessage(chatId, 'user', incomingText, 0, aid);

  // Gather context: semantic memories + tool output + injected blocks (all best-effort).
  const [memories, toolResult, injected] = await Promise.all([
    vector.recall(chatId, incomingText, undefined, aid).catch(() => []),
    maybeRunTool(incomingText).catch(() => null),
    injectedContext().catch(() => ''),
  ]);
  let extraContext = '';
  const skillBlock = require('../skills').activeFor(incomingText);
  if (skillBlock) extraContext += `Active skills — follow these instructions:\n${skillBlock}`;
  if (injected) extraContext += (extraContext ? '\n\n' : '') + injected;
  if (memories.length) {
    extraContext += (extraContext ? '\n\n' : '') + 'Relevant memories:\n' + memories.map(m => `- ${m.content}`).join('\n');
  }
  if (toolResult) extraContext += (extraContext ? '\n\n' : '') + toolResult.context;
  // Mood adaptation: read the sender's apparent mood and steer the reply's tone.
  if (S('mood_adaptation') === 'on') {
    const { hint } = require('./mood').detect(incomingText);
    if (hint) extraContext += (extraContext ? '\n\n' : '') + hint;
  }

  // Target length: an explicit per-contact cap wins; otherwise the settings base,
  // optionally scaled down to fit the incoming message's size (adaptive_length).
  let maxLen = contact?.max_length || Number(S('max_response_length')) || 800;
  if (!contact?.max_length && S('adaptive_length') === 'on') {
    maxLen = require('./replylength').suggest(incomingText, maxLen);
  }

  const history = conversations.getHistory(chatId, undefined, aid);
  const messages = [{ role: 'system', content: buildSystemPrompt(contact, extraContext, promptOverride, S, maxLen) }];
  for (const h of history) {
    messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content });
  }
  // Attach media (images) to the latest user message for vision models.
  if (attachments.length && messages.length > 1) {
    const lastMsg = messages[messages.length - 1];
    lastMsg.content = [{ type: 'text', text: typeof lastMsg.content === 'string' ? lastMsg.content : incomingText }, ...attachments];
  }

  const result = await chat(messages, {
    maxTokens: Math.min(2048, Math.ceil(maxLen / 2.5)),
    temperature: Number(S('temperature')) || 0.8,
    topP: Number(S('top_p')) || 1,
    needsVision: attachments.some(a => a.type === 'image'),
  });

  let replyText = result.text.trim();
  if (!replyText) throw new Error('LLM returned empty reply');
  if (replyText.length > maxLen * 1.5) replyText = replyText.slice(0, maxLen * 1.5).replace(/\s+\S*$/, '');
  replyText = postProcess(replyText, aid);

  // Repeat guard: don't send an identical reply twice in a row to this chat.
  if (config.getSetting('repeat_guard') === 'on') {
    const lastOut = db.prepare("SELECT content FROM messages_log WHERE chat_id = ? AND assistant_id = ? AND direction = 'outgoing' ORDER BY id DESC LIMIT 1").get(chatId, aid);
    if (lastOut && lastOut.content === replyText) {
      logger.info(`Reply skipped for ${chatId}: repeat_guard (identical to last reply)`);
      return null;
    }
  }

  conversations.addMessage(chatId, 'assistant', replyText, result.tokensOut, aid);

  const plan = delayPlan(incomingText, replyText, {
    delayMultiplier: contact?.delay_multiplier ?? 1,
    momentum: conversationMomentum(chatId),
    priority: contact?.priority ?? 0,
  });

  // Background housekeeping (never blocks the reply).
  setImmediate(() => {
    vector.extractFacts(chatId, incomingText, replyText, aid).catch(() => {});
    conversations.maybeSummarize(chatId, aid).catch(() => {});
  });

  logger.info(`Reply for ${chatId} via ${result.provider}/${result.model} in ${Date.now() - start}ms`);
  const bursts = splitBursts(replyText);
  // Optional footer/signature on the final burst of every reply.
  if (config.getSetting('footer_enabled') === 'on') {
    const footer = config.getSetting('message_footer').trim();
    if (footer) bursts[bursts.length - 1] += `\n\n${footer}`;
  }
  return {
    bursts,
    plan,
    result,
    contact,
    photoUrl: toolResult?.photoUrl || null,
    voiceReply: Boolean(contact?.voice_replies),
  };
}

module.exports = { generateReply, getContact, upsertContact, buildSystemPrompt, isAway, postProcess, replyPolicyBlock, sleep };
