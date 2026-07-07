'use strict';
// Live model catalog — fetches the real, current model list from providers
// that expose one (OpenRouter-style unified browsing). Cached 10 minutes.
const { PROVIDERS, apiKey } = require('./providers');

const cache = new Map(); // provider → { at, models }
const TTL = 10 * 60 * 1000;

// How to list models per provider. Most OpenAI-compatible providers expose GET /models.
const LISTERS = {
  openrouter: async () => {
    const j = await get('https://openrouter.ai/api/v1/models');
    return (j.data || []).map(m => ({
      id: m.id, name: m.name || m.id,
      context: m.context_length,
      promptCost: num(m.pricing?.prompt) * 1e6, completionCost: num(m.pricing?.completion) * 1e6,
      free: /:free$/.test(m.id), vision: (m.architecture?.modality || '').includes('image'),
    }));
  },
  openai: p => openaiList(p),
  groq: p => openaiList(p),
  mistral: p => openaiList(p),
  together: p => openaiList(p),
  deepseek: p => openaiList(p),
  xai: p => openaiList(p),
  perplexity: () => staticList('perplexity'),
  gemini: async () => {
    const key = apiKey('gemini');
    const j = await get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    return (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName || m.name, context: m.inputTokenLimit, vision: true }));
  },
  anthropic: async () => {
    const key = apiKey('anthropic');
    const j = await get('https://api.anthropic.com/v1/models', { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
    return (j.data || []).map(m => ({ id: m.id, name: m.display_name || m.id, vision: true }));
  },
  cohere: () => staticList('cohere'),
  ollama: async () => {
    const base = (PROVIDERS.ollama.baseUrl || '').replace('/v1', '');
    const j = await get(`${base}/api/tags`);
    return (j.models || []).map(m => ({ id: m.name, name: m.name }));
  },
  lmstudio: p => openaiList(p),
};

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function get(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function openaiList(providerId) {
  const p = PROVIDERS[providerId];
  const key = apiKey(providerId);
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const j = await get(`${p.baseUrl}/models`, headers);
  const rows = j.data || j.models || [];
  return rows.map(m => ({ id: m.id || m.name, name: m.id || m.name, context: m.context_window || m.context_length }));
}

// Fallback to the curated static list baked into providers.js.
function staticList(providerId) {
  const p = PROVIDERS[providerId];
  return Object.entries(p.models).map(([id, meta]) => ({
    id, name: id, promptCost: meta.cost?.[0], completionCost: meta.cost?.[1], vision: Boolean(meta.vision),
  }));
}

/** List models for a provider (live if possible, else the static catalog). */
async function listModels(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`Unknown provider: ${providerId}`);
  const cached = cache.get(providerId);
  if (cached && Date.now() - cached.at < TTL) return cached.models;

  let models;
  try {
    const lister = LISTERS[providerId];
    models = lister ? await lister(providerId) : staticList(providerId);
    if (!models || !models.length) models = staticList(providerId);
  } catch (err) {
    models = staticList(providerId).map(m => ({ ...m, note: `live list unavailable (${err.message})` }));
  }
  // De-dup + sort: free first, then alphabetical.
  const seen = new Set();
  models = models.filter(m => m.id && !seen.has(m.id) && seen.add(m.id))
    .sort((a, b) => (Number(b.free || 0) - Number(a.free || 0)) || String(a.id).localeCompare(String(b.id)));
  cache.set(providerId, { at: Date.now(), models });
  return models;
}

/** Aggregate configured providers into one catalog (OpenRouter-style browse-all). */
async function listAll() {
  const { isConfigured } = require('./providers');
  const ids = Object.keys(PROVIDERS).filter(isConfigured);
  const out = [];
  await Promise.all(ids.map(async id => {
    try {
      const models = await listModels(id);
      for (const m of models) out.push({ ...m, provider: id });
    } catch { /* skip a failing provider */ }
  }));
  out.sort((a, b) => (Number(b.free || 0) - Number(a.free || 0)) || String(a.provider).localeCompare(b.provider) || String(a.id).localeCompare(String(b.id)));
  return out;
}

module.exports = { listModels, listAll };
