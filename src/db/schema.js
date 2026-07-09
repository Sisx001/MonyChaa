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

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  description TEXT,
  triggers TEXT DEFAULT '[]',   -- JSON array of keywords; empty = always active
  content TEXT,                 -- instructions injected into the system prompt
  enabled INTEGER DEFAULT 1,
  source TEXT DEFAULT 'manual', -- manual | catalog | github | self-learned
  uses INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  url TEXT,
  headers TEXT DEFAULT '{}',    -- JSON: extra HTTP headers (auth etc.)
  enabled INTEGER DEFAULT 1,
  status TEXT DEFAULT 'new',    -- new | connected | error
  tools_json TEXT DEFAULT '[]', -- discovered tools cache
  last_error TEXT,
  last_connected TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  pass_hash TEXT,               -- scrypt: salt:hash
  role TEXT DEFAULT 'admin',    -- owner | admin | viewer
  enabled INTEGER DEFAULT 1,
  totp_secret TEXT,             -- optional 2FA (base32)
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT,
  last_ip TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  last_seen TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  ip TEXT,
  country TEXT,
  success INTEGER DEFAULT 0,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, created_at);

CREATE TABLE IF NOT EXISTS banned_ips (
  ip TEXT PRIMARY KEY,
  reason TEXT,
  country TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  action TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- Multi-tenancy: each assistant is an isolated bot with its own token, owner,
-- prompt and settings overlay. assistant_id 0 is the primary (env) bot.
CREATE TABLE IF NOT EXISTS assistants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  bot_token TEXT,
  owner_user_id INTEGER,
  admin_user_id INTEGER,        -- which panel account owns this assistant
  enabled INTEGER DEFAULT 1,
  system_prompt TEXT,
  settings_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'stopped', -- stopped | running | error
  username TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS snippets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  content TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Keyword-triggered instant replies that short-circuit the LLM (0 cost).
CREATE TABLE IF NOT EXISTS autoresponders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT,
  match_type TEXT DEFAULT 'contains',  -- contains | exact | starts | regex
  reply TEXT,
  enabled INTEGER DEFAULT 1,
  uses INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  body TEXT,
  pinned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

// Additive migrations for existing databases.
const contactCols = db.prepare('PRAGMA table_info(contacts)').all().map(c => c.name);
if (!contactCols.includes('voice_replies')) {
  db.exec('ALTER TABLE contacts ADD COLUMN voice_replies INTEGER DEFAULT 0');
}

// assistant_id scoping columns (default 0 = primary bot).
for (const table of ['contacts', 'conversations', 'memories', 'messages_log', 'scheduled_messages', 'facts']) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes('assistant_id')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN assistant_id INTEGER DEFAULT 0`);
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_conv_assistant ON conversations(assistant_id, chat_id, id)');

// Contacts need a composite (chat_id, assistant_id) key so the same chat_id can
// exist independently under different assistants. Rebuild once if still single-PK.
const contactPk = db.prepare('PRAGMA table_info(contacts)').all().filter(c => c.pk).map(c => c.name);
if (contactPk.length === 1 && contactPk[0] === 'chat_id') {
  db.exec(`
    CREATE TABLE contacts_new (
      chat_id INTEGER,
      assistant_id INTEGER DEFAULT 0,
      username TEXT, name TEXT, relationship TEXT,
      tone TEXT DEFAULT 'casual', gender TEXT, rules TEXT DEFAULT '[]',
      auto_reply INTEGER DEFAULT 1, delay_multiplier REAL DEFAULT 1.0,
      max_length INTEGER, blocked_topics TEXT DEFAULT '[]', priority INTEGER DEFAULT 0,
      learned_tone TEXT, custom_prompt TEXT, notes TEXT, voice_replies INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, assistant_id)
    );
    INSERT INTO contacts_new (chat_id, assistant_id, username, name, relationship, tone, gender,
      rules, auto_reply, delay_multiplier, max_length, blocked_topics, priority, learned_tone,
      custom_prompt, notes, voice_replies, created_at, updated_at)
      SELECT chat_id, COALESCE(assistant_id,0), username, name, relationship, tone, gender,
      rules, auto_reply, delay_multiplier, max_length, blocked_topics, priority, learned_tone,
      custom_prompt, notes, COALESCE(voice_replies,0), created_at, updated_at FROM contacts;
    DROP TABLE contacts;
    ALTER TABLE contacts_new RENAME TO contacts;
  `);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_contacts_assistant ON contacts(assistant_id)');

// Contact tags (comma-separated) for segmentation — after the composite-key
// rebuild so the column survives.
{
  const cols = db.prepare('PRAGMA table_info(contacts)').all().map(c => c.name);
  if (!cols.includes('tags')) db.exec("ALTER TABLE contacts ADD COLUMN tags TEXT DEFAULT ''");
}

bindDb(db);

module.exports = db;
