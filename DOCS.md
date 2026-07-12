# Secretary Pro — Complete Guide

An A–Z manual for running, configuring, securing and extending your Telegram AI Secretary.

---

## 1. What it is

Secretary Pro connects to your **personal** Telegram account through **Business Mode** (no userbot, no API_HASH — just a bot token) and auto-replies to your DMs as you, using a multi-provider LLM gateway. A dark, glassy web admin panel controls everything.

Two processes, one command:
- **Bot** — grammY, Telegram Business handlers
- **Web panel** — Express + SQLite at `http://localhost:3000`

---

## 2. Quickstart

```bash
cp .env.example .env
#   TELEGRAM_BOT_TOKEN  – from @BotFather
#   GEMINI_API_KEY      – free at aistudio.google.com
#   OWNER_USER_ID       – your numeric Telegram id (send /id to the bot)
#   ADMIN_PASSWORD      – locks the web panel (highly recommended)
npm install && npm start
# open http://localhost:3000
```

Then connect the bot to your account:
1. **@BotFather → your bot → Bot Settings → Business Mode → Enable**
2. **Telegram → Settings → Telegram Business → Chatbots → add your bot**

Incoming DMs are now answered as you.

---

## 3. Panel tour

| Tab | What it does |
|-----|--------------|
| **Dashboard** | Live stats, message/cost charts, per-provider usage, provider health, top contacts |
| **Chat** | ChatGPT-style playground — test any model/persona with markdown, temperature, token controls. Nothing is sent to Telegram |
| **System Prompt** | Persona editor, **preloaded characters**, presets, versioning + diff + rollback, custom context blocks, quick test |
| **Model Gateway** | Primary provider/model, fallback chain, load balancing, live provider tests |
| **Memory** | Global facts KB, vector memories, export/import |
| **Library** | Skills (install/create/learn), starter catalog, **GitHub one-click install**, **MCP servers** |
| **Contacts** | Per-contact tone/rules/VIP/voice, relationship learning, @username→id resolver |
| **Tools** | Built-in + MCP tools with test buttons, send-now composer, scheduled messages, automation |
| **Logs** | Messages / errors / events / token usage, searchable, CSV export |
| **Monitoring** | Real-time CPU/memory/disk, health diagnostics, one-click auto-fix, restart |
| **Security** | Admin accounts, roles, sessions, IP bans, login attempts, audit log |
| **Settings** | ~70 wired options across 11 sections |

---

## 4. Characters & personas

**System Prompt → Preloaded characters.** One click applies a complete persona (prompt + emoji policy + reply style + temperature). Your current prompt is auto-saved as a version first. Twelve are built in: Professional, Bestie, Charmer, Minimalist, Executive Assistant, Support Hero, Closer, Zen, Gen-Z, Diplomat, Coach, Butler. Edit freely afterward.

---

## 5. Models & the gateway

13 providers, normalized across OpenAI/Gemini/Anthropic/Cohere API shapes:
Gemini, Groq, Mistral, Cohere, OpenRouter, DeepSeek, Ollama, LM Studio (free tier)
· OpenAI, Anthropic, Together, Perplexity, xAI Grok (paid).

- **Primary** handles normal traffic.
- **Fallback chain** kicks in on error/rate-limit, in order.
- **Load balancing** round-robins across healthy providers.
- **Generation**: temperature, top-p, reply style, emoji policy, max length — all in Settings → Generation.

Add keys two ways: `.env`, or **Settings → API keys** (stored in DB, override env, take effect instantly, shown masked).

---

## 6. Skills, tools, MCP

- **Skills** — instruction packs injected into the prompt. Keyword triggers make them contextual; no triggers = always on.
  - *Catalog*: 6 ready-made, one-click.
  - *GitHub*: search repos, install — the README is distilled into a skill by the LLM.
  - *Self-learning*: the bot studies its own conversations and proposes new skills (arrive disabled for review; enable daily in Settings → Skills).
