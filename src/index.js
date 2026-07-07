'use strict';
// Main entry: starts the Telegram Business bot + web admin panel.
require('./db/schema'); // initialize DB first (binds settings storage)
const logger = require('./logger');
const { env } = require('./config');
const { createBot, logError } = require('./bot/handlers');
const { createServer } = require('./web/server');
const scheduler = require('./scheduler');

async function main() {
  logger.info('Secretary Pro starting…');

  const server = createServer();
  scheduler.start();

  // Primary bot (env token) starts itself; then boot any additional assistants.
  const bot = createBot();
  require('./assistants').startAll().catch(err => logError('assistants_start', err));

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down gracefully…`);
    try { if (bot) await bot.stop(); } catch (err) { logger.warn(err.message); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Crash alerts to the owner, throttled to once per 10 minutes.
  let lastCrashAlert = 0;
  const crashAlert = (err) => {
    if (Date.now() - lastCrashAlert < 10 * 60000) return;
    lastCrashAlert = Date.now();
    const { notifyOwner } = require('./bot/handlers');
    notifyOwner(`🔥 Bot error: ${err.message}`.slice(0, 500)).catch(() => {});
  };
  process.on('uncaughtException', (err) => { logError('uncaughtException', err); crashAlert(err); });
  process.on('unhandledRejection', (err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    logError('unhandledRejection', e);
    crashAlert(e);
  });
}

main().catch(err => {
  logger.error(err.stack || err.message);
  process.exit(1);
});
