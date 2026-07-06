'use strict';
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const { env } = require('./config');

fs.mkdirSync(env.DATA_DIR, { recursive: true });

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, stack }) =>
          `${timestamp} ${level}: ${stack || message}`)
      ),
    }),
    new winston.transports.File({
      filename: path.join(env.DATA_DIR, 'secretary.log'),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

module.exports = logger;
