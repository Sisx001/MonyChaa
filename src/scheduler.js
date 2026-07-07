'use strict';
// Cron jobs: scheduled messages, daily summary, cost alerts, data retention.
const cron = require('node-cron');
const db = require('./db/schema');
const logger = require('./logger');
const config = require('./config');

let alertedCostToday = false;

function start() {
  const { getBot, getBusinessConnectionId, notifyOwner, logMsg } = require('./bot/handlers');

  // Every minute: deliver due scheduled messages (respecting the 24h business window).
  cron.schedule('* * * * *', async () => {
    const due = db.prepare(
      "SELECT * FROM scheduled_messages WHERE status = 'pending' AND send_at <= datetime('now')"
    ).all();
    if (!due.length) return;
    const bot = getBot();
    const connId = getBusinessConnectionId();
    for (const m of due) {
      try {
        if (!bot) throw new Error('bot not running');
        const lastIncoming = db.prepare(
          "SELECT created_at FROM messages_log WHERE chat_id = ? AND direction = 'incoming' ORDER BY id DESC LIMIT 1"
        ).get(m.chat_id);
        const withinWindow = lastIncoming &&
          (Date.now() - new Date(lastIncoming.created_at + 'Z').getTime()) < 24 * 3600 * 1000;
        // Owner chat has no business window; business chats need one.
        const isOwner = m.chat_id === config.env.OWNER_USER_ID;
        if (!isOwner && !withinWindow) throw new Error('outside 24h business window');
        await bot.api.sendMessage(m.chat_id, m.content, isOwner ? {} : { business_connection_id: connId });
        db.prepare("UPDATE scheduled_messages SET status = 'sent' WHERE id = ?").run(m.id);
        logMsg(m.chat_id, 'outgoing', m.content, { model: 'scheduled' });
      } catch (err) {
        db.prepare("UPDATE scheduled_messages SET status = 'failed' WHERE id = ?").run(m.id);
        logger.warn(`Scheduled message ${m.id} failed: ${err.message}`);
      }
    }
  });

  // Every 30 minutes: active-chain provider health checks (opt-in — uses tokens).
  cron.schedule('*/30 * * * *', async () => {
    if (config.getSetting('health_checks') !== 'on') return;
    const { candidates } = require('./llm/fallback');
    const { chatOnce } = require('./llm/gateway');
    for (const { provider, model } of candidates().slice(0, 4)) {
      try {
        await chatOnce(provider, model, [{ role: 'user', content: 'Reply: ok' }], { maxTokens: 5, temperature: 0 });
      } catch (err) {
        logger.warn(`Health check failed for ${provider}/${model}: ${err.message}`);
      }
    }
  });

  // Every 5 minutes: cost spike alert.
  cron.schedule('*/5 * * * *', async () => {
    const threshold = Number(config.getSetting('cost_alert_threshold')) || 0;
    if (threshold <= 0) return;
    const cost = db.prepare(
      "SELECT COALESCE(SUM(cost_estimate),0) s FROM token_usage WHERE created_at >= date('now')"
    ).get().s;
    if (cost >= threshold && !alertedCostToday) {
      alertedCostToday = true;
      await notifyOwner(`💸 Cost alert: today's LLM spend is $${cost.toFixed(2)} (threshold $${threshold})`);
    }
  });

  // Daily summary at the configured time (checked each minute against local tz).
  cron.schedule('* * * * *', async () => {
    if (config.getSetting('daily_summary') !== 'on') return;
    const tz = config.getSetting('timezone') || 'UTC';
    const now = new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    // Normalize user input like "9:5" to "09:05" so the comparison can match.
    const configured = (config.getSetting('daily_summary_time') || '21:00')
      .split(':').map(p => p.padStart(2, '0')).join(':');
    if (now !== configured) return;
    const { dailySummaryText } = require('./analytics');
    await notifyOwner(dailySummaryText());
  });

  // Nightly: auto-archive conversations inactive for N days — compress the
  // history into a long-term memory, then clear the raw messages.
  cron.schedule('0 4 * * *', async () => {
    const days = Number(config.getSetting('auto_archive_days')) || 0;
    if (days <= 0) return;
    const stale = db.prepare(`
      SELECT chat_id, COUNT(*) c, MAX(created_at) latest FROM conversations
      GROUP BY chat_id HAVING latest < datetime('now', ?) AND c > 5
    `).all(`-${days} days`);
    for (const row of stale) {
      try {
        const { chat } = require('./llm/fallback');
        const vector = require('./memory/vector');
        const msgs = db.prepare('SELECT role, content FROM conversations WHERE chat_id = ? ORDER BY id').all(row.chat_id);
        const transcript = msgs.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 24000);
        const result = await chat([
          { role: 'system', content: 'Summarize this conversation into a compact brief preserving all important facts, names, dates and commitments. Output only the summary.' },
          { role: 'user', content: transcript },
        ], { maxTokens: 400, temperature: 0.2 });
        await vector.remember(row.chat_id, `[Archived conversation summary] ${result.text}`, 'important');
        db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(row.chat_id);
        db.prepare('INSERT INTO events_log (type, detail) VALUES (?, ?)')
          .run('auto_archive', `Archived ${row.c} messages from chat ${row.chat_id}`);
        logger.info(`Auto-archived chat ${row.chat_id} (${row.c} messages)`);
      } catch (err) {
        logger.warn(`Auto-archive failed for chat ${row.chat_id}: ${err.message}`);
      }
    }
  });

  // Nightly: retention cleanup + reset cost alert flag.
  cron.schedule('0 3 * * *', () => {
    alertedCostToday = false;
    const days = Number(config.getSetting('data_retention_days')) || 0;
    if (days <= 0) return;
    const tables = ['conversations', 'messages_log', 'token_usage', 'error_log', 'events_log'];
    for (const t of tables) {
      const info = db.prepare(`DELETE FROM ${t} WHERE created_at < datetime('now', ?)`).run(`-${days} days`);
      if (info.changes) logger.info(`Retention: purged ${info.changes} rows from ${t}`);
    }
  });

  logger.info('Scheduler started');
}

module.exports = { start };
