'use strict';
// Telegram Business Mode handlers: business_connection + business_message.
const { Bot, InputFile } = require('grammy');
const db = require('../db/schema');
const logger = require('../logger');
const config = require('../config');
const { env } = require('../config');
const { generateReply, upsertContact } = require('./reply');
const { sleep } = require('./human');
const { transcribeAudio } = require('../llm/gateway');
const events = require('../web/events');

let bot = null;
let businessConnectionId = null;
let queueDepth = 0;
const chatLocks = new Map(); // serialize replies per chat

function logMsg(chatId, direction, content, extra = {}) {
  db.prepare(`
    INSERT INTO messages_log (chat_id, direction, content, model, tokens_used, response_time_ms, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(chatId, direction, content, extra.model || null, extra.tokens || 0,
    extra.responseTimeMs || 0, extra.status || 'ok', extra.error || null);
  events.broadcast('message', { chatId, direction, content: String(content).slice(0, 200) });
}

function logError(source, err) {
  db.prepare('INSERT INTO error_log (source, message, stack) VALUES (?, ?, ?)')
    .run(source, err.message || String(err), err.stack || null);
  events.broadcast('error', { source, message: err.message });
  logger.error(`[${source}] ${err.stack || err.message}`);
}

async function notifyOwner(text) {
  if (!bot || !env.OWNER_USER_ID) return;
  try {
    await bot.api.sendMessage(env.OWNER_USER_ID, text);
  } catch (err) {
    logger.warn(`notifyOwner failed: ${err.message}`);
  }
}

async function downloadTelegramFile(fileId) {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`file download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Extract text + attachments from an incoming business message. */
async function extractContent(msg) {
  const attachments = [];
  let text = msg.text || msg.caption || '';

  if ((msg.voice || msg.audio) && config.getSetting('reply_to_voice') !== 'on') {
    return { text: '', attachments }; // voice replies disabled entirely
  }
  if (msg.voice || msg.audio) {
    const media = msg.voice || msg.audio;
    try {
      const buf = await downloadTelegramFile(media.file_id);
      const mime = media.mime_type || 'audio/ogg';
      const transcript = await transcribeAudio(buf.toString('base64'), mime);
      text = text ? `${text}\n[voice note] ${transcript}` : transcript;
      logger.info(`Transcribed voice note (${transcript.length} chars)`);
    } catch (err) {
      logger.warn(`Voice transcription failed: ${err.message}`);
      text = text || '[voice note I could not listen to]';
    }
  }

  if (msg.photo && msg.photo.length && config.getSetting('reply_to_photos') !== 'on') {
    return { text: msg.caption || '', attachments };
  }
  if (msg.photo && msg.photo.length) {
    try {
      const best = msg.photo[msg.photo.length - 1];
      const buf = await downloadTelegramFile(best.file_id);
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

async function checkKeywordTriggers(chatId, name, text) {
  const keywords = config.getJSON('keyword_triggers', []);
  const lower = text.toLowerCase();
  const hit = keywords.find(k => k && lower.includes(String(k).toLowerCase()));
  if (hit) {
    await notifyOwner(`🚨 Keyword "${hit}" from ${name} (chat ${chatId}):\n\n${text.slice(0, 500)}`);
    db.prepare('INSERT INTO events_log (type, detail) VALUES (?, ?)')
      .run('keyword_trigger', `"${hit}" from ${name} (${chatId})`);
  }
}

async function handleBusinessMessage(ctx) {
  const msg = ctx.businessMessage;
  if (!msg || !msg.from) return;

  // Never reply to my own messages (outgoing messages I typed myself).
  if (msg.from.id === env.OWNER_USER_ID) {
    // Still record my manual replies so the model keeps conversational context.
    if (msg.text) {
      const conversations = require('../memory/conversations');
      conversations.addMessage(msg.chat.id, 'assistant', msg.text);
      logMsg(msg.chat.id, 'outgoing', msg.text, { model: 'manual' });
    }
    return;
  }

  const chatId = msg.chat.id;
  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || String(chatId);
  const connId = msg.business_connection_id || businessConnectionId;
  const receivedAt = Date.now();

  // Serialize per-chat so bursts of messages don't produce interleaved replies.
  const prev = chatLocks.get(chatId) || Promise.resolve();
  const task = prev.then(async () => {
    queueDepth++;
    events.broadcast('stats', { queueDepth });
    try {
      if (msg.forward_origin && config.getSetting('ignore_forwarded') === 'on') return;

      const { contact, isNew } = upsertContact(chatId, { username: msg.from.username, name });
      if (isNew) events.broadcast('contact', { chatId, name, username: msg.from.username || null });

      // Read receipt (blue ticks) for the incoming message.
      if (config.getSetting('auto_read') === 'on' && connId) {
        ctx.api.raw.readBusinessMessage({
          business_connection_id: connId, chat_id: chatId, message_id: msg.message_id,
        }).catch(() => {});
      }

      const { text, attachments } = await extractContent(msg);
      if (!text && !attachments.length) return;
      logMsg(chatId, 'incoming', text);
      await checkKeywordTriggers(chatId, name, text);

      // Master switch: record everything, reply to nothing (optional one-time notice).
      if (config.getSetting('bot_enabled') !== 'on') {
        require('../memory/conversations').addMessage(chatId, 'user', text);
        const offline = config.getSetting('offline_message');
        if (offline) {
          const last = db.prepare(
            "SELECT created_at FROM messages_log WHERE chat_id = ? AND direction = 'outgoing' AND content = ? ORDER BY id DESC LIMIT 1"
          ).get(chatId, offline);
          const recently = last && (Date.now() - new Date(last.created_at + 'Z').getTime()) < 6 * 3600000;
          if (!recently) {
            await ctx.api.sendMessage(chatId, offline, { business_connection_id: connId }).catch(() => {});
            logMsg(chatId, 'outgoing', offline, { model: 'offline' });
          }
        }
        return;
      }

      if (isNew) {
        if (config.getSetting('notify_new_contact') === 'on') {
          await notifyOwner(`👋 New contact: ${name}${msg.from.username ? ' (@' + msg.from.username + ')' : ''} — chat ${chatId}`);
        }
        const welcome = config.getSetting('welcome_message');
        if (welcome) {
          await sleep(1500);
          await ctx.api.sendMessage(chatId, welcome, { business_connection_id: connId });
          logMsg(chatId, 'outgoing', welcome, { model: 'welcome' });
        }
      }

      // Respect Telegram's 24-hour business message window: we're replying to a
      // message that just arrived, so the window is open — but guard anyway.
      if (Date.now() - msg.date * 1000 > 24 * 3600 * 1000) {
        logger.warn(`Skipping reply to ${chatId}: outside 24h business window`);
        return;
      }

      const reply = await generateReply(chatId, text, { attachments });
      if (!reply) return; // auto-reply disabled for this contact / away throttle

      // Human pacing: think, then type each burst.
      await sleep(reply.plan.thinkMs);

      // Voice replies: synthesize the whole reply as one voice note.
      const tts = require('../tools/tts');
      if (reply.voiceReply && tts.available()) {
        try {
          await ctx.api.sendChatAction(chatId, 'record_voice', { business_connection_id: connId }).catch(() => {});
          const fullText = reply.bursts.join('\n\n');
          const { buffer } = await tts.speak(fullText);
          await sleep(Math.min(reply.plan.typeMs, 8000));
          await ctx.api.sendVoice(chatId, new InputFile(buffer, 'voice.ogg'), { business_connection_id: connId });
          logMsg(chatId, 'outgoing', `[voice] ${fullText}`, {
            model: `${reply.result.provider}/${reply.result.model}`,
            tokens: (reply.result.tokensIn || 0) + (reply.result.tokensOut || 0),
            responseTimeMs: Date.now() - receivedAt,
          });
          return;
        } catch (err) {
          logger.warn(`Voice reply failed, sending text instead: ${err.message}`);
        }
      }

      for (let i = 0; i < reply.bursts.length; i++) {
        const burst = reply.bursts[i];
        if (config.getSetting('typing_simulation') === 'on') {
          const typeMs = Math.round(reply.plan.typeMs * (burst.length / reply.bursts.join('').length));
          // Telegram typing indicator lasts ~5s; refresh while "typing".
          const until = Date.now() + Math.min(typeMs, 25000);
          while (Date.now() < until) {
            await ctx.api.sendChatAction(chatId, 'typing', { business_connection_id: connId }).catch(() => {});
            await sleep(Math.min(4500, until - Date.now()));
          }
        }
        await ctx.api.sendMessage(chatId, burst, { business_connection_id: connId });
        logMsg(chatId, 'outgoing', burst, {
          model: `${reply.result.provider}/${reply.result.model}`,
          tokens: (reply.result.tokensIn || 0) + (reply.result.tokensOut || 0),
          responseTimeMs: Date.now() - receivedAt,
        });
        if (i < reply.bursts.length - 1) await sleep(800 + Math.random() * 1500);
      }

      // A tool produced an image (image_gen / qr_code): send it after the text.
      if (reply.photoUrl) {
        try {
          await ctx.api.sendChatAction(chatId, 'upload_photo', { business_connection_id: connId }).catch(() => {});
          await ctx.api.sendPhoto(chatId, reply.photoUrl, { business_connection_id: connId });
          logMsg(chatId, 'outgoing', `[photo] ${reply.photoUrl.slice(0, 150)}`, { model: 'tool' });
        } catch (err) {
          logger.warn(`Photo send failed: ${err.message}`);
        }
      }
    } catch (err) {
      logError('business_message', err);
      logMsg(chatId, 'incoming', msg.text || '[media]', { status: 'error', error: err.message });
      if (config.getSetting('notify_errors') === 'on') {
        await notifyOwner(`⚠️ Failed to reply to ${name}: ${err.message}`);
      }
    } finally {
      queueDepth--;
      events.broadcast('stats', { queueDepth });
    }
  });
  chatLocks.set(chatId, task.catch(() => {}));
  await task.catch(() => {});
}

function createBot() {
  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN not set — bot disabled, web panel still available');
    return null;
  }
  bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.on('business_connection', async (ctx) => {
    const conn = ctx.businessConnection;
    businessConnectionId = conn.id;
    const status = conn.is_enabled === false ? 'disabled' : 'connected';
    db.prepare('INSERT INTO events_log (type, detail) VALUES (?, ?)')
      .run('business_connection', `${status}: ${conn.id} (user ${conn.user?.id})`);
    events.broadcast('connection', { status, id: conn.id });
    logger.info(`Business connection ${status}: ${conn.id}`);
  });

  bot.on('business_message', handleBusinessMessage);

  // Group chats where the bot is a member (separate from Business Mode DMs).
  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    if (!msg || (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup')) return next();
    if (config.getSetting('reply_in_groups') !== 'on') return;
    if (config.getSetting('bot_enabled') !== 'on') return;
    const text = msg.text || msg.caption || '';
    if (!text) return;
    // Mention-only gate: reply only when @mentioned, replied-to, or the agent name is used.
    const agentName = config.getSetting('agent_name').toLowerCase();
    const me = (await bot.api.getMe().catch(() => null))?.username?.toLowerCase();
    const mentioned = (me && text.toLowerCase().includes('@' + me))
      || (agentName && text.toLowerCase().includes(agentName))
      || msg.reply_to_message?.from?.id === ctx.me?.id;
    if (config.getSetting('group_mention_only') === 'on' && !mentioned) return;
    try {
      const reply = await generateReply(msg.chat.id, text, {});
      if (!reply) return;
      await sleep(reply.plan.thinkMs);
      for (const burst of reply.bursts) {
        await ctx.reply(burst, { reply_parameters: { message_id: msg.message_id } });
      }
    } catch (err) {
      logError('group_message', err);
    }
  });

  // Keep conversational context accurate when the other side edits or deletes.
  bot.on('edited_business_message', (ctx) => {
    const msg = ctx.editedBusinessMessage;
    if (!msg || !msg.from || msg.from.id === env.OWNER_USER_ID || !msg.text) return;
    const conversations = require('../memory/conversations');
    conversations.addMessage(msg.chat.id, 'user', `[edited their earlier message to] ${msg.text}`);
    db.prepare('INSERT INTO events_log (type, detail) VALUES (?, ?)')
      .run('message_edited', `chat ${msg.chat.id}: ${msg.text.slice(0, 120)}`);
  });

  bot.on('deleted_business_messages', (ctx) => {
    const del = ctx.deletedBusinessMessages;
    if (!del) return;
    db.prepare('INSERT INTO events_log (type, detail) VALUES (?, ?)')
      .run('messages_deleted', `chat ${del.chat?.id}: ${del.message_ids?.length || 0} message(s) deleted`);
  });

  // Direct DM to the bot itself: owner commands.
  bot.command('start', ctx => ctx.reply(
    'Secretary Pro is running.\n\n' +
    'Connect me: Telegram Settings → Telegram Business → Chatbots → add this bot.\n' +
    `Admin panel: http://localhost:${env.PORT}`
  ));
  bot.command('status', async (ctx) => {
    if (ctx.from?.id !== env.OWNER_USER_ID) return;
    const today = db.prepare("SELECT COUNT(*) c FROM messages_log WHERE created_at >= date('now')").get().c;
    ctx.reply(`✅ Online\nMessages today: ${today}\nAway mode: ${config.getSetting('away_mode')}\nQueue: ${queueDepth}`);
  });
  bot.command('away', async (ctx) => {
    if (ctx.from?.id !== env.OWNER_USER_ID) return;
    const next = config.getSetting('away_mode') === 'on' ? 'off' : 'on';
    config.setSetting('away_mode', next);
    ctx.reply(`Away mode: ${next}`);
  });
  bot.command('summary', async (ctx) => {
    if (ctx.from?.id !== env.OWNER_USER_ID) return;
    const { dailySummaryText } = require('../analytics');
    ctx.reply(dailySummaryText());
  });
  bot.command('id', (ctx) => {
    const fwd = ctx.message?.forward_origin;
    if (fwd?.type === 'user') {
      return ctx.reply(`Forwarded from user id: ${fwd.sender_user.id} (${fwd.sender_user.first_name || ''})`);
    }
    ctx.reply(`Your user id: ${ctx.from?.id}\nThis chat id: ${ctx.chat?.id}`);
  });
  bot.command('pause', (ctx) => {
    if (ctx.from?.id !== env.OWNER_USER_ID) return;
    const next = config.getSetting('bot_enabled') === 'on' ? 'off' : 'on';
    config.setSetting('bot_enabled', next);
    ctx.reply(next === 'on' ? '▶️ Auto-replies resumed' : '⏸ Auto-replies paused (still recording messages)');
  });
  bot.command('help', (ctx) => ctx.reply(
    'Commands:\n' +
    '/status — bot status & today\'s stats\n' +
    '/away — toggle away mode\n' +
    '/pause — pause/resume all auto-replies\n' +
    '/summary — send the daily summary now\n' +
    '/id — show your Telegram id (or forward a message to get its sender id)\n' +
    `Admin panel: http://localhost:${env.PORT}`
  ));

  bot.api.setMyCommands([
    { command: 'status', description: 'Bot status & stats' },
    { command: 'away', description: 'Toggle away mode' },
    { command: 'pause', description: 'Pause/resume auto-replies' },
    { command: 'summary', description: 'Daily summary now' },
    { command: 'id', description: 'Show Telegram id' },
    { command: 'help', description: 'Show commands' },
  ]).catch(err => logger.warn(`setMyCommands failed: ${err.message}`));

  bot.catch((err) => logError('bot', err.error || err));
  return bot;
}

function getBot() { return bot; }
function getBusinessConnectionId() { return businessConnectionId; }
function getQueueDepth() { return queueDepth; }

module.exports = { createBot, getBot, getBusinessConnectionId, getQueueDepth, notifyOwner, logMsg, logError };
