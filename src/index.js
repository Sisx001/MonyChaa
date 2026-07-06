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

  const bot = createBot();
  if (bot) {
    // Business Mode requires these allowed_updates explicitly.
    bot.start({
      allowed_updates: [
        'message', 'business_connection', 'business_message',
        'edited_business_message', 'deleted_business_messages',
      ],
      onStart: (info) => logger.info(`Bot @${info.username} polling. Enable Business Mode in @BotFather, then connect it in Telegram Settings → Telegram Business → Chatbots.`),
    }).catch(err => logError('bot_start', err));
  }

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
  process.on('uncaughtException', (err) => logError('uncaughtException', err));
  process.on('unhandledRejection', (err) => logError('unhandledRejection', err instanceof Error ? err : new Error(String(err))));
}

main().catch(err => {
  logger.error(err.stack || err.message);
  process.exit(1);
});
