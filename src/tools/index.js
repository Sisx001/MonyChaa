'use strict';
// Tool registry. Provider-agnostic tool use: a cheap pre-pass asks the LLM
// whether a tool is needed; the result is injected into the final prompt.
const { env } = require('../config');
const config = require('../config');
const logger = require('../logger');
const { webSearch } = require('./search');
const { getWeather } = require('./weather');
const calendar = require('./calendar');

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
      if (env.DEEPL_API_KEY) {
        const res = await fetch('https://api-free.deepl.com/v2/translate', {
          method: 'POST',
          headers: { 'Authorization': `DeepL-Auth-Key ${env.DEEPL_API_KEY}`, 'Content-Type': 'application/json' },
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
    enabled: () => Boolean(env.NEWSAPI_KEY),
    run: async ({ topic }) => {
      const url = topic
        ? `https://newsapi.org/v2/everything?q=${encodeURIComponent(topic)}&pageSize=5&sortBy=publishedAt&apiKey=${env.NEWSAPI_KEY}`
        : `https://newsapi.org/v2/top-headlines?language=en&pageSize=5&apiKey=${env.NEWSAPI_KEY}`;
      const j = await getJson(url);
      return (j.articles || []).map(a => `- ${a.title} (${a.source?.name})`).join('\n') || 'No news found.';
    },
  },
};

function enabledTools() {
  return Object.entries(TOOLS).filter(([, t]) => t.enabled()).map(([name, t]) => ({ name, description: t.description, args: t.args }));
}

/**
 * Ask a cheap LLM pass whether the incoming message needs a tool.
 * Returns tool output string or null.
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
          'Use a tool ONLY for current/live data (news, prices, weather, schedule, facts after your training). Casual chat never needs tools.',
      },
      { role: 'user', content: userMessage.slice(0, 1500) },
    ], { maxTokens: 150, temperature: 0 });
    const parsed = JSON.parse(decision.text.replace(/```json|```/g, '').trim());
    if (!parsed || !parsed.tool || !TOOLS[parsed.tool] || !TOOLS[parsed.tool].enabled()) return null;
    logger.info(`Tool invoked: ${parsed.tool} ${JSON.stringify(parsed.args || {})}`);
    const output = await TOOLS[parsed.tool].run(parsed.args || {});
    return `[Tool ${parsed.tool} result]\n${String(output).slice(0, 3000)}`;
  } catch (err) {
    logger.debug(`Tool pre-pass skipped: ${err.message}`);
    return null;
  }
}

module.exports = { TOOLS, enabledTools, maybeRunTool };
