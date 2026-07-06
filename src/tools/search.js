'use strict';
// Web search with multiple backends, tried in order of what's configured.
const { env } = require('../config');
const logger = require('../logger');

async function getJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searxng(query) {
  const base = env.SEARXNG_URL.replace(/\/$/, '');
  const json = await getJson(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
    headers: { 'User-Agent': 'secretary-pro/1.0' },
  });
  return (json.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: r.content || '' }));
}

async function duckduckgo(query) {
  const json = await getJson(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
  const results = [];
  if (json.AbstractText) results.push({ title: json.Heading, url: json.AbstractURL, snippet: json.AbstractText });
  for (const t of (json.RelatedTopics || []).slice(0, 4)) {
    if (t.Text) results.push({ title: t.Text.slice(0, 80), url: t.FirstURL || '', snippet: t.Text });
  }
  return results;
}

async function brave(query) {
  const json = await getJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
    headers: { 'X-Subscription-Token': env.BRAVE_SEARCH_KEY, 'Accept': 'application/json' },
  });
  return (json.web?.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: r.description || '' }));
}

async function tavily(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, max_results: 5 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content || '' }));
}

async function serpapi(query) {
  const json = await getJson(`https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${env.SERPAPI_KEY}`);
  return (json.organic_results || []).slice(0, 5).map(r => ({ title: r.title, url: r.link, snippet: r.snippet || '' }));
}

const BACKENDS = [
  { name: 'tavily', fn: tavily, enabled: () => Boolean(env.TAVILY_API_KEY) },
  { name: 'brave', fn: brave, enabled: () => Boolean(env.BRAVE_SEARCH_KEY) },
  { name: 'serpapi', fn: serpapi, enabled: () => Boolean(env.SERPAPI_KEY) },
  { name: 'searxng', fn: searxng, enabled: () => Boolean(env.SEARXNG_URL) },
  { name: 'duckduckgo', fn: duckduckgo, enabled: () => true },
];

/** Search the web. Tries configured backends in order until one returns results. */
async function webSearch(query) {
  for (const backend of BACKENDS) {
    if (!backend.enabled()) continue;
    try {
      const results = await backend.fn(query);
      if (results.length) return { backend: backend.name, results };
    } catch (err) {
      logger.warn(`search backend ${backend.name} failed: ${err.message}`);
    }
  }
  return { backend: null, results: [] };
}

module.exports = { webSearch, BACKENDS };
