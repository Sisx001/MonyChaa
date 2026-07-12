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

  // Daily message volume for the last 14 days (fills gaps with 0 in JS).
  const volRows = db.prepare(`
    SELECT date(created_at) day,
      SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) incoming,
      SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) outgoing
    FROM messages_log WHERE created_at >= date('now', '-13 days')
    GROUP BY day
  `).all();
  const volMap = Object.fromEntries(volRows.map(r => [r.day, r]));
  const dailyVolume = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const r = volMap[d] || {};
    dailyVolume.push({ day: d.slice(5), incoming: r.incoming || 0, outgoing: r.outgoing || 0 });
  }

  const health = db.prepare('SELECT * FROM provider_health ORDER BY provider').all();

  return {
    dailyVolume,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    msgsToday, msgsWeek, msgsMonth, activeChats,
    avgResponseMs: Math.round(avgResponse),
    responseRate: incoming ? Math.round((outgoing / incoming) * 100) : 0,
    errorsToday,
    costToday, costTotal, tokensToday,
    perProvider, perHour, topContacts, perAssistant, health,
  };
}

/** Classify recent incoming messages by detected mood (last N, default 300). */
function moodBreakdown(limit = 300) {
  const { detect } = require('./bot/mood');
  const rows = db.prepare(
    "SELECT content FROM messages_log WHERE direction = 'incoming' AND content IS NOT NULL AND content != '' ORDER BY id DESC LIMIT ?"
  ).all(limit);
  const counts = { upset: 0, sad: 0, anxious: 0, grateful: 0, confused: 0, excited: 0, neutral: 0 };
  for (const r of rows) {
    const { mood } = detect(r.content);
    counts[mood] = (counts[mood] || 0) + 1;
  }
  const total = rows.length;
  const nonNeutral = total - counts.neutral;
  return {
    total,
    counts,
    // Share of messages carrying a readable emotional signal.
    expressiveness: total ? Math.round((nonNeutral / total) * 100) : 0,
  };
}

/** Interaction stats for one contact: volumes, first/last seen, response rate. */
function contactStats(chatId, assistantId = 0) {
  const row = db.prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) incoming,
      SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) outgoing,
      MIN(created_at) firstSeen,
      MAX(created_at) lastSeen,
      AVG(CASE WHEN direction = 'outgoing' AND response_time_ms > 0 THEN response_time_ms END) avgResponseMs
    FROM messages_log WHERE chat_id = ? AND assistant_id = ?`).get(chatId, assistantId);
  const incoming = row.incoming || 0, outgoing = row.outgoing || 0;
  const days = row.firstSeen
    ? Math.max(1, Math.round((Date.parse(row.lastSeen + 'Z') - Date.parse(row.firstSeen + 'Z')) / 86400000) + 1)
    : 0;
  return {
    total: row.total || 0, incoming, outgoing,
    firstSeen: row.firstSeen || null, lastSeen: row.lastSeen || null,
    responseRate: incoming ? Math.min(100, Math.round((outgoing / incoming) * 100)) : 0,
    avgResponseMs: Math.round(row.avgResponseMs || 0),
    activeDays: days,
    msgsPerDay: days ? Math.round(((row.total || 0) / days) * 10) / 10 : 0,
  };
}

/** A single contact's dominant mood over their recent incoming messages. */
function contactMoodProfile(chatId, assistantId = 0, limit = 40) {
  const { detect } = require('./bot/mood');
  const rows = db.prepare(
    "SELECT content FROM messages_log WHERE chat_id = ? AND assistant_id = ? AND direction = 'incoming' AND content IS NOT NULL AND content != '' ORDER BY id DESC LIMIT ?"
  ).all(chatId, assistantId, limit);
  const counts = {};
  for (const r of rows) {
    const { mood } = detect(r.content);
    counts[mood] = (counts[mood] || 0) + 1;
  }
  // Dominant *non-neutral* mood, only if it's a real pattern (>=3 and >=30%).
  let dominant = null, best = 0;
  const total = rows.length;
  for (const [mood, n] of Object.entries(counts)) {
    if (mood === 'neutral') continue;
    if (n > best) { best = n; dominant = mood; }
  }
  if (!dominant || best < 3 || best / (total || 1) < 0.3) dominant = null;
  return { total, counts, dominant };
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

module.exports = { stats, dailySummaryText, moodBreakdown, contactMoodProfile, contactStats };