- **Tools** — web search (Tavily/Brave/SerpAPI/Perplexity/SearXNG/DuckDuckGo), webpage reader, weather, crypto, currency, translation, image gen, QR, URL shortener, calendar, Gmail, GitHub, Notion, Spotify, YouTube, Twitter, news. Auto-invoked when a message needs live data.
- **MCP servers** — Library → MCP. Paste any HTTP MCP endpoint (+ optional auth headers), click Connect; its tools are discovered and become `mcp:server:tool`, callable by the bot.

---

## 7. Telegram behavior (Settings)

- **Agent name** — the bot answers to this name in group chats.
- **Reply in groups** / **mention-only** — participate in groups, optionally only when @mentioned or replied-to.
- **Offline message** — one-time notice sent when auto-reply is off.
- **Reply policy** — probability %, quiet hours (silent), blacklist words, ignore forwarded, per-media toggles (photo/voice/sticker), minimum length.
- **Per contact** — tone, rules, blocked topics, VIP priority, custom prompt, voice replies, delay multiplier.
- **Human behavior** (Settings → Generation → Human behavior) — makes replies read like a person texting, not an assistant. Two layers kept in lockstep:
  - **Text like a human (prompt)** — appends directives telling the model to use contractions, vary sentence length, keep punctuation casual, and never mention being an AI.
  - **Output imperfections (code)** — `subtle`/`natural` roughening applied after generation: occasionally drops a trailing period or lowercases a short casual line, relaxes spaced ellipses. Never touches links, questions, or exclamations.
  - **Ban assistant filler** — strips tell-tale phrases ("I hope this helps", "as an AI", "let me know if you need anything else") at the prompt level.
  - **Mood adaptation** — reads the sender's apparent mood from their message (upset / sad / anxious / excited) and injects a matching tone hint so the reply meets them where they are — acknowledging frustration, being gentle when they're down, or matching their excitement.
  - **Time-of-day awareness** — adapts reply energy to the sender's local time (from your timezone): low-key late at night, a little fresh in the morning, relaxed in the evening.
  - **Behavior inspector** (Chat tab) — type any sample message and see exactly which human-layer signals fire (detected mood, local time period, and the active directives) with no model call. Use it to tune the settings above before they go live.
  - **Dry run** (Chat tab) — the "Dry run" button assembles and shows the exact system prompt that would be sent for a message (with mood, time, skills and contact profile baked in), plus the offline verdict: whether an auto-responder or skill triggers, whether the reply policy would block it, and whether it would reach the LLM at all. Still no model call — it's the fastest way to see *why* the bot would respond the way it does.

Owner commands (DM the bot): `/status`, `/away`, `/pause`, `/summary`, `/id`, `/help`.

---

## 8. Security

- **Accounts** — Security → Add user. Roles: **owner** (full), **admin** (all but delete accounts), **viewer** (read-only). Passwords are scrypt-hashed with per-user salt.
- **Bootstrap** — first boot seeds one `owner` account from `ADMIN_USER` (default `admin`) + `ADMIN_PASSWORD`. With no accounts and no password, the panel is open (localhost dev only).
- **Sessions** — HttpOnly, DB-backed cookies. Lifetimes are configurable in **Settings → Sessions & panel security**:
  - **Session lifetime** — hours a normal login stays valid (default 24).
  - **"Remember me"** — tick the box at login to extend the session to the remember lifetime (default 30 days).
  - **Idle timeout** — auto-expire a session untouched for N minutes (0 = off).
  - **One session per user** — a new login revokes that user's other sessions.
  - **Bind session to origin IP** — a session cookie is only accepted from the IP it was created on, so a stolen cookie is useless elsewhere.
  Every device is listed under **Security → My devices & sessions** with its parsed browser/OS label, location, and last-active time. Revoke any one, or **Sign out everywhere else** in one click. Revoked/expired rows are pruned hourly. Set `COOKIE_SECURE=1` behind HTTPS.
