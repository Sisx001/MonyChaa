'use strict';
// System monitoring: live host/process metrics, self-diagnostics, one-click
// auto-fix actions, and graceful restart.
const os = require('os');
const fs = require('fs');
const db = require('./db/schema');
const logger = require('./logger');
const config = require('./config');

let lastCpu = os.cpus();
let lastCpuAt = Date.now();

function cpuUsagePercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  for (let i = 0; i < now.length; i++) {
    const a = lastCpu[i]?.times || now[i].times;
    const b = now[i].times;
    const dIdle = b.idle - a.idle;
    const dTotal = Object.keys(b).reduce((s, k) => s + (b[k] - a[k]), 0);
    idle += dIdle; total += dTotal;
  }
  lastCpu = now; lastCpuAt = Date.now();
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

function diskInfo() {
  try {
    const stat = fs.statfsSync(config.env.DATA_DIR);
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    return { totalGB: +(total / 1e9).toFixed(1), freeGB: +(free / 1e9).toFixed(1), usedPct: Math.round((1 - free / total) * 100) };
  } catch { return null; }
}

function metrics() {
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    status: 'online',
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    hostname: os.hostname(),
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
    hostUptimeSec: Math.floor(os.uptime()),
    cpu: { cores: os.cpus().length, model: os.cpus()[0]?.model || 'unknown', loadPct: cpuUsagePercent(), load1: +os.loadavg()[0].toFixed(2) },
    memory: {
      rssMB: Math.round(mem.rss / 1e6),
      heapUsedMB: Math.round(mem.heapUsed / 1e6),
      systemUsedPct: Math.round((1 - freeMem / totalMem) * 100),
      systemTotalGB: +(totalMem / 1e9).toFixed(1),
    },
    disk: diskInfo(),
    dbSizeMB: dbSizeMB(),
  };
}

function dbSizeMB() {
  try {
    const p = require('path').join(config.env.DATA_DIR, 'secretary.db');
    return +(fs.statSync(p).size / 1e6).toFixed(1);
  } catch { return 0; }
}

/** Self-diagnostics: returns a list of checks with status + optional fix id. */
function diagnostics() {
  const checks = [];
  const push = (name, ok, detail, fix) => checks.push({ name, status: ok ? 'ok' : 'warn', detail, fix: ok ? null : fix });

  // Bot token present?
  const { getBot } = require('./bot/handlers');
  push('Telegram bot', Boolean(getBot()), getBot() ? 'Running' : 'No TELEGRAM_BOT_TOKEN — bot disabled', null);

  // At least one LLM provider configured?
  const { candidates } = require('./llm/fallback');
  const hasLLM = candidates().length > 0;
  push('LLM provider', hasLLM, hasLLM ? `${candidates().length} in active chain` : 'No provider configured — set an API key', 'open_keys');

  // Any provider marked down?
  const down = db.prepare("SELECT provider FROM provider_health WHERE status = 'down'").all();
  push('Provider health', down.length === 0, down.length ? `Down: ${down.map(d => d.provider).join(', ')}` : 'All healthy', 'reset_health');

  // Recent error spike?
  const errs = db.prepare("SELECT COUNT(*) c FROM error_log WHERE created_at > datetime('now','-1 hour')").get().c;
  push('Error rate', errs < 20, `${errs} errors in the last hour`, 'clear_errors');

  // Stuck pending scheduled messages?
  const stuck = db.prepare("SELECT COUNT(*) c FROM scheduled_messages WHERE status = 'pending' AND send_at < datetime('now','-1 hour')").get().c;
  push('Scheduler', stuck === 0, stuck ? `${stuck} overdue scheduled messages` : 'On time', 'requeue_scheduled');

  // Disk space
  const disk = diskInfo();
  if (disk) push('Disk space', disk.usedPct < 90, `${disk.usedPct}% used, ${disk.freeGB}GB free`, 'vacuum_db');

  // Memory pressure
  const memPct = metrics().memory.systemUsedPct;
  push('Memory', memPct < 92, `${memPct}% system memory used`, null);

  // DB growth
  const size = dbSizeMB();
  push('Database', size < 500, `${size}MB`, 'vacuum_db');

  return checks;
}

/** One-click fixes. Returns a human message. */
function autofix(action) {
  switch (action) {
    case 'reset_health':
      db.prepare('DELETE FROM provider_health').run();
      return 'Provider health reset — will re-evaluate on next call.';
    case 'clear_errors':
      db.prepare("DELETE FROM error_log WHERE created_at < datetime('now','-1 day')").run();
      return 'Old error logs cleared.';
    case 'requeue_scheduled':
      db.prepare("UPDATE scheduled_messages SET send_at = datetime('now') WHERE status = 'pending' AND send_at < datetime('now','-1 hour')").run();
      return 'Overdue scheduled messages requeued for immediate send.';
    case 'vacuum_db': {
      const before = dbSizeMB();
      db.exec('VACUUM');
      return `Database vacuumed (${before}MB → ${dbSizeMB()}MB).`;
    }
    case 'clear_sessions':
      db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
      return 'Expired sessions cleared.';
    case 'fix_all': {
      const msgs = [];
      for (const a of ['reset_health', 'clear_errors', 'requeue_scheduled', 'clear_sessions', 'vacuum_db']) {
        try { msgs.push(autofix(a)); } catch (e) { msgs.push(`${a} failed: ${e.message}`); }
      }
      return msgs.join(' ');
    }
    default:
      throw new Error(`Unknown fix action: ${action}`);
  }
}

/** Graceful restart: exit so the process manager (PM2/Docker/systemd) respawns. */
function restart(reason = 'manual') {
  logger.warn(`Restart requested (${reason}) — exiting for supervisor respawn`);
  db.prepare('INSERT INTO events_log (type, detail) VALUES (?, ?)').run('restart', reason);
  setTimeout(() => process.exit(0), 500);
  return 'Restarting… the process manager will bring it back in a few seconds.';
}

module.exports = { metrics, diagnostics, autofix, restart };
