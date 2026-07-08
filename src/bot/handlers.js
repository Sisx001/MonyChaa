'use strict';
// Telegram bot factory — builds a fully self-contained bot for one "assistant"
// (its own token, owner, and system prompt). The primary bot (assistant id 0)
// uses the env token; additional assistants come from the DB via the manager.
const { Bot, InputFile } = require('grammy');
const db = require('../db/schema');
const logger = require('../logger');
const config = require('../config');
const { env } = require('../config');
const { generateReply, upsertContact } = require('./reply');
const { sleep } = require('./human');
const { transcribeAudio } = require('../llm/gateway');
const events = require('../web/events');

// Registry of running bots keyed by assistant id.
const bots = new Map(); // id → { bot, assistant, businessConnectionId }
let totalQueueDepth = 0;

function logMsg(chatId, direction, content, extra = {}) {
  // Optionally store only a truncated preview for privacy.
  const stored = config.getSetting('log_full_content') === 'on' ? content : String(content).slice(0, 200);
  db.prepare(`
    INSERT INTO messages_log (chat_id, direction, content, model, tokens_used, response_time_ms, status, error, assistant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(chatId, direction, stored, extra.model || null, extra.tokens || 0,
    extra.responseTimeMs || 0, extra.status || 'ok', extra.error || null, extra.assistantId || 0);
  events.broadcast('message', { chatId, direction, content: String(content).slice(0, 200), assistantId: extra.assistantId || 0 });
}

// Fire a generic webhook alert (Slack/Discord/custom) if configured.
async function webhookAlert(text) {
  const url = config.getSetting('webhook_alert_url');
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text }), // covers Slack + Discord shapes
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) { logger.warn(`webhook alert failed: ${err.message}`); }
}

function logError(source, err) {
  db.prepare('INSERT INTO error_log (source, message, stack) VALUES (?, ?, ?)')
    .run(source, err.message || String(err), err.stack || null);
  events.broadcast('error', { source, message: err.message });
  logger.error(`[${source}] ${err.stack || err.message}`);
}

async function notifyOwnerVia(ctxBot, ownerId, text) {
  if (!ctxBot || !ownerId) return;
  try { await ctxBot.api.sendMessage(ownerId, text); }
  catch (err) { logger.warn(`notifyOwner failed: ${err.message}`); }
}

// Primary-bot convenience used by scheduler/fallback/system alerts.
async function notifyOwner(text) {
  const primary = bots.get(0);
  webhookAlert(text).catch(() => {}); // mirror alerts to the configured webhook
  return notifyOwnerVia(primary?.bot, env.OWNER_USER_ID, text);
}

async function downloadTelegramFile(bot, token, fileId) {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`file download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Extract text + attachments from an incoming business message. */
async function extractContent(bot, token, msg) {
  const attachments = [];
  let text = msg.text || msg.caption || '';

  if ((msg.voice || msg.audio) && config.getSetting('reply_to_voice') !== 'on') return { text: '', attachments };
  if (msg.voice || msg.audio) {
    const media = msg.voice || msg.audio;
    try {
      const buf = await downloadTelegramFile(bot, token, media.file_id);
      const transcript = await transcribeAudio(buf.toString('base64'), media.mime_type || 'audio/ogg');
      text = text ? `${text}\n[voice note] ${transcript}` : transcript;
    } catch (err) {
      logger.warn(`Voice transcription failed: ${err.message}`);
      text = text || '[voice note I could not listen to]';
    }
  }
  if (msg.photo && msg.photo.length && config.getSetting('reply_to_photos') !== 'on') return { text: msg.caption || '', attachments };
  if (msg.photo && msg.photo.length) {
    try {
      const best = msg.photo[msg.photo.length - 1];
      const buf = await downloadTelegramFile(bot, token, best.file_id);
      attachments.push({ type: 'image', mimeType: 'image/jpeg', dataBase64: buf.toString('base64') });
      if (!text) text = '[sent a photo]';
    } catch (err) {
      logger.warn(`Photo download failed: ${err.message}`);
      if (!text) text = '[sent a photo I could not see]';
    }
  }
  if (msg.sticker && config.getSetting('reply_to_stickers') !== 'on') return { text: '', attachments };
  if (msg.sticker && !text) text = `[sent a sticker: ${msg.sticker.emoji || 'sticker'}]`;
  if (msg.document && !text) text = `[sent a file: ${msg.document.file_name || 'document'}]`;
  if (msg.location && !text) text = `[shared a location]`;
  return { text, attachments };
}

async function checkKeywordTriggers(entry, chatId, name, text) {
  const keywords = config.getJSON('keyword_triggers', []);
  const lower = text.toLowerCase();
  const hit = keywords.find(k => k && lower.includes(String(k).toLowerCase()));
  if (hit) {
    await notifyOwnerVia(entry.bot, entry.assistant.ownerId, `[alert] Keyword "${hit}" from ${name} (chat ${chatId}):\n\n${text.slice(0, 500)}`);
    db.prepare('INSERT INTO events_log (type, detail) VALUES (?, ?)').run('keyword_trigger', `"${hit}" from ${name} (${chatId})`);
  }
}

/** Handle one incoming business message for a given assistant entry. */
function makeBusinessHandler(entry) {
  const chatLocks = new Map();
  const { assistant } = entry;
  const aid = assistant.id;

  return async function handleBusinessMessage(ctx) {
    const msg = ctx.businessMessage;
    if (!msg || !msg.from) return;

    if (msg.from.id === assistant.ownerId) {
      if (msg.text) {
        require('../memory/conversations').addMessage(msg.chat.id, 'assistant', msg.text, 0, aid);
        logMsg(msg.chat.id, 'outgoing', msg.text, { model: 'manual', assistantId: aid });
      }
      return;
    }

    const chatId = msg.chat.id;
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || String(chatId);
    const connId = msg.business_connection_id || entry.businessConnectionId;
    const receivedAt = Date.now();

    const prev = chatLocks.get(chatId) || Promise.resolve();
    const task = prev.then(async () => {
      totalQueueDepth++;
      events.broadcast('stats', { queueDepth: totalQueueDepth });
      try {
        if (msg.forward_origin && config.getSetting('ignore_forwarded') === 'on') return;
        const { contact, isNew } = upsertContact(chatId, { username: msg.from.username, name }, aid);
        if (isNew) events.broadcast('contact', { chatId, name, username: msg.from.username || null });

        if (config.getSetting('auto_read') === 'on' && connId) {
          ctx.api.raw.readBusinessMessage({ business_connection_id: connId, chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        }

        const { text, attachments } = await extractContent(entry.bot, assistant.token, msg);
        if (!text && !attachments.length) return;
        logMsg(chatId, 'incoming', text, { assistantId: aid });
        await checkKeywordTriggers(entry, chatId, name, text);

        if (config.getSetting('bot_enabled') !== 'on') {
          require('../memory/conversations').addMessage(chatId, 'user', text, 0, aid);
          const offline = config.getSetting('offline_message');
          if (offline) {
            const last = db.prepare("SELECT created_at FROM messages_log WHERE chat_id = ? AND direction = 'outgoing' AND content = ? ORDER BY id DESC LIMIT 1").get(chatId, offline);
            if (!(last && (Date.now() - new Date(last.created_at + 'Z').getTime()) < 6 * 3600000)) {
              await ctx.api.sendMessage(chatId, offline, { business_connection_id: connId }).catch(() => {});
              logMsg(chatId, 'outgoing', offline, { model: 'offline', assistantId: aid });
            }
          }
          return;
        }

        if (isNew) {
          if (config.getSetting('notify_new_contact') === 'on') {
            await notifyOwnerVia(entry.bot, assistant.ownerId, `New contact: ${name}${msg.from.username ? ' (@' + msg.from.username + ')' : ''} — chat ${chatId}`);
          }
          const welcome = config.getSetting('welcome_message');
          if (welcome) {
            await sleep(1500);
            await ctx.api.sendMessage(chatId, welcome, { business_connection_id: connId });
            logMsg(chatId, 'outgoing', welcome, { model: 'welcome', assistantId: aid });
          }
        }

        if (Date.now() - msg.date * 1000 > 24 * 3600 * 1000) return;

        const reply = await generateReply(chatId, text, { attachments, assistant });
        if (!reply) return;
        await sleep(reply.plan.thinkMs);

        const tts = require('../tools/tts');
        if (reply.voiceReply && tts.available()) {
          try {
            await ctx.api.sendChatAction(chatId, 'record_voice', { business_connection_id: connId }).catch(() => {});
            const fullText = reply.bursts.join('\n\n');
            const { buffer } = await tts.speak(fullText);
            await sleep(Math.min(reply.plan.typeMs, 8000));
            await ctx.api.sendVoice(chatId, new InputFile(buffer, 'voice.ogg'), { business_connection_id: connId });
            logMsg(chatId, 'outgoing', `[voice] ${fullText}`, { model: `${reply.result.provider}/${reply.result.model}`, tokens: (reply.result.tokensIn || 0) + (reply.result.tokensOut || 0), responseTimeMs: Date.now() - receivedAt, assistantId: aid });
            return;
          } catch (err) { logger.warn(`Voice reply failed, sending text: ${err.message}`); }
        }

        for (let i = 0; i < reply.bursts.length; i++) {
          const burst = reply.bursts[i];
          if (config.getSetting('typing_simulation') === 'on') {
            const typeMs = Math.round(reply.plan.typeMs * (burst.length / reply.bursts.join('').length));
            const until = Date.now() + Math.min(typeMs, 25000);
            while (Date.now() < until) {
              await ctx.api.sendChatAction(chatId, 'typing', { business_connection_id: connId }).catch(() => {});
              await sleep(Math.min(4500, until - Date.now()));
            }
          }
          await ctx.api.sendMessage(chatId, burst, { business_connection_id: connId });
          logMsg(chatId, 'outgoing', burst, { model: `${reply.result.provider}/${reply.result.model}`, tokens: (reply.result.tokensIn || 0) + (reply.result.tokensOut || 0), responseTimeMs: Date.now() - receivedAt, assistantId: aid });
          if (i < reply.bursts.length - 1) await sleep(800 + Math.random() * 1500);
        }

        if (reply.photoUrl) {
          try {
            await ctx.api.sendChatAction(chatId, 'upload_photo', { business_connection_id: connId }).catch(() => {});
            await ctx.api.sendPhoto(chatId, reply.photoUrl, { business_connection_id: connId });
            logMsg(chatId, 'outgoing', `[photo] ${reply.photoUrl.slice(0, 150)}`, { model: 'tool', assistantId: aid });
          } catch (err) { logger.warn(`Photo send failed: ${err.message}`); }
        }
      } catch (err) {
        logError('business_message', err);
        logMsg(chatId, 'incoming', msg.text || '[media]', { status: 'error', error: err.message, assistantId: aid });
        if (config.getSetting('notify_errors') === 'on') await notifyOwnerVia(entry.bot, assistant.ownerId, `Failed to reply to ${name}: ${err.message}`);
      } finally {
        totalQueueDepth--;
        events.broadcast('stats', { queueDepth: totalQueueDepth });
      }
    });
    chatLocks.set(chatId, task.catch(() => {}));
    await task.catch(() => {});
  };
}

// Owner-command handlers, including Telegram-side settings (see telegramSettings.js).
function registerCommands(bot, assistant) {
  const isOwner = ctx => ctx.from?.id === assistant.ownerId;
  bot.command('start', ctx => ctx.reply(
    `${assistant.name || 'Secretary Pro'} is running.\n\nConnect me: Telegram Settings → Telegram Business → Chatbots → add this bot.\nAdmin panel: http://localhost:${env.PORT}`
  ));
  bot.command('status', ctx => {
    if (!isOwner(ctx)) return;
    const today = db.prepare("SELECT COUNT(*) c FROM messages_log WHERE created_at >= date('now') AND assistant_id = ?").get(assistant.id).c;
    ctx.reply(`Online\nMessages today: ${today}\nAway: ${config.getSetting('away_mode')}\nQueue: ${totalQueueDepth}`);
  });
  bot.command('away', ctx => {
    if (!isOwner(ctx)) return;
    const next = config.getSetting('away_mode') === 'on' ? 'off' : 'on';
    config.setSetting('away_mode', next);
    ctx.reply(`Away mode: ${next}`);
  });
  bot.command('pause', ctx => {
    if (!isOwner(ctx)) return;
    const next = config.getSetting('bot_enabled') === 'on' ? 'off' : 'on';
    config.setSetting('bot_enabled', next);
    ctx.reply(next === 'on' ? 'Auto-replies resumed' : 'Auto-replies paused (still recording)');
  });
  bot.command('summary', ctx => {
    if (!isOwner(ctx)) return;
    ctx.reply(require('../analytics').dailySummaryText());
  });
  bot.command('id', ctx => {
    const fwd = ctx.message?.forward_origin;
    if (fwd?.type === 'user') return ctx.reply(`Forwarded from user id: ${fwd.sender_user.id} (${fwd.sender_user.first_name || ''})`);
    ctx.reply(`Your user id: ${ctx.from?.id}\nThis chat id: ${ctx.chat?.id}`);
  });
  // Telegram-side settings: /set /get /persona /model /character /skills
  require('./telegramSettings').register(bot, assistant, isOwner);

  bot.command('help', ctx => ctx.reply(require('./telegramSettings').helpText(env.PORT)));
  bot.api.setMyCommands([
    { command: 'status', description: 'Bot status & stats' },
    { command: 'away', description: 'Toggle away mode' },
    { command: 'pause', description: 'Pause/resume auto-replies' },
    { command: 'summary', description: 'Daily summary now' },
    { command: 'settings', description: 'Show current settings' },
    { command: 'set', description: 'Change a setting: /set key value' },
    { command: 'persona', description: 'Set persona text' },
    { command: 'model', description: 'Set model: /model provider model' },
    { command: 'character', description: 'Apply a character' },
    { command: 'id', description: 'Show Telegram id' },
    { command: 'help', description: 'Show commands' },
  ]).catch(err => logger.warn(`setMyCommands failed: ${err.message}`));
}

/**
 * Build (but do not start) a bot for an assistant descriptor:
 * { id, name, token, ownerId, systemPrompt }
 */
function buildBot(assistant) {
  if (!assistant.token) return null;
  const bot = new Bot(assistant.token);
  const entry = { bot, assistant, businessConnectionId: null };
  bots.set(assistant.id, entry);

  bot.on('business_connection', ctx => {
    const conn = ctx.businessConnection;
    entry.businessConnectionId = conn.id;
    const status = conn.is_enabled === false ? 'disabled' : 'connected';
    db.prepare('INSERT INTO events_log (type, detail) VALUES (?, ?)').run('business_connection', `[${assistant.name || 'primary'}] ${status}: ${conn.id}`);
    events.broadcast('connection', { status, id: conn.id, assistantId: assistant.id });
    logger.info(`[${assistant.name || 'primary'}] business connection ${status}`);
  });
  bot.on('business_message', makeBusinessHandler(entry));

  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    if (!msg || (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup')) return next();
    if (config.getSetting('reply_in_groups') !== 'on' || config.getSetting('bot_enabled') !== 'on') return;
    const text = msg.text || msg.caption || '';
    if (!text) return;
    const agentName = config.getSetting('agent_name').toLowerCase();
    const me = ctx.me?.username?.toLowerCase();
    const mentioned = (me && text.toLowerCase().includes('@' + me)) || (agentName && text.toLowerCase().includes(agentName)) || msg.reply_to_message?.from?.id === ctx.me?.id;
    if (config.getSetting('group_mention_only') === 'on' && !mentioned) return;
    try {
      const reply = await generateReply(msg.chat.id, text, { assistant });
      if (!reply) return;
      await sleep(reply.plan.thinkMs);
      for (const burst of reply.bursts) await ctx.reply(burst, { reply_parameters: { message_id: msg.message_id } });
    } catch (err) { logError('group_message', err); }
  });

  bot.on('edited_business_message', ctx => {
    const msg = ctx.editedBusinessMessage;
    if (!msg || !msg.from || msg.from.id === assistant.ownerId || !msg.text) return;
    require('../memory/conversations').addMessage(msg.chat.id, 'user', `[edited their earlier message to] ${msg.text}`, 0, assistant.id);
    db.prepare('INSERT INTO events_log (type, detail) VALUES (?, ?)').run('message_edited', `chat ${msg.chat.id}: ${msg.text.slice(0, 120)}`);
  });
  bot.on('deleted_business_messages', ctx => {
    const del = ctx.deletedBusinessMessages;
    if (del) db.prepare('INSERT INTO events_log (type, detail) VALUES (?, ?)').run('messages_deleted', `chat ${del.chat?.id}: ${del.message_ids?.length || 0} deleted`);
  });

  registerCommands(bot, assistant);
  bot.catch(err => logError(`bot:${assistant.name || 'primary'}`, err.error || err));
  return bot;
}

const ALLOWED_UPDATES = ['message', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages', 'my_chat_member'];

/** Create + start the primary env bot. Returns the bot or null. */
function createBot() {
  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN not set — primary bot disabled, web panel still available');
    return null;
  }
  const bot = buildBot({ id: 0, name: 'primary', token: env.TELEGRAM_BOT_TOKEN, ownerId: env.OWNER_USER_ID, systemPrompt: null, settings: {} });
  bot.start({ allowed_updates: ALLOWED_UPDATES, onStart: info => logger.info(`Primary bot @${info.username} polling`) })
    .catch(err => logError('bot_start', err));
  return bot;
}

function getBot(assistantId = 0) { return bots.get(assistantId)?.bot || null; }
function getBusinessConnectionId(assistantId = 0) { return bots.get(assistantId)?.businessConnectionId || null; }
function getQueueDepth() { return totalQueueDepth; }

module.exports = {
  createBot, buildBot, getBot, getBusinessConnectionId, getQueueDepth,
  notifyOwner, logMsg, logError, bots, ALLOWED_UPDATES,
};
