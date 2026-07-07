'use strict';
// Tool registry. Provider-agnostic tool use: a cheap pre-pass asks the LLM
// whether a tool is needed; the result is injected into the final prompt.
// Tools with photo:true can also attach an image to the outgoing reply.
// Tools with llm:false are admin-panel only (never auto-invoked by the bot).
const config = require('../config');
const logger = require('../logger');
const { webSearch } = require('./search');
const { getWeather } = require('./weather');
const calendar = require('./calendar');
const integrations = require('./integrations');

async function getJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const TOOLS = {
  web_search: {
    description: 'Search the web for current information, news, facts you do not know',
    args: '{ "query": "search terms" }',
    enabled: () => config.getSetting('auto_search') === 'on',
    run: async ({ query }) => {
      const { backend, results } = await webSearch(query);
      if (!results.length) return 'No search results found.';
      return `Search results (${backend}):\n` + results.map(r => `- ${r.title}: ${r.snippet} (${r.url})`).join('\n');
    },
  },
  read_url: {
    description: 'Read the text content of a specific webpage URL',
    args: '{ "url": "https://..." }',
    enabled: () => config.getSetting('auto_search') === 'on',
    run: async ({ url }) => {
      if (!/^https?:\/\//i.test(String(url))) throw new Error('invalid URL');
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; secretary-pro/1.0)' },
        signal: AbortSignal.timeout(15000), redirect: 'follow',
      });
      const html = await res.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ').trim();
      return text.slice(0, 4000) || 'Page had no readable text.';
    },
  },
  weather: {
    description: 'Get current weather for a city',
    args: '{ "location": "city name" }',
    enabled: () => true,
    run: async ({ location }) => getWeather(location || 'Singapore'),
  },
  crypto_price: {
    description: 'Get current cryptocurrency price in USD',
    args: '{ "coin": "bitcoin|ethereum|solana|..." }',
    enabled: () => true,
    run: async ({ coin }) => {
      const id = String(coin || 'bitcoin').toLowerCase();
      const j = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true`);
      const data = j[id];
      if (!data) return `Unknown coin: ${coin}`;
      return `${id}: $${data.usd} (24h: ${data.usd_24h_change?.toFixed(2)}%)`;
    },
  },
  currency_convert: {
    description: 'Convert an amount between currencies',
    args: '{ "amount": 100, "from": "USD", "to": "EUR" }',
    enabled: () => true,
    run: async ({ amount, from, to }) => {
      const j = await getJson(`https://api.frankfurter.app/latest?amount=${Number(amount) || 1}&from=${from}&to=${to}`);
      const rate = j.rates?.[String(to).toUpperCase()];
      if (rate === undefined) return `Cannot convert ${from} to ${to}`;
      return `${amount} ${from} = ${rate} ${to}`;
    },
  },
  translate: {
    description: 'Translate text to another language',
    args: '{ "text": "...", "target": "en|es|fr|..." }',
    enabled: () => true,
    run: async ({ text, target }) => {
      const deeplKey = config.key('DEEPL_API_KEY');
      if (deeplKey) {
        const res = await fetch('https://api-free.deepl.com/v2/translate', {
          method: 'POST',
          headers: { 'Authorization': `DeepL-Auth-Key ${deeplKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: [text], target_lang: String(target).toUpperCase() }),
          signal: AbortSignal.timeout(12000),
        });
        if (res.ok) {
          const j = await res.json();
          return j.translations?.[0]?.text || text;
        }
      }
      // Keyless fallback via Google Translate public endpoint.
      const j = await getJson(
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`
      );
      return (j[0] || []).map(seg => seg[0]).join('');
    },
  },
  calendar: {
    description: "Check the owner's Google Calendar schedule and free slots",
    args: '{ "days": 3 }',
    enabled: () => calendar.available(),
    run: async ({ days }) => {
      const events = await calendar.upcomingEvents(Number(days) || 3);
      if (!events.length) return 'Calendar is clear.';
      return 'Upcoming events:\n' + events.map(e => `- ${e.summary}: ${e.start} → ${e.end}`).join('\n');
    },
  },
  news: {
    description: 'Get top news headlines',
    args: '{ "topic": "optional topic" }',
    enabled: () => Boolean(config.key('NEWSAPI_KEY')),
    run: async ({ topic }) => {
      const key = config.key('NEWSAPI_KEY');
      const url = topic
        ? `https://newsapi.org/v2/everything?q=${encodeURIComponent(topic)}&pageSize=5&sortBy=publishedAt&apiKey=${key}`
        : `https://newsapi.org/v2/top-headlines?language=en&pageSize=5&apiKey=${key}`;
      const j = await getJson(url);
      return (j.articles || []).map(a => `- ${a.title} (${a.source?.name})`).join('\n') || 'No news found.';
    },
  },
  image_gen: {
    description: 'Generate an image from a text description and send it in the chat',
    args: '{ "prompt": "description of the image" }',
    enabled: () => true,
    photo: true,
    run: async ({ prompt }) => {
      const p = String(prompt || '').slice(0, 800);
      const openaiKey = config.key('OPENAI_API_KEY');
      if (openaiKey) {
        try {
          const j = await getJson('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'dall-e-3', prompt: p, n: 1, size: '1024x1024' }),
          });
          const url = j.data?.[0]?.url;
          if (url) return { text: `Generated an image for: "${p}"`, photoUrl: url };
        } catch (err) {
          logger.warn(`DALL-E failed, falling back to Pollinations: ${err.message}`);
        }
      }
      // Keyless fallback: Pollinations generates on-the-fly from the URL itself.
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=1024&height=1024&nologo=true`;
      return { text: `Generated an image for: "${p}"`, photoUrl: url };
    },
  },
  qr_code: {
    description: 'Generate a QR code image for a URL or text and send it in the chat',
    args: '{ "data": "https://... or any text" }',
    enabled: () => true,
    photo: true,
    run: async ({ data }) => {
      const url = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(String(data).slice(0, 900))}`;
      return { text: `QR code for: ${data}`, photoUrl: url };
    },
  },
  url_shorten: {
    description: 'Shorten a long URL',
    args: '{ "url": "https://..." }',
    enabled: () => true,
    run: async ({ url }) => {
      const res = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(10000),
      });
      const short = (await res.text()).trim();
      if (!res.ok || !short.startsWith('http')) throw new Error('shortener failed: ' + short.slice(0, 100));
      return `Short URL: ${short}`;
    },
  },
  youtube_search: {
    description: 'Search YouTube for videos',
    args: '{ "query": "search terms" }',
    enabled: () => Boolean(config.key('YOUTUBE_API_KEY')),
    run: ({ query }) => integrations.youtubeSearch(query),
  },
  gmail_unread: {
    description: "Check the owner's unread Gmail messages",
    args: '{ "limit": 5 }',
    enabled: () => calendar.available(),
    run: ({ limit }) => integrations.gmailUnread(Number(limit) || 5),
  },
  gmail_send: {
    description: 'Send an email from the owner Gmail account (admin panel only)',
    args: '{ "to": "a@b.com", "subject": "...", "body": "..." }',
    enabled: () => calendar.available(),
    llm: false, // sending email is owner-initiated only, never bot-decided
    run: ({ to, subject, body }) => integrations.gmailSend(to, subject || '', body || ''),
  },
  github_notifications: {
    description: "Check the owner's GitHub notifications (repos, issues, PRs)",
    args: '{}',
    enabled: () => Boolean(config.key('GITHUB_TOKEN')),
    run: () => integrations.githubNotifications(),
  },
  notion_search: {
    description: "Search the owner's Notion pages and databases",
    args: '{ "query": "search terms" }',
    enabled: () => Boolean(config.key('NOTION_TOKEN')),
    run: ({ query }) => integrations.notionSearch(query || ''),
  },
  spotify_now_playing: {
    description: 'What the owner is currently listening to on Spotify',
    args: '{}',
    enabled: () => Boolean(config.key('SPOTIFY_CLIENT_ID') && config.key('SPOTIFY_CLIENT_SECRET') && config.key('SPOTIFY_REFRESH_TOKEN')),
    run: () => integrations.spotifyNowPlaying(),
  },
  twitter_search: {
    description: 'Search recent tweets on Twitter/X',
    args: '{ "query": "search terms" }',
    enabled: () => Boolean(config.key('TWITTER_BEARER_TOKEN')),
    run: ({ query }) => integrations.twitterSearch(query || ''),
  },
};

