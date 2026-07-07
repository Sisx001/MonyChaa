'use strict';
// Central config: environment variables + DB-backed settings with defaults.
require('dotenv').config();

const env = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  OWNER_USER_ID: Number(process.env.OWNER_USER_ID || 0),
  OWNER_TIMEZONE: process.env.OWNER_TIMEZONE || 'UTC',
  PORT: Number(process.env.PORT || 3000),

  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  TOGETHER_API_KEY: process.env.TOGETHER_API_KEY || '',
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY || '',
  XAI_API_KEY: process.env.XAI_API_KEY || '',
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
  COHERE_API_KEY: process.env.COHERE_API_KEY || '',
  OLLAMA_URL: process.env.OLLAMA_URL || '',
  LMSTUDIO_URL: process.env.LMSTUDIO_URL || '',

  SEARXNG_URL: process.env.SEARXNG_URL || '',
  SERPAPI_KEY: process.env.SERPAPI_KEY || '',
  BRAVE_SEARCH_KEY: process.env.BRAVE_SEARCH_KEY || '',
  TAVILY_API_KEY: process.env.TAVILY_API_KEY || '',
  WEATHER_API_KEY: process.env.WEATHER_API_KEY || '',
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
  NEWSAPI_KEY: process.env.NEWSAPI_KEY || '',
  DEEPL_API_KEY: process.env.DEEPL_API_KEY || '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN || '',
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  NOTION_TOKEN: process.env.NOTION_TOKEN || '',
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || '',
  TWITTER_BEARER_TOKEN: process.env.TWITTER_BEARER_TOKEN || '',
  SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID || '',
  SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET || '',
  SPOTIFY_REFRESH_TOKEN: process.env.SPOTIFY_REFRESH_TOKEN || '',

  DATA_DIR: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
};

// Settings stored in SQLite (editable via web panel). Defaults below.
const SETTING_DEFAULTS = {
  system_prompt:
    "You are my personal secretary replying on my behalf in Telegram DMs. " +
    "Reply naturally in my voice — concise, warm, human. Match the sender's language. " +
    "Never reveal you are an AI unless I have said so. If asked something you can't answer for me, " +
    "say you'll get back to them.",
  timezone: env.OWNER_TIMEZONE,
  language: 'auto',
  max_response_length: '800',
  typing_simulation: 'on',
  typing_speed: 'medium', // slow | medium | fast
  away_mode: 'off',
  away_message: "I'm away right now — I'll get back to you soon!",
  away_schedule_start: '', // HH:MM, empty = disabled
  away_schedule_end: '',
  auto_reply_default: 'on',
  primary_provider: 'gemini',
  primary_model: 'gemini-2.5-flash',
  fallback_chain: JSON.stringify([
    { provider: 'gemini', model: 'gemini-2.5-flash' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  ]),
  load_balancing: 'off',
  history_limit: '30',
  vector_memory: 'on',
  memory_isolation: 'on', // share facts between contacts? on = isolated per-chat memories, facts always global
  auto_extract_facts: 'on',
  auto_summarize_threshold: '120', // messages before auto-summarization
  data_retention_days: '0', // 0 = keep forever
  daily_summary: 'on',
  daily_summary_time: '21:00',
  cost_alert_threshold: '5', // USD per day
  keyword_triggers: JSON.stringify(['urgent', 'emergency', 'asap']),
  welcome_message: '',
  notify_new_contact: 'on',
  notify_errors: 'on',
  auto_search: 'on',
  active_preset: 'Custom',
  // Custom context blocks injected into the system prompt (10-min cache).
  inject_weather_city: '', // empty = off
  inject_news: 'off',
  inject_calendar: 'off',
  // Auto-archive: summarize + clear conversations inactive for N days (0 = off).
  auto_archive_days: '0',
  rate_limit_alerts: 'on',
  // Periodic provider health checks (each check spends a few tokens).
  health_checks: 'off',
};

// API keys manageable from the admin panel (stored in DB, env is fallback).
const KEY_NAMES = [
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY',
  'OPENROUTER_API_KEY', 'TOGETHER_API_KEY', 'DEEPSEEK_API_KEY', 'PERPLEXITY_API_KEY',
  'XAI_API_KEY', 'MISTRAL_API_KEY', 'COHERE_API_KEY',
  'SEARXNG_URL', 'SERPAPI_KEY', 'BRAVE_SEARCH_KEY', 'TAVILY_API_KEY',
  'WEATHER_API_KEY', 'ELEVENLABS_API_KEY', 'NEWSAPI_KEY', 'DEEPL_API_KEY',
  'GITHUB_TOKEN', 'NOTION_TOKEN', 'YOUTUBE_API_KEY', 'TWITTER_BEARER_TOKEN',
  'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
];

let db = null;
function bindDb(database) { db = database; }

const cache = new Map();

function getSetting(key) {
  if (cache.has(key)) return cache.get(key);
  let value = SETTING_DEFAULTS[key] !== undefined ? SETTING_DEFAULTS[key] : '';
  if (db) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row) value = row.value;
  }
  cache.set(key, value);
  return value;
}

function setSetting(key, value) {
  const v = String(value);
  if (db) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, v);
  }
  cache.set(key, v);
}

function allSettings() {
  const out = { ...SETTING_DEFAULTS };
  if (db) {
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
      // API keys are never exposed through the settings API — see /api/keys.
      if (!row.key.startsWith('apikey_')) out[row.key] = row.value;
    }
  }
  return out;
}

function getJSON(key, fallback) {
  try { return JSON.parse(getSetting(key)); } catch { return fallback; }
}

/**
 * Resolve an API key/credential: DB-stored value (set from the admin panel)
 * takes precedence, then the environment variable.
 */
function key(name) {
  if (db) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('apikey_' + name);
    if (row && row.value) return row.value;
  }
  return env[name] || '';
}

function setKey(name, value) {
  if (!KEY_NAMES.includes(name)) throw new Error(`Unknown key: ${name}`);
  if (value) setSetting('apikey_' + name, value);
  else if (db) { db.prepare('DELETE FROM settings WHERE key = ?').run('apikey_' + name); cache.delete('apikey_' + name); }
}

module.exports = { env, SETTING_DEFAULTS, KEY_NAMES, bindDb, getSetting, setSetting, allSettings, getJSON, key, setKey };
