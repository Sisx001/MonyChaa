# Secretary Pro 🤖

A complete **Telegram AI Secretary** — it connects to your **personal** Telegram account through **Business Mode** (no userbot, no `API_HASH`, just a bot token) and auto-replies to your DMs **as you**, powered by a multi-provider LLM gateway. It ships with a dark, glassy, real-time **web admin panel** that controls every part of it.

> Two processes, one command: a **grammY bot** (Telegram Business handlers) and an **Express + SQLite web panel** at `http://localhost:3000`.

---

## Table of contents

1. [How it works](#1-how-it-works)
2. [Feature overview](#2-feature-overview)
3. [Requirements](#3-requirements)
4. [Installation](#4-installation)
5. [Connect the bot to Telegram](#5-connect-the-bot-to-telegram)
6. [The admin panel — tab by tab](#6-the-admin-panel--tab-by-tab)
7. [Customization A–Z (every setting)](#7-customization-az-every-setting)
8. [Human-behavior engine](#8-human-behavior-engine)
9. [Preloaded characters](#9-preloaded-characters)
10. [Model gateway & providers](#10-model-gateway--providers)
11. [Skills, tools & MCP](#11-skills-tools--mcp)
12. [Memory](#12-memory)
13. [Contacts](#13-contacts)
14. [Multiple assistants (multi-tenant)](#14-multiple-assistants-multi-tenant)
15. [Configure & command from Telegram](#15-configure--command-from-telegram)
16. [Security & sessions](#16-security--sessions)
17. [Monitoring & self-healing](#17-monitoring--self-healing)
18. [Automation & scheduling](#18-automation--scheduling)
19. [Backup & restore](#19-backup--restore)
20. [Environment variables](#20-environment-variables)
21. [Deployment](#21-deployment)
22. [Architecture](#22-architecture)
23. [Troubleshooting & FAQ](#23-troubleshooting--faq)
24. [Tech stack](#24-tech-stack)

---

## 1. How it works

Telegram **Business Mode** lets a bot answer the DMs of a real account. You enable Business Mode on your bot in @BotFather, then add the bot as a "Chatbot" in your Telegram Business settings. From that moment, every incoming DM is delivered to the bot, which:

1. **Identifies the contact** and loads their profile (tone, rules, VIP status, custom prompt, history).
2. **Gathers context** — recent conversation, semantic memories, known facts, live tool output, active skills, the sender's detected mood, and the time of day.
3. **Assembles a system prompt** from all of the above and calls your primary LLM (with automatic fallback to other providers on error/rate-limit).
4. **Post-processes** the reply (strip markdown, redact phone numbers, humanize it, add a signature/footer) and **sends it as you**, with human-like typing delays and optional multi-message "double-texting."

Everything — the prompt, the models, the memory, the tools, the behavior — is controlled live from the web panel, or from Telegram itself.

---

## 2. Feature overview

**Core**
- **Telegram Business Mode** — replies appear from your own account, no userbot.
- **Multi-provider LLM gateway** — 13 providers normalized behind one interface, with fallback chains, load balancing, health tracking, and per-request token/cost accounting.
- **Human typing simulation** — bursty, momentum-aware delays and real typing indicators.
- **Voice + vision** — transcribes incoming voice notes (Gemini/Whisper); routes images to vision models; optional per-contact TTS voice replies (ElevenLabs/OpenAI).

**Intelligence**
- **Memory** — per-chat history, semantic vector recall, auto-extracted facts, a global FAQ knowledge base, and auto-summarization of long threads.
- **Human-behavior engine** — texts like a person (contractions, casual punctuation), never reveals it's an AI, bans assistant filler, adds subtle output imperfections, adapts to the sender's **mood** (6 states) and **local time of day**.
- **Skills** — installable instruction packs with keyword triggers: a starter catalog, **GitHub search + one-click install**, and **self-learning** from your own conversations.
- **Tools** — 110 built-ins: web search, webpage reader, weather, crypto, currency, translation, image generation, QR, calculators, converters and more — auto-invoked when a message needs them.
- **MCP** — plug in any HTTP MCP server; its tools are discovered and become `mcp:server:tool`.

**Control & operations**
- **Web admin panel** — glassmorphism dark/light UI, live charts, ⌘K command palette, a ChatGPT-style playground, prompt versioning/diff/rollback, ~100 wired settings.
- **Multiple assistants** — run several bots at once, each with its own token, persona and fully isolated brain.
- **Security** — multi-user accounts (owner/admin/viewer), scrypt hashing, TOTP 2FA, brute-force lockout, IP bans with country flags, device/session management, spoof-resistant IP handling, strict CSP, per-IP rate limiting, audit log.
- **Monitoring & self-healing** — live CPU/memory/disk/DB meters, health diagnostics with one-click auto-fix, sender-mood mix, graceful restart.
- **Automation** — away mode (manual + scheduled), quiet hours, business hours, reply probability, keyword alerts, scheduled/recurring messages, daily summaries, cost/rate-limit/crash alerts, auto-archive.

---

## 3. Requirements

- **Node.js 18+** (uses `node:test`, `fetch`, better-sqlite3).
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather).
- At least one **LLM API key** — [Gemini](https://aistudio.google.com) is free and recommended as the default.
- A Telegram account on a plan that supports **Telegram Business** (available to all users in most regions).

Everything else (SQLite, the web server, the scheduler) is bundled — no external database or services required.

---

## 4. Installation

```bash
# 1. Clone and enter
git clone https://github.com/Sisx001/MonyChaa.git
cd MonyChaa

# 2. Configure
cp .env.example .env
#   Edit .env and fill in at least:
#     TELEGRAM_BOT_TOKEN   – from @BotFather
#     GEMINI_API_KEY       – free at aistudio.google.com
#     OWNER_USER_ID        – your numeric Telegram id (DM the bot /id once running)
#     OWNER_TIMEZONE       – e.g. Asia/Singapore
#     ADMIN_PASSWORD       – locks the web panel (strongly recommended)

# 3. Install and run
npm install
npm start
# → open http://localhost:3000
```

The panel works **even without a bot token** — you can configure everything first, then add the token. On first boot, if `ADMIN_PASSWORD` is set, an `owner` account (`ADMIN_USER`, default `admin`) is seeded and the panel requires login.

**Run the tests** (optional but nice):
```bash
npm test          # node:test suite
npm audit         # dependency vulnerability check
```

---

## 5. Connect the bot to Telegram

1. In **@BotFather** → your bot → **Bot Settings → Business Mode → Enable**.
2. In **Telegram → Settings → Telegram Business → Chatbots** → add your bot.
3. DM your bot `/id` to get your numeric user id; put it in `OWNER_USER_ID` so owner commands and alerts work.

Incoming DMs to your account are now answered as you. To pause instantly, DM `/pause` or flip **auto-reply** off in the panel topbar.

---

## 6. The admin panel — tab by tab

| Tab | What it does |
|-----|--------------|
| **Dashboard** | Live stats, message/cost charts, per-provider usage, provider health, top contacts, per-assistant breakdown, 14-day volume trend |
| **Chat** | ChatGPT-style playground (any model/persona, markdown, temperature, tokens, export) + **Behavior inspector** and **Dry run** — nothing is sent to Telegram |
| **System Prompt** | Persona editor, **40 preloaded characters**, snippets, presets, version history with diff + one-click rollback, custom context blocks, quick test |
| **Model Gateway** | Primary provider/model, fallback chain, load balancing, **live model catalog** browser (pricing/context/vision badges), per-provider tests |
| **Memory** | Global facts KB, vector memories, notes, export/import |
| **Library** | Skills (install/create/learn), starter catalog, **GitHub one-click install**, **MCP servers** |
| **Contacts** | Per-contact tone/rules/VIP/voice, tags, relationship learning, @username→id resolver, CSV import/export |
| **Tools** | 110 built-in + MCP tools with test buttons, send-now composer, **auto-responders**, **broadcast**, scheduled/recurring messages, automation |
| **Logs** | Messages / errors / events / token usage — searchable, CSV export |
| **Assistants** | Create/start/stop multiple bots, each with its own token, persona and isolated brain |
| **Monitoring** | Real-time CPU/memory/disk, health diagnostics, one-click auto-fix, **sender mood mix**, restart |
| **Security** | Admin accounts & roles, **2FA**, **device/session management**, IP bans, login attempts, audit log |
| **Settings** | ~100 wired options across 12+ sections (below) |

Topbar: quick-toggles (auto-reply / away / typing), **⌘K command palette**, light/dark theme switch.

---

## 7. Customization A–Z (every setting)

Everything below is editable live in **Settings** (and most from Telegram via `/set`). Values persist in SQLite and take effect immediately.

**General**
- `system_prompt` — the master instruction that defines your voice.
- `timezone` — used for time formatting, quiet/business hours, time-of-day awareness.
- `language` — `auto` (mirror the sender) or a fixed language.
- `max_response_length` — hard cap on reply length (characters).
- `persona_name` — how the bot refers to itself/you.
- `welcome_message` — sent to brand-new contacts (empty = off).

**Generation & style**
- `temperature` (0–2), `top_p` — sampling controls.
- `reply_style` — `concise` / `balanced` / `detailed`.
- `emoji_usage` — `none` / `light` / `natural` / `heavy`.
- `writing_style` — free-text extra style notes.
- `double_text` + `max_bursts` — multi-message "texting" behavior.

**Human behavior** *(see [§8](#8-human-behavior-engine))*
- `humanize`, `human_imperfections` (`off`/`subtle`/`natural`), `human_filler_ban`, `mood_adaptation`, `time_awareness`.

**Typing simulation**
- `typing_simulation` — on/off. `typing_speed` — `slow`/`medium`/`fast`.

**Reply policy**
- `auto_reply_default` — auto-reply new contacts?
- `reply_probability` — % of messages that get a reply.
- `quiet_hours_start` / `quiet_hours_end` — silent window (no reply at all).
- `business_hours_only` + `business_hours_start`/`end` + `after_hours_message`.
- `blacklist_words` — never reply if the message contains one.
- `min_message_length`, `ignore_forwarded`, `reply_to_photos` / `reply_to_voice` / `reply_to_stickers`.
- `cooldown_seconds`, `max_daily_replies_per_contact`, `first_reply_delay_seconds`.
- `repeat_guard` — never send an identical reply twice in a row.

**Away & offline**
- `away_mode`, `away_message`, `away_schedule_start`/`end`, `offline_message`, `bot_enabled` (master switch).

**Content controls**
- `strip_markdown`, `max_links_per_reply`, `redact_phone_numbers`, `profanity_filter`, `signature_name`, `footer_enabled` + `message_footer`.

**Memory tuning**
- `history_limit`, `vector_memory`, `memory_isolation`, `auto_extract_facts`, `auto_summarize_threshold`, `recall_count`, `similarity_threshold`, `data_retention_days`, `auto_archive_days`.

**Telegram behavior**
- `reply_in_groups`, `group_mention_only`, `agent_name`, `auto_read`.

**Injected live context**
- `inject_weather_city`, `inject_news`, `inject_calendar` — refreshed every 10 min into the prompt.

**Alerts & ops**
- `notify_new_contact`, `notify_errors`, `rate_limit_alerts`, `cost_alert_threshold`, `daily_summary` + `daily_summary_time`, `health_checks`, `webhook_alert_url` (Slack/Discord/generic), `log_full_content`.

**Skills**
- `skills_enabled`, `self_skill_learning`.

**Sessions & panel security** *(see [§16](#16-security--sessions))*
- `session_ttl_hours`, `session_remember_days`, `session_idle_timeout_min`, `session_single`, `session_bind_ip`.

**Infrastructure**
- `llm_timeout_s`, `tool_max_output`, `stream_feed`, `dashboard_refresh_s`.

---

## 8. Human-behavior engine

Makes replies read like a real person texting, not an assistant. Every layer is a toggle in **Settings → Generation → Human behavior**, and the prompt side and code side are kept **in lockstep** so what's promised is what's delivered.

- **Text like a human** (`humanize`) — prompt directives: contractions, varied sentence length, casual punctuation, and a hard rule to never mention being an AI/bot/model.
- **Output imperfections** (`human_imperfections`) — `subtle`/`natural` roughening applied *after* generation: occasionally drops a trailing period, lowercases a short casual line, relaxes spaced ellipses. Never touches links, questions, or exclamations.
- **Ban assistant filler** (`human_filler_ban`) — strips tell-tale phrases ("I hope this helps", "as an AI", "let me know if you need anything else").
- **Mood adaptation** (`mood_adaptation`) — reads the sender's mood — **upset / sad / anxious / grateful / confused / excited** — and injects a matching tone hint (acknowledge frustration, be gentle, receive thanks warmly, clarify when they're lost, match excitement).
- **Time-of-day awareness** (`time_awareness`) — reply energy fits the sender's local hour: low-key late at night, fresh in the morning, relaxed in the evening.

**Test it before it goes live** — the **Chat** tab has:
- **Behavior inspector** — type any message and see which signals fire (mood, time period, active directives). No model call.
- **Dry run** — assembles and shows the *exact* system prompt that would be sent, plus the offline verdict (auto-responder/skill match, reply-policy block, would-reply). No model call.

And the **Monitoring** tab shows a **sender mood mix** — the emotional breakdown of recent incoming messages, using the same detector, so you can confirm it's seeing what you'd expect.

---

## 9. Preloaded characters

**System Prompt → Preloaded characters.** One click applies a complete persona (prompt + emoji policy + reply style + temperature); your current prompt is auto-saved as a version first. 40 are built in:

Professional · Bestie · Charmer · Minimalist · Executive Assistant · Support Hero · Closer · Zen · Gen-Z · Diplomat · Coach · Butler · Comedian · Engineer · Listener · Hype · Stoic · Storyteller · Negotiator · Mentor · Concierge · Scientist · Chef · Detective · Poet · Trainer · Peacemaker · Hacker · Grandparent.

Edit any of them freely afterward.

---

## 10. Model gateway & providers

13 providers, normalized across the OpenAI / Gemini / Anthropic / Cohere API shapes:

**Free tier:** Gemini · Groq · Mistral · Cohere · OpenRouter · DeepSeek · Ollama · LM Studio
**Paid:** OpenAI · Anthropic · Together · Perplexity · xAI Grok

- **Primary** handles normal traffic (`primary_provider` / `primary_model`).
- **Fallback chain** kicks in on error/rate-limit, in order (`fallback_chain`).
- **Load balancing** round-robins across healthy providers (`load_balancing`).
- **Live model catalog** — browse the current real model list from any configured provider, with pricing/context/vision badges, and select with one click.

Add keys two ways: in `.env`, or **Settings → API keys** (stored in the DB, override env, effective instantly, shown masked).

---

## 11. Skills, tools & MCP

- **Skills** — instruction packs injected into the prompt. Keyword triggers make them contextual; no triggers = always on.
  - *Catalog* — ready-made packs, one-click install.
  - *GitHub* — search repositories and install; the README is distilled into a skill by the LLM.
  - *Self-learning* — the bot studies its own conversations and proposes new skills (arrive disabled for your review; enable the nightly job in Settings → Skills).
- **Tools** — 110 built-ins: web search (Tavily/Brave/SerpAPI/Perplexity/SearXNG/DuckDuckGo), webpage reader (SSRF-guarded), weather, crypto, currency, translation, image generation, QR, URL shortener, calculators, unit/number/base converters, hashing, text analysis, and integrations (Calendar, Gmail, GitHub, Notion, Spotify, YouTube, Twitter/X, news). Auto-invoked when a message needs live data.
- **MCP servers** — Library → MCP. Paste any HTTP MCP endpoint (+ optional auth headers), click **Connect**; its tools are discovered and become `mcp:server:tool`, callable by the bot.

---

## 12. Memory

- **Conversation history** — recent turns passed to the model (`history_limit`), auto-summarized past a threshold.
- **Vector memory** — messages embedded (Gemini) and recalled by cosine similarity, with a keyword fallback (`vector_memory`, `recall_count`, `similarity_threshold`).
- **Facts KB** — a global knowledge base injected into every prompt; facts can be auto-extracted from conversations (`auto_extract_facts`).
- **Isolation** — memories are per-chat when `memory_isolation` is on; facts are always global.
- **Retention** — `data_retention_days` prunes old rows; `auto_archive_days` summarizes and clears inactive chats.

Export/import everything from the **Memory** tab.

---

## 13. Contacts

Every DM partner gets a profile you can tune in **Contacts**:
- tone, relationship, gender (pronouns), custom rules, blocked topics
- VIP **priority** (faster, always-on replies), **auto-reply** toggle, **delay multiplier**, per-contact **max length**
- a **custom prompt** that overrides the global one for that person
- **voice replies** (TTS), free-text **notes**, and **tags** for segmentation
- **relationship learning** — the bot can learn how you actually talk to someone from real transcripts and mirror it

Utilities: **@username → chat_id resolver**, and **CSV import/export**.

---

## 14. Multiple assistants (multi-tenant)

Run several bots from one install (**Assistants** tab). Each assistant has:
- its own **bot token**, **owner id**, **persona/system prompt**, and settings overlay
- a **fully isolated brain** — conversations, memories, facts and contacts are scoped per assistant (composite keys), so nothing bleeds between them

Start/stop each one independently; the manager runs multiple grammY bots side by side.

---

## 15. Configure & command from Telegram

**Owner commands** (DM the bot): `/status`, `/away`, `/pause`, `/summary`, `/id`, `/help`.

**Owner configuration** (whitelisted, owner-only):
- `/set <key> <value>` and `/get <key>` — read/write settings live.
- `/persona <text>` — replace the system prompt.
- `/model <provider> <model>` — switch the primary model.
- `/character <id>` — apply a preloaded character.
- `/skills` — list/toggle skills.
- `/settings` — view current configuration.

---

## 16. Security & sessions

- **Accounts & roles** — owner (full), admin (all but delete accounts), viewer (read-only). Passwords are scrypt-hashed with per-user salt.
- **2FA (TOTP)** — RFC 6238, scan the QR with any authenticator app; logins then require the 6-digit code.
- **Sessions** — HttpOnly, DB-backed cookies with configurable lifetimes:
  - `session_ttl_hours` (normal) and `session_remember_days` ("remember me" checkbox at login).
  - `session_idle_timeout_min` — auto-expire idle sessions.
  - `session_single` — a new login ends your other sessions.
  - `session_bind_ip` — a cookie only works from the IP it was created on.
  - **My devices & sessions** (Security tab) lists every device (parsed Browser · OS, location, last-active) with **Revoke** and **Sign out everywhere else**. Revoked/expired rows are pruned hourly.
- **Brute-force lockout** — 6 failed logins per IP in 15 min → temporary block.
- **IP bans** — one-click from a failed attempt or manual; banned IPs are refused everywhere and their sessions killed. Country flags via keyless geo-IP.
- **Hardening** — strict CSP (`script-src 'self'`), security headers, per-IP sliding-window rate limiting (independent buckets for API vs login), SSRF-guarded URL fetches, spoof-resistant client-IP (`TRUST_PROXY` gates `X-Forwarded-For`), full **audit log**.

Set `COOKIE_SECURE=1` behind HTTPS and `TRUST_PROXY=1` only when actually behind a reverse proxy.

---

## 17. Monitoring & self-healing

**Monitoring** shows live CPU load, system memory, disk, DB size, process/host uptime, and a health-diagnostics panel. Each failing check has a **Fix** button; **Auto-fix all** runs them together (reset provider health, clear old errors, requeue overdue scheduled messages, clear expired sessions, VACUUM the DB).

Config-sanity checks run alongside infra ones: **Away mode** warns (with one-click *Turn off*) when replies are silently paused; **Mood detection** warns when adaptation is on but a healthy sample shows 0% emotional signal. A **sender mood mix** bar chart shows the emotional breakdown of recent messages.

**Restart** exits cleanly so your process manager (PM2/Docker/systemd) respawns.

---

## 18. Automation & scheduling

- **Away mode** — manual or scheduled window; sends `away_message` once per 4h per contact.
- **Auto-responders** — keyword → instant canned reply (contains / exact / starts-with / regex), short-circuits the LLM.
- **Scheduled & recurring messages** — one-off or `daily`/`weekly`.
- **Broadcast** — send to contacts by tag.
- **Daily summary** — a stats digest at `daily_summary_time`.
- **Alerts** — new-contact, error, cost-threshold, rate-limit, and crash alerts, delivered to the owner and/or a `webhook_alert_url` (Slack/Discord/generic).

---

## 19. Backup & restore

**Settings → Data.** Download a JSON backup of all tables. The default excludes secrets (API keys, bot tokens, MCP auth); use **Full backup (with secrets)** only for a trusted, private location. Restore re-imports every table.

---

## 20. Environment variables

**Required**
```
TELEGRAM_BOT_TOKEN   Bot token from @BotFather
GEMINI_API_KEY       Free at aistudio.google.com (default provider)
OWNER_USER_ID        Your numeric Telegram id (DM the bot /id)
OWNER_TIMEZONE       e.g. Asia/Singapore
PORT                 Web panel port (default 3000)
```

**Panel security**
```
ADMIN_PASSWORD       Locks the panel (seeds an owner account on first boot)
ADMIN_USER           Owner username (default admin)
TRUST_PROXY          =1 only behind a reverse proxy (trusts X-Forwarded-For)
COOKIE_SECURE        =1 when serving over HTTPS
```

**Optional LLM providers** — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, `DEEPSEEK_API_KEY`, `PERPLEXITY_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `COHERE_API_KEY`, `OLLAMA_URL`, `LMSTUDIO_URL`.

**Optional tools** — `SEARXNG_URL`, `SERPAPI_KEY`, `BRAVE_SEARCH_KEY`, `TAVILY_API_KEY`, `WEATHER_API_KEY`, `ELEVENLABS_API_KEY`, `NEWSAPI_KEY`, `DEEPL_API_KEY`, `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`.

**Optional integrations** — `GITHUB_TOKEN`, `NOTION_TOKEN`, `YOUTUBE_API_KEY`, `TWITTER_BEARER_TOKEN`, `SPOTIFY_CLIENT_ID/SECRET/REFRESH_TOKEN`.

> Every key can also be set live from **Settings → API keys** (stored in the DB, overrides env). Only `TELEGRAM_BOT_TOKEN` + `GEMINI_API_KEY` are needed to start.

---

## 21. Deployment

**Docker**
```bash
docker compose up -d --build
```

**PM2**
```bash
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

**VPS (bare)**
```bash
git clone https://github.com/Sisx001/MonyChaa.git && cd MonyChaa
cp .env.example .env && nano .env
npm ci --omit=dev
npm i -g pm2 && pm2 start ecosystem.config.js && pm2 save
```

Put it behind **nginx/caddy with HTTPS** for production, then set `TRUST_PROXY=1` and `COOKIE_SECURE=1`. Data (SQLite DB, logs) persists in `./data/`. Health check at `GET /health`. Graceful shutdown on SIGINT/SIGTERM.

---

## 22. Architecture

```
src/
├── index.js            # entry: bot + web server + scheduler
├── config.js           # env + DB-backed settings (~100 options)
├── assistants.js       # multi-bot manager (isolated brains)
├── characters.js       # 40 preloaded personas
├── skills.js           # 26-skill catalog, GitHub install, self-learning
├── autoresponders.js   # keyword → instant reply
├── analytics.js        # stats, cost aggregation, mood breakdown
├── system.js           # metrics, health diagnostics, auto-fix, restart
├── scheduler.js        # cron: scheduled msgs, summaries, retention, session prune
├── bot/
│   ├── handlers.js     # grammY Business Mode handlers, per-assistant factory
│   ├── reply.js        # reply pipeline: context → prompt → LLM → post-process
│   ├── human.js        # typing delays, bursts, humanizer
│   ├── mood.js         # sender-mood detection
│   ├── timeofday.js    # time-of-day energy hints
│   └── telegramSettings.js  # owner-only /set /persona /model …
├── llm/                # provider registry, gateway, fallback, live model catalog
├── memory/             # conversation history, vector memory, facts KB
├── tools/              # 110 tools, SSRF guard, MCP client
├── web/
│   ├── server.js       # Express, security headers, rate limiting
│   ├── routes.js       # REST API (100+ endpoints)
│   ├── auth.js         # accounts, sessions, RBAC, lockout, bans
│   ├── totp.js         # RFC 6238 2FA
│   ├── geoip.js        # keyless country lookup + flags
│   └── public/         # vanilla-JS SPA (index.html, app.js, style.css)
└── db/schema.js        # SQLite schema + additive migrations
```

---

## 23. Troubleshooting & FAQ

**The bot doesn't reply to my DMs.** Confirm Business Mode is enabled in @BotFather *and* the bot is added under Telegram Business → Chatbots. Check `bot_enabled` is on and auto-reply isn't paused (`/status`).

**"No provider configured."** Set at least one LLM key in `.env` or Settings → API keys. Gemini is free.

**Panel asks for a login I never set.** `ADMIN_PASSWORD` seeded an owner account on first boot. Log in with `ADMIN_USER` / `ADMIN_PASSWORD`. To reset, remove the account row or set a new password via the DB.

**IP bans / rate limits behave oddly behind a proxy.** Set `TRUST_PROXY=1` so the real client IP is read from `X-Forwarded-For`. Leave it unset when the port is exposed directly (prevents spoofing).

**Replies look too "AI".** Turn on the Human-behavior toggles (§8) and use the Dry run to see the assembled prompt.

**Disk filling up.** Set `data_retention_days` and run **Auto-fix all → VACUUM** in Monitoring.

---

## 24. Tech stack

Node.js (CommonJS) · Express 4 · better-sqlite3 (WAL) · grammY (Telegram Business) · node-cron · Winston · Chart.js (vendored) · vanilla-JS SPA (no build step) · `node:test`.

**More docs:** [DOCS.md](DOCS.md) is a companion A–Z guide. Contributions and issues welcome.
