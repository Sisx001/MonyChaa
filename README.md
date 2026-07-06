# Secretary Pro 🤖

A complete **Telegram AI Secretary** — connects to your personal Telegram account via **Business Mode** (no userbot, no API_HASH, just a bot token) and auto-replies to your DMs as you, powered by a multi-provider LLM gateway. Comes with a dark, real-time **web admin panel**.

## Features

- **Telegram Business Mode** — replies appear as you, from your own account
- **Multi-provider LLM gateway** — Gemini, Groq, Mistral, Cohere, OpenRouter, DeepSeek, OpenAI, Anthropic, Together, Perplexity, xAI Grok, Ollama, LM Studio — with fallback chains, load balancing, health monitoring, and per-request token/cost tracking
- **Human typing simulation** — bursty timing, momentum-aware delays, real typing indicators
- **Voice note transcription** (Gemini multimodal) and **image understanding** (vision model routing)
- **Memory** — per-chat history, semantic vector recall, auto-extracted facts, global FAQ knowledge base, auto-summarization
- **Per-contact customization** — tone, rules, blocked topics, VIP priority, custom prompts, relationship learning from real chat transcripts
- **Tools** — web search (Tavily/Brave/SerpAPI/SearXNG/DuckDuckGo), weather, crypto prices, currency conversion, translation, Google Calendar, news
- **Automation** — away mode (manual + scheduled), welcome messages, keyword alerts, scheduled messages, daily summaries, cost alerts
- **Admin panel** — dashboard with live charts, prompt editor with versioning/diff/rollback/presets, full logs, backup/restore

## Quickstart

```bash
cp .env.example .env
# Fill in: TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, OWNER_USER_ID
npm install && npm start
# Open http://localhost:3000
```

Then connect the bot to your account:

1. **@BotFather** → your bot → Bot Settings → **Business Mode** → Enable
2. Telegram → Settings → **Telegram Business** → **Chatbots** → add your bot

That's it. Incoming DMs are now auto-answered as you. The web panel works even without a bot token (for configuration).

## Configuration

Everything is configurable live from the panel at `http://localhost:3000` — system prompt, model routing, contacts, memory, tools, automation, alerts. API keys live in `.env` (see `.env.example`; only `TELEGRAM_BOT_TOKEN` + `GEMINI_API_KEY` are required).

Useful owner commands (DM your bot directly): `/status`, `/away`.

## Deployment

**Docker:**
```bash
docker compose up -d --build
```

**PM2:**
```bash
npm i -g pm2
pm2 start ecosystem.config.js
```

Data (SQLite DB, logs) persists in `./data/`. Health check at `GET /health`. Graceful shutdown on SIGINT/SIGTERM.

## Architecture

```
src/
├── index.js           # entry: bot + web server + scheduler
├── config.js          # env + DB-backed settings
├── bot/               # grammY Business Mode handlers, reply pipeline, typing simulation
├── llm/               # provider registry, gateway (OpenAI/Gemini/Anthropic/Cohere), fallback chain
├── memory/            # conversation history, vector memory, facts KB
├── tools/             # web search, weather, TTS, calendar, tool auto-invocation
├── web/               # Express API, SSE events, admin panel SPA
├── db/schema.js       # SQLite schema
├── analytics.js       # stats + cost aggregation
└── scheduler.js       # cron: scheduled messages, summaries, retention
```
