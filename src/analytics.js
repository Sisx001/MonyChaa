'use strict';
// Stats, token tracking and cost aggregation for the dashboard.
const db = require('./db/schema');

const startedAt = Date.now();

function stats() {
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const msgsToday = one("SELECT COUNT(*) c FROM messages_log WHERE created_at >= date('now')").c;
  const msgsWeek = one("SELECT COUNT(*) c FROM messages_log WHERE created_at >= date('now', '-7 days')").c;
  const msgsMonth = one("SELECT COUNT(*) c FROM messages_log WHERE created_at >= date('now', '-30 days')").c;
  const activeChats = one("SELECT COUNT(DISTINCT chat_id) c FROM messages_log WHERE created_at >= date('now', '-1 day')").c;
  const avgResponse = one("SELECT AVG(response_time_ms) a FROM messages_log WHERE direction = 'outgoing' AND response_time_ms > 0 AND created_at >= date('now', '-7 days')").a || 0;
  const incoming = one("SELECT COUNT(*) c FROM messages_log WHERE direction = 'incoming' AND created_at >= date('now', '-7 days')").c;
  const outgoing = one("SELECT COUNT(*) c FROM messages_log WHERE direction = 'outgoing' AND created_at >= date('now', '-7 days')").c;
  const errorsToday = one("SELECT COUNT(*) c FROM error_log WHERE created_at >= date('now')").c;

  const costToday = one("SELECT COALESCE(SUM(cost_estimate),0) s FROM token_usage WHERE created_at >= date('now')").s;
  const costTotal = one('SELECT COALESCE(SUM(cost_estimate),0) s FROM token_usage').s;
  const tokensToday = one("SELECT COALESCE(SUM(tokens_in + tokens_out),0) s FROM token_usage WHERE created_at >= date('now')").s;

  const perProvider = db.prepare(`
    SELECT provider,
      SUM(tokens_in) tokens_in, SUM(tokens_out) tokens_out, SUM(cost_estimate) cost,
      SUM(CASE WHEN created_at >= date('now') THEN tokens_in + tokens_out ELSE 0 END) tokens_today,
      SUM(CASE WHEN created_at >= date('now') THEN cost_estimate ELSE 0 END) cost_today
    FROM token_usage GROUP BY provider ORDER BY cost DESC
  `).all();

  const perHour = db.prepare(`
    SELECT strftime('%H', created_at) hour, COUNT(*) count
    FROM messages_log WHERE created_at >= datetime('now', '-24 hours')
    GROUP BY hour ORDER BY hour
  `).all();

  const topContacts = db.prepare(`
    SELECT m.chat_id, COALESCE(c.name, c.username, m.chat_id) name, COUNT(*) count
    FROM messages_log m LEFT JOIN contacts c ON c.chat_id = m.chat_id AND c.assistant_id = m.assistant_id
    WHERE m.created_at >= date('now', '-30 days')
    GROUP BY m.chat_id ORDER BY count DESC LIMIT 10
  `).all();

  // Per-assistant message breakdown (today), labelled by assistant name.
  const perAssistant = db.prepare(`
    SELECT m.assistant_id id,
      COALESCE(a.name, CASE WHEN m.assistant_id = 0 THEN 'Primary' ELSE 'assistant ' || m.assistant_id END) name,
      COUNT(*) count
    FROM messages_log m LEFT JOIN assistants a ON a.id = m.assistant_id
    WHERE m.created_at >= date('now') GROUP BY m.assistant_id ORDER BY count DESC
  `).all();

  const health = db.prepare('SELECT * FROM provider_health ORDER BY provider').all();

  return {
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    msgsToday, msgsWeek, msgsMonth, activeChats,
    avgResponseMs: Math.round(avgResponse),
    responseRate: incoming ? Math.round((outgoing / incoming) * 100) : 0,
    errorsToday,
    costToday, costTotal, tokensToday,
    perProvider, perHour, topContacts, perAssistant, health,
  };
}

function dailySummaryText() {
  const s = stats();
  const newContacts = db.prepare("SELECT COUNT(*) c FROM contacts WHERE created_at >= date('now')").get().c;
  return [
    '📊 Daily Summary',
    `Messages today: ${s.msgsToday}`,
    `Active chats: ${s.activeChats}`,
    `New contacts: ${newContacts}`,
    `Avg response: ${(s.avgResponseMs / 1000).toFixed(1)}s`,
    `Tokens: ${s.tokensToday.toLocaleString()} · Cost: $${s.costToday.toFixed(4)}`,
    s.errorsToday ? `⚠️ Errors: ${s.errorsToday}` : '✅ No errors',
  ].join('\n');
}

module.exports = { stats, dailySummaryText };