function enabledTools() {
  const builtin = Object.entries(TOOLS)
    .filter(([, t]) => t.enabled() && t.llm !== false)
    .map(([name, t]) => ({ name, description: t.description, args: t.args }));
  // Tools from connected MCP servers, qualified as mcp:<server>:<tool>.
  let mcpTools = [];
  try {
    mcpTools = require('../mcp').allTools()
      .map(t => ({ name: t.qualified, description: t.description, args: t.args }));
  } catch (err) {
    logger.debug(`MCP tools unavailable: ${err.message}`);
  }
  return [...builtin, ...mcpTools].slice(0, 40); // keep the pre-pass prompt bounded
}

/** Normalize a tool result to { context, photoUrl } shape. */
function normalizeResult(name, output) {
  const cap = Number(config.getSetting('tool_max_output')) || 3000;
  if (output && typeof output === 'object') {
    return {
      context: `[Tool ${name} result]\n${String(output.text || '').slice(0, cap)}`,
      photoUrl: output.photoUrl || null,
    };
  }
  return { context: `[Tool ${name} result]\n${String(output).slice(0, cap)}`, photoUrl: null };
}

/**
 * Ask a cheap LLM pass whether the incoming message needs a tool.
 * Returns { context, photoUrl } or null.
 */
async function maybeRunTool(userMessage) {
  const tools = enabledTools();
  if (!tools.length) return null;
  const { chat } = require('../llm/fallback');
  try {
    const decision = await chat([
      {
        role: 'system',
        content: 'You decide if answering the message requires a live data tool. Available tools:\n' +
          tools.map(t => `- ${t.name}: ${t.description}. Args: ${t.args}`).join('\n') +
          '\nReply ONLY with JSON: {"tool": "name", "args": {...}} or {"tool": null}. ' +
          'Use a tool ONLY for current/live data (news, prices, weather, schedule, facts after your training) ' +
          'or when the sender explicitly asks for something a tool provides (an image, a QR code, a translation). ' +
          'Casual chat never needs tools.',
      },
      { role: 'user', content: userMessage.slice(0, 1500) },
    ], { maxTokens: 150, temperature: 0 });
    const parsed = JSON.parse(decision.text.replace(/```json|```/g, '').trim());
    if (!parsed || !parsed.tool) return null;
    if (parsed.tool.startsWith('mcp:')) {
      logger.info(`MCP tool invoked: ${parsed.tool} ${JSON.stringify(parsed.args || {})}`);
      const output = await require('../mcp').callQualified(parsed.tool, parsed.args || {});
      return normalizeResult(parsed.tool, output);
    }
    const tool = TOOLS[parsed.tool];
    if (!tool || !tool.enabled() || tool.llm === false) return null;
    logger.info(`Tool invoked: ${parsed.tool} ${JSON.stringify(parsed.args || {})}`);
    const output = await tool.run(parsed.args || {});
    return normalizeResult(parsed.tool, output);
  } catch (err) {
    logger.debug(`Tool pre-pass skipped: ${err.message}`);
    return null;
  }
}

module.exports = { TOOLS, enabledTools, maybeRunTool, normalizeResult };
