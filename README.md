# Secretary Pro 🤖

A complete **Telegram AI Secretary** — connects to your personal Telegram account via **Business Mode** (no userbot, no API_HASH, just a bot token) and auto-replies to your DMs as you, powered by a multi-provider LLM gateway. Comes with a dark, real-time **web admin panel**.

## Features

- **Telegram Business Mode** — replies appear as you, from your own account
- **Multi-provider LLM gateway** — Gemini, Groq, Mistral, Cohere, OpenRouter, DeepSeek, OpenAI, Anthropic, Together, Perplexity, xAI Grok, Ollama, LM Studio — with fallback chains, load balancing, health monitoring, and per-request token/cost tracking
- **Human typing simulation** — bursty timing, momentum-aware delays, real typing indicators
- **Voice note transcription** (Gemini multimodal) and **image understanding** (vision model routing)
- **Memory** — per-chat history, semantic vector recall, auto-extracted facts, global FAQ knowledge base, auto-summarization
- **Per-contact customization** — tone, rules, blocked topics, VIP priority, custom prompts, relationship learning from real chat transcripts
- **Tools** — web search (Tavily/Brave/SerpAPI/Perplexity/SearXNG/DuckDuckGo), webpage reader, weather, crypto prices, currency conversion, translation, image generation (DALL-E or free Pollinations), QR codes, URL shortener
- **Integrations** — Google Calendar, Gmail (read + panel-initiated send), GitHub notifications, Notion search, Spotify now-playing, YouTube search, Twitter/X search, news
- **Voice both ways** — transcribes incoming voice notes (Gemini or Whisper); per-contact TTS voice replies (ElevenLabs or OpenAI)
- **Skill Library** — installable instruction packs with keyword triggers: built-in starter catalog (one-click install), **GitHub search + one-click install** (READMEs are distilled into skills by the LLM), and **self-skill learning** — the bot studies its own conversations and proposes new skills for your review
- **MCP connector** — plug in any HTTP MCP (Model Context Protocol) server; its tools are auto-discovered and become available to the bot as `mcp:server:tool`
- **Automation** — away mode (manual + scheduled), welcome messages, keyword alerts, scheduled messages, daily summaries, cost/rate-limit/crash alerts, auto-archive of inactive chats, auto-read receipts, master pause switch (`/pause`)
- **Admin panel** — futuristic glass dark UI with animations, mobile-friendly, quick-toggle topbar (auto-reply / away / typing), password login (optional `ADMIN_PASSWORD`), dashboard with live charts, prompt editor with versioning/diff/rollback/presets, custom context blocks, "send now" composer (message/voice/photo/sticker/file/poll), @username→id resolver, message footer/signature, live API key management, full logs + CSV export, backup/restore

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
