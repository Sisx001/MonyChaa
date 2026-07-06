'use strict';
// SQLite schema + migrations. Single source of truth for all persistent state.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { env, bindDb } = require('../config');

fs.mkdirSync(env.DATA_DIR, { recursive: true });

const db = new Database(path.join(env.DATA_DIR, 'secretary.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
  chat_id INTEGER PRIMARY KEY,
  username TEXT,
  name TEXT,
  relationship TEXT,
  tone TEXT DEFAULT 'casual',
  gender TEXT,
  rules TEXT DEFAULT '[]',
  auto_reply INTEGER DEFAULT 1,
  delay_multiplier REAL DEFAULT 1.0,
  max_length INTEGER,
  blocked_topics TEXT DEFAULT '[]',
  priority INTEGER DEFAULT 0,
  learned_tone TEXT,
  custom_prompt TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE,
  value TEXT,
  priority TEXT DEFAULT 'casual',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,
  role TEXT,
  content TEXT,
  tokens INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_chat ON conversations(chat_id, id);

CREATE TABLE IF NOT EXISTS messages_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,
  direction TEXT,
  content TEXT,
  model TEXT,
  tokens_used INTEGER DEFAULT 0,
  response_time_ms INTEGER DEFAULT 0,
  status TEXT DEFAULT 'ok',
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msglog_chat ON messages_log(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_msglog_created ON messages_log(created_at);

CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT,
  model TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_estimate REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tokusage_created ON token_usage(created_at);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT DEFAULT 'unknown',
  latency_ms INTEGER DEFAULT 0,
  error_rate REAL DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  last_error TEXT,
  last_check TEXT
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  content TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,
  content TEXT,
  priority TEXT DEFAULT 'casual',
  embedding TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,
  content TEXT,
  send_at TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  message TEXT,
  stack TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Additive migrations for existing databases.
const contactCols = db.prepare('PRAGMA table_info(contacts)').all().map(c => c.name);
if (!contactCols.includes('voice_replies')) {
  db.exec('ALTER TABLE contacts ADD COLUMN voice_replies INTEGER DEFAULT 0');
}

bindDb(db);

module.exports = db;