- **Two-factor auth (TOTP)** — Security → Two-factor authentication. Scan the QR with any authenticator app (Google Authenticator, Authy, 1Password), confirm a code, and logins then require the 6-digit code. Disable requires your password. RFC 6238, ±1 step skew tolerance.
- **Brute-force lockout** — 6 failed logins per IP in 15 min → temporary block.
- **IP bans** — ban any IP (one click from a failed attempt, or manually). Banned IPs are refused everywhere and their sessions killed.
- **Audit log** — every login, user change, ban, restart, character apply, autofix is recorded with IP.
- Put it behind a reverse proxy with HTTPS for production. Set `TRUST_PROXY=1` **only** when actually behind a proxy — this makes the app read the client IP from `X-Forwarded-For` (needed for correct IP bans/rate limits). Leaving it unset (the default) uses the socket address, so a directly-exposed instance can't be tricked by a spoofed header. Also set `COOKIE_SECURE=1` behind HTTPS.

---

## 9. Monitoring & self-healing

**Monitoring tab** shows live CPU load, system memory, disk, DB size, process/host uptime, and a health-diagnostics panel. Each failing check has a **Fix** button; **Auto-fix all** runs them together. Actions: reset provider health, clear old errors, requeue overdue scheduled messages, clear expired sessions, VACUUM the database. **Restart** exits cleanly so your process manager (PM2/Docker/systemd) respawns.

---

## 10. Deployment

**Docker**
```bash
docker compose up -d --build
```
**PM2**
```bash
npm i -g pm2 && pm2 start ecosystem.config.js
```
Data (SQLite, logs) persists in `./data/`. Health check at `GET /health`. Graceful shutdown on SIGINT/SIGTERM. Crash/rate-limit/cost alerts go to your Telegram.

### VPS in 5 lines
```bash
git clone <repo> && cd secretary-pro
cp .env.example .env && nano .env      # set the 4 required vars + ADMIN_PASSWORD
npm i -g pm2 && npm install
pm2 start ecosystem.config.js && pm2 save && pm2 startup
# reverse-proxy :3000 behind nginx + certbot for HTTPS, set COOKIE_SECURE=1
```

---

## 11. Environment variables

Required: `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `OWNER_USER_ID`.
Recommended: `ADMIN_PASSWORD` (+ `ADMIN_USER`), `OWNER_TIMEZONE`, `COOKIE_SECURE=1` behind HTTPS.
Optional: every provider/tool key (also settable in-panel). See `.env.example`.

---

## 12. Multiple assistants (multi-tenancy)

**Assistants tab.** Run several bots side by side, each fully isolated:
- its own **bot token** (from @BotFather) and **owner** Telegram id
- its own **system prompt / persona**
- a **separate brain** — conversations, memories, message logs and extracted
  facts are all scoped by `assistant_id`, so assistants never see each other's
  history

The **primary** bot (assistant id 0) uses the `.env` token. Add more from the
panel: paste a token, set the owner and prompt, and it starts polling
immediately. Start/stop each independently; delete with an option to purge or
keep its brain. Each panel account can own its assistants (`admin_user_id`).

Currently shared across assistants: global settings (temperature, tools,
skills) and the contacts table. Per-assistant setting overlays are the next
increment; the data layer already carries `assistant_id` on every relevant
table to support it.

## 13. Live model catalog

**Model Gateway → Browse models.** Fetches the current, real model list from
the selected provider (OpenRouter, OpenAI, Groq, Mistral, Together, DeepSeek,
xAI, Gemini, Anthropic, Ollama…), with context length, pricing, and free/vision
badges. Filter, click **Use**, then Save routing. Falls back to the curated
static list when a provider has no live endpoint or key. Cached 10 minutes.

## 14. Configure from Telegram

DM the bot (owner only):
- `/settings` — show current values
- `/set <key> <value>` — change a whitelisted setting (temperature, reply_style,
  emoji_usage, typing_speed, language, agent_name, away_mode, bot_enabled,
  reply_probability, max_response_length, footers, group toggles…)
- `/get <key>` — read one
- `/persona <text>` — replace the system prompt (previous saved as a version)
- `/model <provider> <model>` — switch the primary model
- `/character <id>` — apply a preloaded persona
- `/skills` — list skills
- `/status`, `/pause`, `/away`, `/summary`, `/id`, `/help`
```
